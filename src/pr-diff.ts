/**
 * PR diff view: the files a pull request changes, read in ZuGit instead of the
 * browser. Diff state sits on the row background, syntax colour on the text,
 * so the two never compete. The user comments on lines they pick — a click on
 * a line number, or a drag across several — and AI review comments an agent
 * handed over through the MCP server show as cards under their lines, for the
 * user to keep (they become theirs) or discard.
 */

import { invoke } from "@tauri-apps/api/core";
import type { PullRequestSummary } from "./shared/pr-model";
import { openExternal } from "./api";
import { SVG, errorMessage, escHtml, formatDiffNum } from "./utils";
import {
  alignSides, hunkFor, hunkSides, isGeneratedFile, languageFor, layerOrder, parsePatch, pathTree, sameCode, splitRows,
  treeOrder, withAgentOrder, type DiffHunk, type DiffLang, type DiffLine, type FileGroup, type PathTree,
} from "./pr-diff-parse";
import type { Token } from "./pr-diff-highlight";
import {
  READ_ONLY_HINT, addUserComment, deleteUserComment, discardAiReview, getAiReviews, getCommentPositions,
  deleteReply, getUserComments, keepAiComment, publishReview, refreshAiReviewBadges, replyNow, reviewPrompt,
  saveReply, setAiCommentStatus, setReviewSummary, updateUserComment, type AiReview, type CommentChange,
  type CommentPosition, type PublishResult, type ReviewEvent, type UserComment, type UserReply, type UserReview,
} from "./ai-review";
import {
  anchorKey, cardKey, draftKey, fileKey, renderCard, renderDraft, renderGhPanel, renderGhThread, renderPanel,
  renderPendingReply, renderPublishButtons, renderPublishOpen, renderPublishPanel, renderReplyEditor,
  type CardRef, type Draft, type PublishState, type ReplyArea, type Side, type ThreadItem,
} from "./pr-diff-ai";
import { getPrHead, getPrThreads, resolveThread, threadsSignature, type GhThread } from "./pr-threads";
import { state as appState } from "./state";

interface PrFileDiff {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  blobUrl: string;
}

interface PrDiff {
  files: PrFileDiff[];
  truncated: boolean;
  /** The commit these files are the diff of: comments on them are anchored to it. */
  headSha: string;
}

interface FileView {
  file: PrFileDiff;
  hunks: DiffHunk[];
  /** Every line of every hunk, in order: `data-li` indexes into it. */
  lines: DiffLine[];
  lang: DiffLang | null;
  /** Why the file starts collapsed; empty when it starts open. */
  collapsedReason: string;
  collapsed: boolean;
  /** Bumped on every body render, so a late highlight never lands on a stale body. */
  renderGen: number;
  rendered: boolean;
}

type OrderMode = "suggested" | "path";
type ViewMode = "unified" | "split";
type AiRef = Extract<CardRef, { kind: "ai" }>;
type UserRef = Extract<CardRef, { kind: "user" }>;
type ItemHtml = (item: ThreadItem) => string;

/** Past this many diff lines a file waits for a click, like GitHub's "Load diff". */
const LARGE_FILE_LINES = 1500;
/** Row heights from the CSS, for the placeholders of files not drawn yet. */
const LINE_PX = 20;
const HUNK_PX = 28;
/** How often an open diff looks for a proposal an agent just handed over. */
const AI_POLL_MS = 10_000;
/** GitHub's conversations are fetched again when ZuGit regains focus, at most this often. */
const THREADS_REFRESH_MS = 60_000;
/** How often an open diff asks GitHub whether the PR got new commits. */
const HEAD_POLL_MS = 120_000;
const ORDER_KEY = "zugit.prDiff.order";
const VIEW_KEY = "zugit.prDiff.view";
const TREE_KEY = "zugit.prDiff.tree";
const SIDE_KEY = "zugit.prDiff.sideWidth";
/** The file list's width (280px by default, in the CSS): dragged down to SIDE_MIN_PX, the diff keeping DIFF_MIN_PX. */
const SIDE_MIN_PX = 200;
const DIFF_MIN_PX = 360;
const UNSAVED = "Not saved yet — save it, or Cancel to drop it.";

const STATUS: Record<string, { letter: string; label: string; kind: string }> = {
  added:    { letter: "A", label: "Added",    kind: "add" },
  removed:  { letter: "D", label: "Deleted",  kind: "del" },
  renamed:  { letter: "R", label: "Renamed",  kind: "ren" },
  copied:   { letter: "C", label: "Copied",   kind: "ren" },
  modified: { letter: "M", label: "Modified", kind: "mod" },
  changed:  { letter: "M", label: "Changed",  kind: "mod" },
};

const statusOf = (s: string) => STATUS[s] ?? { letter: "·", label: s, kind: "mod" };

function toFileView(file: PrFileDiff): FileView {
  const hunks = file.patch ? parsePatch(file.patch) : [];
  const lines = hunks.flatMap(h => h.lines);
  const collapsedReason = isGeneratedFile(file.filename)
    ? "Generated file"
    : lines.length > LARGE_FILE_LINES ? `Large diff · ${lines.length.toLocaleString()} lines` : "";
  return {
    file, hunks, lines,
    lang: languageFor(file.filename),
    collapsedReason,
    collapsed: collapsedReason !== "",
    renderGen: 0,
    rendered: false,
  };
}

function readOrderMode(): OrderMode {
  try { return localStorage.getItem(ORDER_KEY) === "path" ? "path" : "suggested"; } catch { return "suggested"; }
}

function saveOrderMode(mode: OrderMode) {
  try { localStorage.setItem(ORDER_KEY, mode); } catch { /* a preference, not data */ }
}

function readViewMode(): ViewMode {
  try { return localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified"; } catch { return "unified"; }
}

function saveViewMode(mode: ViewMode) {
  try { localStorage.setItem(VIEW_KEY, mode); } catch { /* a preference, not data */ }
}

/** By path, as a folder tree rather than a flat list. */
function readTreeMode(): boolean {
  try { return localStorage.getItem(TREE_KEY) === "1"; } catch { return false; }
}

function saveTreeMode(on: boolean) {
  try { localStorage.setItem(TREE_KEY, on ? "1" : "0"); } catch { /* a preference, not data */ }
}

function readSideWidth(): number | null {
  try {
    const px = Number(localStorage.getItem(SIDE_KEY));
    return px >= SIDE_MIN_PX ? px : null;
  } catch { return null; }
}

function saveSideWidth(px: number | null) {
  try {
    if (px === null) localStorage.removeItem(SIDE_KEY); else localStorage.setItem(SIDE_KEY, String(Math.round(px)));
  } catch { /* a preference, not data */ }
}

// ── Markup ────────────────────────────────────────────────────────────────────

function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  // No trailing slash: the list truncates directories from the left (rtl),
  // which would move it to the front.
  return { dir: path.slice(0, Math.max(slash, 0)), base: path.slice(slash + 1) };
}

function renderStat(add: number, del: number): string {
  return `<span class="pd-stat"><span class="pd-stat__add">+${formatDiffNum(add)}</span><span class="pd-stat__del">−${formatDiffNum(del)}</span></span>`;
}

function renderStatus(status: string): string {
  const s = statusOf(status);
  return `<span class="pd-status pd-status--${s.kind}" title="${escHtml(s.label)}">${s.letter}</span>`;
}

/** A file of the list; in the folder tree (`depth` set) its name alone, the folders giving the rest. */
function renderFileButton(v: FileView, i: number, notes: { open: number; pending: number }, depth?: number): string {
  const { dir, base } = splitPath(v.file.filename);
  const title = notes.pending
    ? `${notes.pending} AI comment${notes.pending === 1 ? "" : "s"} to triage`
    : `${notes.open} comment${notes.open === 1 ? "" : "s"}`;
  const badge = notes.open
    ? `<span class="pd-file__ai${notes.pending ? " pd-file__ai--pending" : ""}" title="${title}">${notes.open}</span>`
    : "";
  const inTree = depth !== undefined;
  return `<button class="pd-file${inTree ? " pd-file--tree" : ""}" type="button" data-pd-file="${i}" title="${escHtml(v.file.filename)}"` +
    (inTree ? ` style="--depth:${depth}"` : "") + `>` +
    renderStatus(v.file.status) +
    `<span class="pd-file__name"><span class="pd-file__base">${escHtml(base)}</span>` +
    (inTree ? "" : `<span class="pd-file__dir">${escHtml(dir)}</span>`) + `</span>` +
    badge +
    renderStat(v.file.additions, v.file.deletions) +
    `</button>`;
}

const TREE_ICON = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 2h3.5M3 2v7.5h2.5M3 5.5h2.5"/><rect x="6.5" y="4.2" width="4" height="2.6" rx=".6"/><rect x="6.5" y="8.2" width="4" height="2.6" rx=".6"/></svg>`;
const FOLDER_ICON = `<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M1.5 3.3c0-.5.4-.9.9-.9h2.3l1.1 1.2h3.8c.5 0 .9.4.9.9v4.7c0 .5-.4.9-.9.9H2.4c-.5 0-.9-.4-.9-.9z"/></svg>`;

/** The folder tree of By path: folders fold, and a filter shows its matches whatever is folded. */
function renderTree(node: PathTree, depth: number, file: (path: string, depth: number) => string, folded: Set<string>): string {
  const dirs = node.dirs.map(dir => {
    const open = !folded.has(dir.path);
    return `<div class="pd-dir${open ? "" : " pd-dir--folded"}" data-pd-group>` +
      `<button class="pd-dir__head" type="button" data-pd-dir="${escHtml(dir.path)}" aria-expanded="${open}" title="${escHtml(dir.path)}" style="--depth:${depth}">` +
        `<span class="pd-dir__icon" aria-hidden="true">${FOLDER_ICON}</span><span class="pd-dir__name">${escHtml(dir.name)}</span>` +
      `</button>` +
      `<div class="pd-dir__files">${renderTree(dir, depth + 1, file, folded)}</div>` +
    `</div>`;
  });
  return dirs.join("") + node.files.map(path => file(path, depth)).join("");
}

function placeholderHeight(v: FileView): number {
  return v.lines.length * LINE_PX + v.hunks.length * HUNK_PX;
}

function renderSection(v: FileView, i: number): string {
  const { file } = v;
  const path = file.previousFilename && file.previousFilename !== file.filename
    ? `<span class="pd-path__old">${escHtml(file.previousFilename)}</span> → ${escHtml(file.filename)}`
    : escHtml(file.filename);
  return `<section class="pd-section${v.collapsed ? " pd-section--collapsed" : ""}" data-pd-section="${i}">` +
    `<div class="pd-section__head" data-pd-toggle="${i}" role="button" tabindex="0" aria-expanded="${!v.collapsed}">` +
      `<span class="pd-chevron" aria-hidden="true"></span>` +
      renderStatus(file.status) +
      `<span class="pd-path">${path}</span>` +
      (v.collapsedReason ? `<span class="pd-reason">${escHtml(v.collapsedReason)}</span>` : "") +
      renderStat(file.additions, file.deletions) +
      (file.blobUrl ? `<button class="pd-blob-btn" type="button" data-pd-blob="${i}" title="View the file on GitHub">${SVG.ext}</button>` : "") +
    `</div>` +
    `<div class="pd-section__body" data-pd-body="${i}" style="min-height:${v.collapsed ? 0 : placeholderHeight(v)}px"></div>` +
    `</section>`;
}

function renderSign(line: DiffLine): string {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
  return `<span class="pd-sign" aria-label="${line.kind === "add" ? "added" : line.kind === "del" ? "removed" : ""}">${sign}</span>`;
}

/** A line number. Pressing one starts a comment on that side of the line. */
function renderLn(no: number | null, side: Side): string {
  return no === null ? `<span class="pd-ln"></span>` : `<span class="pd-ln" data-ln="${side}">${no}</span>`;
}

/** What finds a row again: its hunk, and the base (`data-o`) and head (`data-n`) lines it shows. */
function rowAttrs(h: number, left: DiffLine | null, right: DiffLine | null): string {
  const o = left?.oldNo ?? null;
  const n = right?.newNo ?? null;
  return ` data-row data-h="${h}"` + (o !== null ? ` data-o="${o}"` : "") + (n !== null ? ` data-n="${n}"` : "");
}

/**
 * `data-li` is the line's index in the file's hunks: highlighting lands by
 * index, so it does not care how a view lays the lines out.
 */
function renderCode(line: DiffLine, li: number): string {
  return `<span class="pd-code" data-li="${li}">${escHtml(line.text)}</span>`;
}

function renderLine(line: DiffLine, li: number, h: number): string {
  return `<div class="pd-line pd-line--${line.kind}"${rowAttrs(h, line, line)}>` +
    renderLn(line.oldNo, "old") +
    renderLn(line.newNo, "new") +
    renderSign(line) +
    renderCode(line, li) +
    `</div>`;
}

/** One side of a split row; an empty half when the other side has no counterpart. */
function renderHalf(line: DiffLine | null, side: Side, li: Map<DiffLine, number>): string {
  if (!line) return `<span class="pd-half pd-half--empty"></span>`;
  // A context line is the same line on both sides, shown without a tint.
  return `<span class="pd-half pd-half--${line.kind}">` +
    renderLn(side === "old" ? line.oldNo : line.newNo, side) +
    renderSign(line) +
    renderCode(line, li.get(line) ?? -1) +
    `</span>`;
}

/** What hangs under a line: on its head number, base number, or both for context lines. */
function threadFor(path: string, line: DiffLine, anchors: Map<string, ThreadItem[]>, item: ItemHtml): string {
  const keys = new Set<string>();
  if (line.newNo !== null) keys.add(anchorKey(path, "new", line.newNo));
  if (line.oldNo !== null) keys.add(anchorKey(path, "old", line.oldNo));
  const items = [...keys].flatMap(key => anchors.get(key) ?? []);
  return items.length ? `<div class="pd-ai-thread" data-thread>${items.map(it => item(it)).join("")}</div>` : "";
}

/**
 * Split view: each card goes under its own side — a comment on the head
 * version must not read as one on the code it replaced, and the other way round.
 */
function splitThreadFor(
  path: string, left: DiffLine | null, right: DiffLine | null, anchors: Map<string, ThreadItem[]>, item: ItemHtml,
): string {
  const old = left && left.oldNo !== null ? anchors.get(anchorKey(path, "old", left.oldNo)) ?? [] : [];
  const head = right && right.newNo !== null ? anchors.get(anchorKey(path, "new", right.newNo)) ?? [] : [];
  if (!old.length && !head.length) return "";
  const half = (items: ThreadItem[]) => `<div class="pd-ai-half">${items.map(it => item(it)).join("")}</div>`;
  return `<div class="pd-ai-srow" data-thread>${half(old)}${half(head)}</div>`;
}

function renderBody(v: FileView, i: number, anchors: Map<string, ThreadItem[]>, view: ViewMode, item: ItemHtml): string {
  const path = v.file.filename;
  // Conversations on the whole file come first, as on GitHub.
  const whole = anchors.get(fileKey(path)) ?? [];
  const top = whole.length ? `<div class="pd-ai-thread" data-file-thread>${whole.map(it => item(it)).join("")}</div>` : "";
  if (v.hunks.length === 0) {
    const reason = v.file.status === "renamed" && v.file.additions + v.file.deletions === 0
      ? "File renamed without changes."
      : "Binary file, or a diff too large for GitHub to inline.";
    const link = v.file.blobUrl ? ` <button class="pd-link" type="button" data-pd-blob="${i}">View on GitHub</button>` : "";
    return top + `<div class="pd-empty">${reason}${link}</div>`;
  }
  const li = new Map<DiffLine, number>();
  v.lines.forEach((line, k) => li.set(line, k));
  const hunkHead = (h: DiffHunk) =>
    `<div class="pd-hunk"><span class="pd-hunk__range">@@ −${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@</span>` +
    (h.section ? `<span class="pd-hunk__section">${escHtml(h.section)}</span>` : "") + `</div>`;

  if (view === "split") {
    return top + `<div class="pd-lines pd-lines--split">` + v.hunks.map((hunk, h) =>
      hunkHead(hunk) + splitRows(hunk).map(row =>
        `<div class="pd-srow"${rowAttrs(h, row.left, row.right)}>${renderHalf(row.left, "old", li)}${renderHalf(row.right, "new", li)}</div>` +
        splitThreadFor(path, row.left, row.right, anchors, item),
      ).join(""),
    ).join("") + `</div>`;
  }
  return top + `<div class="pd-lines">` + v.hunks.map((hunk, h) =>
    hunkHead(hunk) + hunk.lines.map(l => renderLine(l, li.get(l) ?? -1, h) + threadFor(path, l, anchors, item)).join(""),
  ).join("") + `</div>`;
}

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const ITALIC = 1;
const BOLD = 2;

function renderTokens(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return escHtml(fallback);
  return tokens.map(t => {
    const style: string[] = [];
    if (t.color && COLOR_RE.test(t.color)) style.push(`color:${t.color}`);
    if (t.fontStyle && t.fontStyle & ITALIC) style.push("font-style:italic");
    if (t.fontStyle && t.fontStyle & BOLD) style.push("font-weight:600");
    return style.length ? `<span style="${style.join(";")}">${escHtml(t.content)}</span>` : escHtml(t.content);
  }).join("");
}

// ── Overlay ───────────────────────────────────────────────────────────────────

export async function openPrDiff(pr: PullRequestSummary): Promise<void> {
  document.querySelector("[data-pr-diff-overlay]")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "rd-overlay pd-overlay";
  overlay.dataset.prDiffOverlay = "";
  overlay.innerHTML = `
    <div class="rd-shell pd-shell" role="dialog" aria-modal="true" aria-label="Pull request diff">
      <div class="rd-header pd-header">
        <div class="rd-header-row1">
          <span class="rd-badge">Diff</span>
          <span class="pd-title">${escHtml(pr.title)}</span>
          <div class="rd-spacer"></div>
          <button class="pd-ai-btn" type="button" data-pd-copy-prompt
            title="Copies a review prompt for Claude Code, Codex or any agent with the ZuGit MCP. In Claude Code, /mcp__zugit__review_pr with the PR URL does the same. ${escHtml(READ_ONLY_HINT)}">Copy review prompt</button>
          <div class="rd-seg" data-pd-view>
            <button class="rd-seg-btn" type="button" data-pd-view-mode="unified">Unified</button>
            <button class="rd-seg-btn" type="button" data-pd-view-mode="split">Split</button>
          </div>
          <button class="pd-publish-open" type="button" data-pd-publish-open aria-expanded="false" aria-haspopup="dialog"
            title="Publish your comments and replies as one GitHub review">Publish review</button>
          <button class="rd-icon-btn" type="button" data-pd-github title="Open on GitHub">${SVG.ext}</button>
          <button class="rd-icon-btn rd-icon-btn--ghost" type="button" data-pd-close title="Close (Esc)">${SVG.x}</button>
        </div>
        <div class="pd-meta">
          <span class="pd-meta__repo">${escHtml(pr.repo)} #${pr.id}</span>
          <span class="rd-sep">·</span>
          <span class="pd-meta__refs">${escHtml(pr.headRef)} → ${escHtml(pr.baseRef)}</span>
          <span data-pd-summary></span>
          <span class="pd-update" data-pd-update hidden></span>
        </div>
      </div>
      <div class="pd-main">
        <aside class="pd-side">
          <input class="pd-filter" type="search" placeholder="Filter files…" data-pd-filter spellcheck="false" />
          <div class="pd-order-row">
            <div class="pd-order rd-seg" data-pd-order>
              <button class="rd-seg-btn" type="button" data-pd-order-mode="suggested" title="Foundations first: the agent's order when it gave one, by layer otherwise">Suggested</button>
              <button class="rd-seg-btn" type="button" data-pd-order-mode="path" title="GitHub's order">By path</button>
            </div>
            <button class="pd-tree-toggle" type="button" data-pd-tree aria-pressed="false" title="Group by folder" hidden>${TREE_ICON}</button>
          </div>
          <div class="pd-files" data-pd-files></div>
          <div class="pd-side__resize" data-pd-resize role="separator" aria-orientation="vertical" aria-label="Resize the file list"
            tabindex="0" title="Drag to resize · double-click to reset"></div>
        </aside>
        <div class="pd-content" data-pd-content></div>
      </div>
      <div class="pd-publish-pop" data-pd-publish-pop role="dialog" aria-label="Publish your review" hidden></div>
      <div class="rd-loading-overlay" data-pd-loading><div class="rd-spinner"></div></div>
    </div>
  `;
  document.body.append(overlay);

  const $ = <T extends HTMLElement>(sel: string): T => {
    const el = overlay.querySelector<T>(sel);
    if (!el) throw new Error(`PR diff: missing ${sel}`);
    return el;
  };
  const content = $<HTMLElement>("[data-pd-content]");
  const fileList = $<HTMLElement>("[data-pd-files]");
  const filter = $<HTMLInputElement>("[data-pd-filter]");
  let views: FileView[] = [];
  const indexByPath = new Map<string, number>();
  let observer: IntersectionObserver | null = null;
  let activeIndex = -1;
  let orderMode = readOrderMode();
  let viewMode = readViewMode();
  let treeMode = readTreeMode();
  /** Folders of the tree the reader folded, by path. */
  const folded = new Set<string>();

  // Comments: the agents' proposals, the user's own, and what is being written.
  let reviews: AiReview[] = [];
  let mine: UserReview = { repo: pr.repo, number: pr.id, comments: [], replies: [], summary: null };
  let mineNotice: string | null = null;
  /** Comments written on older commits, placed on the diff's commit as GitHub carries them. */
  let carried = new Map<string, CommentPosition>();
  /** The review's text as typed; saved shortly after the typing stops. */
  let summaryText = "";
  let summaryTimer = 0;
  let anchors = new Map<string, ThreadItem[]>();
  const drafts = new Map<string, Draft>();
  let draftSeq = 0;
  /** Card key → the text being edited. */
  const edits = new Map<string, string>();
  /** Card key → why its last save failed. */
  const errors = new Map<string, string>();
  /** Cards with a request in flight: a double click saves once. */
  const busy = new Set<string>();
  let armedDelete: string | null = null;
  let deleteTimer = 0;
  let reviewSignature = "";
  let armedDiscard: string | null = null;
  let aiPoll = 0;

  // GitHub's conversations, read-only.
  let threads: GhThread[] = [];
  let threadsNotice: string | null = null;
  let threadsSig = "";
  let threadsAt = 0;
  /** Folded conversations the user opened: a redraw keeps them open. */
  const openThreads = new Set<string>();

  /** Open reply editors under GitHub's conversations: thread id → the text typed. */
  const replyEditors = new Map<string, string>();
  // Publishing: GitHub refuses a verdict on one's own PR.
  const viewerLogin = appState.currentDashboard?.viewerLogin ?? "";
  const ownPr = !!viewerLogin && pr.author.toLowerCase() === viewerLogin.toLowerCase();
  let publishing = false;
  /** What the last publish did, as markup for the panel. */
  let publishNote = "";
  /** The publish panel under the top bar is open. */
  let publishOpen = false;

  // The commit the diff on screen is of — not the dashboard's, which may lag behind.
  let headSha = pr.headSha;
  /** A newer commit GitHub reported while the diff was open; null while up to date. */
  let newHead: string | null = null;
  let headPoll = 0;

  // ── Close & keyboard ────────────────────────────────────────────────────────

  function close() {
    observer?.disconnect();
    document.removeEventListener("keydown", onKey, true);
    stopSelecting();
    window.clearTimeout(pendingJumpTimer);
    window.clearTimeout(deleteTimer);
    window.clearInterval(aiPoll);
    window.clearInterval(headPoll);
    if (summaryTimer) void saveSummary();
    window.removeEventListener("focus", onWindowFocus);
    overlay.remove();
    void refreshAiReviewBadges();
  }

  const isMac = navigator.platform.toUpperCase().includes("MAC");

  // Capture phase: the dashboard's own shortcuts (⌘F → list search) must not
  // fire behind the overlay.
  function onKey(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === "Escape") {
      e.stopPropagation();
      // The publish panel closes first; its text saves itself.
      const inPanel = e.target instanceof Element && !!e.target.closest("[data-pd-publish-pop]");
      if (publishOpen && (inPanel || !(e.target instanceof HTMLTextAreaElement))) { togglePublish(false); return; }
      if (e.target instanceof HTMLTextAreaElement) { escapeEditor(e.target); return; }
      if (typing && filter.value) { filter.value = ""; applyFilter(); return; }
      if (!showUnsaved()) close();
      return;
    }
    // In the review's text ⌘↵ only saves, as it does in every other editor:
    // publishing is the buttons' job, never a key pressed out of habit.
    if (mod && e.key === "Enter" && e.target instanceof HTMLTextAreaElement && e.target.matches("[data-pd-review-text]")) {
      e.preventDefault(); e.stopPropagation();
      if (summaryTimer) void saveSummary();
      return;
    }
    if (mod && e.key === "Enter" && e.target instanceof HTMLTextAreaElement) {
      e.preventDefault(); e.stopPropagation();
      const key = e.target.closest<HTMLElement>("[data-pd-card]")?.dataset.pdCard;
      if (key) void save(key);
      return;
    }
    if (mod && e.key === "f") {
      e.preventDefault(); e.stopPropagation();
      filter.focus(); filter.select();
      return;
    }
    if (typing || mod || e.altKey) return;
    if (e.key === "j" || e.key === "k") {
      e.stopPropagation();
      jumpBy(e.key === "j" ? 1 : -1);
    }
  }
  document.addEventListener("keydown", onKey, true);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) { if (!showUnsaved()) close(); return; }
    const target = e.target as Element;
    if (target.closest("[data-pd-publish-open]")) { togglePublish(!publishOpen); return; }
    if (publishOpen && !target.closest("[data-pd-publish-pop]")) togglePublish(false);
    if (target.closest("[data-pd-close]")) { close(); return; }
    if (target.closest("[data-pd-github]")) { void openExternal(`${pr.url}/files`); return; }
    if (target.closest("[data-pd-reload]")) { void reload(); return; }

    const copy = target.closest<HTMLButtonElement>("[data-pd-copy-prompt]");
    if (copy) { void copyPrompt(copy); return; }

    // Links in comments open in the browser (open_external takes http(s) only).
    const link = target.closest<HTMLElement>("[data-pd-link]");
    if (link) {
      e.preventDefault();
      const url = link.dataset.pdLink;
      if (url) void openExternal(url);
      return;
    }

    const replyOpen = target.closest<HTMLElement>("[data-pd-reply]");
    if (replyOpen) { openReply(replyOpen.dataset.pdReply ?? ""); return; }

    const resolve = target.closest<HTMLElement>("[data-pd-resolve]");
    if (resolve) { void toggleResolved(resolve.dataset.pdResolve ?? ""); return; }

    const verdict = target.closest<HTMLElement>("[data-pd-publish]");
    if (verdict) { void onPublish(verdict); return; }

    const cardAction = target.closest<HTMLElement>("[data-pd-action]");
    if (cardAction) { e.stopPropagation(); void onCardAction(cardAction); return; }

    const discard = target.closest<HTMLElement>("[data-pd-ai-discard]");
    if (discard) { void onDiscardReview(discard.dataset.pdAiDiscard ?? ""); return; }

    if (target.closest("[data-pd-tree]")) { setTreeMode(!treeMode); return; }

    const dir = target.closest<HTMLElement>("[data-pd-dir]");
    if (dir) { toggleDir(dir); return; }

    const view = target.closest<HTMLElement>("[data-pd-view-mode]");
    if (view) { setViewMode(view.dataset.pdViewMode === "split" ? "split" : "unified"); return; }

    const mode = target.closest<HTMLElement>("[data-pd-order-mode]");
    if (mode) { setOrderMode(mode.dataset.pdOrderMode === "path" ? "path" : "suggested"); return; }

    const blob = target.closest<HTMLElement>("[data-pd-blob]");
    if (blob) {
      e.stopPropagation();
      const url = views[Number(blob.dataset.pdBlob)]?.file.blobUrl;
      if (url) void openExternal(url);
      return;
    }
    const fileBtn = target.closest<HTMLElement>("[data-pd-file]");
    if (fileBtn) { scrollToFile(Number(fileBtn.dataset.pdFile)); return; }

    const toggle = target.closest<HTMLElement>("[data-pd-toggle]");
    if (toggle) toggleFile(Number(toggle.dataset.pdToggle));
  });

  overlay.addEventListener("keydown", (e) => {
    const toggle = (e.target as Element).closest<HTMLElement>("[data-pd-toggle]");
    if (toggle && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      toggleFile(Number(toggle.dataset.pdToggle));
    }
  });

  // `toggle` does not bubble: caught on the way down.
  overlay.addEventListener("toggle", (e) => {
    const fold = e.target;
    if (!(fold instanceof HTMLDetailsElement) || !fold.dataset.pdGh) return;
    if (fold.open) openThreads.add(fold.dataset.pdGh); else openThreads.delete(fold.dataset.pdGh);
  }, true);

  // What the user types lives in state, so a redraw never loses it.
  overlay.addEventListener("input", (e) => {
    const area = e.target;
    if (area instanceof HTMLTextAreaElement && area.matches("[data-pd-review-text]")) {
      summaryText = area.value;
      window.clearTimeout(summaryTimer);
      summaryTimer = window.setTimeout(() => void saveSummary(), 600);
      syncPublishButtons();
      return;
    }
    if (!(area instanceof HTMLTextAreaElement) || !area.hasAttribute("data-pd-edit")) return;
    const key = area.closest<HTMLElement>("[data-pd-card]")?.dataset.pdCard;
    if (!key) return;
    if (key.startsWith("reply:")) { replyEditors.set(key.slice("reply:".length), area.value); return; }
    const draft = draftFor(key);
    if (draft) draft.text = area.value; else edits.set(key, area.value);
  });

  filter.addEventListener("input", applyFilter);

  // ── File list width ─────────────────────────────────────────────────────────

  const main = $<HTMLElement>(".pd-main");
  const side = $<HTMLElement>(".pd-side");
  const resizer = $<HTMLElement>("[data-pd-resize]");

  /** Sets the list's width within its bounds, or back to the default; returns what was set. */
  function setSideWidth(px: number | null): number | null {
    if (px === null) { main.style.removeProperty("--pd-side-w"); return null; }
    const width = Math.round(Math.min(Math.max(SIDE_MIN_PX, main.clientWidth - DIFF_MIN_PX), Math.max(SIDE_MIN_PX, px)));
    main.style.setProperty("--pd-side-w", `${width}px`);
    return width;
  }
  setSideWidth(readSideWidth());

  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side.getBoundingClientRect().width;
    let width: number | null = startWidth;
    // The drag goes on past the handle's few pixels.
    try { resizer.setPointerCapture(e.pointerId); } catch { /* a pointer already gone */ }
    overlay.classList.add("pd-resizing");
    const move = (ev: PointerEvent) => { width = setSideWidth(startWidth + ev.clientX - startX); };
    const end = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      overlay.classList.remove("pd-resizing");
      saveSideWidth(width);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  });
  resizer.addEventListener("dblclick", () => saveSideWidth(setSideWidth(null)));
  resizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowRight" ? 16 : -16;
    saveSideWidth(setSideWidth(side.getBoundingClientRect().width + step));
  });

  // ── Navigation ──────────────────────────────────────────────────────────────

  function sectionEl(i: number) {
    return content.querySelector<HTMLElement>(`[data-pd-section="${i}"]`);
  }

  function bodyEl(i: number) {
    return content.querySelector<HTMLElement>(`[data-pd-body="${i}"]`);
  }

  function setActive(i: number) {
    if (i === activeIndex) return;
    fileList.querySelector(".pd-file--active")?.classList.remove("pd-file--active");
    const btn = fileList.querySelector<HTMLElement>(`[data-pd-file="${i}"]`);
    btn?.classList.add("pd-file--active");
    btn?.scrollIntoView({ block: "nearest" });
    activeIndex = i;
  }

  // Bodies drawn on the way in rarely match their placeholder to the pixel
  // (a horizontal scrollbar, for one), so a jump re-aligns once they land.
  let pendingJump: number | null = null;
  let pendingJumpTimer = 0;

  function alignTo(i: number) {
    const el = sectionEl(i);
    if (el) content.scrollTop = el.offsetTop - content.offsetTop;
  }

  function scrollToFile(i: number) {
    if (!sectionEl(i)) return;
    pendingJump = i;
    window.clearTimeout(pendingJumpTimer);
    pendingJumpTimer = window.setTimeout(() => { pendingJump = null; }, 400);
    alignTo(i);
    setActive(i);
  }

  function visibleIndexes(): number[] {
    return [...fileList.querySelectorAll<HTMLElement>("[data-pd-file]:not([hidden])")]
      .map(el => Number(el.dataset.pdFile));
  }

  function jumpBy(step: number) {
    const order = visibleIndexes();
    if (order.length === 0) return;
    const at = order.indexOf(activeIndex);
    const next = at === -1 ? order[0] : order[Math.min(order.length - 1, Math.max(0, at + step))];
    scrollToFile(next);
  }

  // The reader scrolling on their own wins over a jump still settling.
  content.addEventListener("wheel", () => { pendingJump = null; }, { passive: true });

  // The active file is the last one whose header has reached the top.
  let scrollFrame = 0;
  content.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      const top = content.scrollTop + content.offsetTop + 4;
      let current = -1;
      for (const el of content.querySelectorAll<HTMLElement>("[data-pd-section]:not([hidden])")) {
        if (current !== -1 && el.offsetTop > top) break;
        current = Number(el.dataset.pdSection);
      }
      if (current !== -1) setActive(current);
    });
  });

  function applyFilter() {
    const q = filter.value.trim().toLowerCase();
    // Matches show inside folded folders too.
    fileList.classList.toggle("pd-files--filtering", q !== "");
    views.forEach((v, i) => {
      const hide = q !== "" && !v.file.filename.toLowerCase().includes(q);
      const btn = fileList.querySelector<HTMLElement>(`[data-pd-file="${i}"]`);
      const sec = sectionEl(i);
      if (btn) btn.hidden = hide;
      if (sec) sec.hidden = hide;
    });
    // A group heading goes with its last visible file.
    fileList.querySelectorAll<HTMLElement>("[data-pd-group]").forEach(group => {
      group.hidden = !group.querySelector("[data-pd-file]:not([hidden])");
    });
  }

  // ── Order ───────────────────────────────────────────────────────────────────

  /** By path in a tree: the diff follows the tree, so list and files read in the same order. */
  const asTree = () => orderMode === "path" && treeMode;

  function groups(): FileGroup[] {
    const paths = views.map(v => v.file.filename);
    if (orderMode === "path") return [{ title: "", why: "", files: asTree() ? treeOrder(pathTree(paths)) : paths }];
    const agent = reviews.find(r => r.order.length > 0);
    return agent ? withAgentOrder(agent.order, paths) : layerOrder(paths);
  }

  function setTreeMode(on: boolean) {
    treeMode = on;
    saveTreeMode(on);
    layout();
  }

  /** Folds a folder of the tree, or unfolds it: only the list changes, the diff stays. */
  function toggleDir(head: HTMLElement) {
    const path = head.dataset.pdDir ?? "";
    const unfold = folded.has(path);
    if (unfold) folded.delete(path); else folded.add(path);
    head.setAttribute("aria-expanded", String(unfold));
    head.parentElement?.classList.toggle("pd-dir--folded", !unfold);
  }

  function setViewMode(mode: ViewMode) {
    if (mode === viewMode) return;
    viewMode = mode;
    saveViewMode(mode);
    layout();
  }

  function setOrderMode(mode: OrderMode) {
    if (mode === orderMode) return;
    orderMode = mode;
    saveOrderMode(mode);
    layout();
  }

  // ── Line selection ──────────────────────────────────────────────────────────

  /**
   * A press on a line number starts it, dragging over more lines of the same
   * hunk stretches it, letting go opens the editor. The side is the one the
   * press was on: base for removed lines, head for the rest.
   */
  interface Selection { file: number; side: Side; hunk: string; from: number; to: number }
  let selecting: Selection | null = null;

  const sideAttr = (side: Side) => (side === "new" ? "n" : "o");

  content.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const cell = e.target.closest<HTMLElement>("[data-ln]");
    const row = cell?.closest<HTMLElement>("[data-row]");
    const body = row?.closest<HTMLElement>("[data-pd-body]");
    if (!cell || !row || !body) return;
    const side: Side = cell.dataset.ln === "old" ? "old" : "new";
    const no = Number(row.dataset[sideAttr(side)]);
    if (!no) return;
    // No text selection, and the focus stays where it is until the editor opens.
    e.preventDefault();
    selecting = { file: Number(body.dataset.pdBody), side, hunk: row.dataset.h ?? "", from: no, to: no };
    overlay.classList.add("pd-selecting");
    paintSelections(selecting.file);
    document.addEventListener("mousemove", onSelectMove);
    document.addEventListener("mouseup", onSelectEnd);
  });

  function onSelectMove(e: MouseEvent) {
    const s = selecting;
    if (!s || !(e.target instanceof Element)) return;
    const row = e.target.closest<HTMLElement>("[data-row]");
    if (!row || row.dataset.h !== s.hunk) return;
    if (row.closest<HTMLElement>("[data-pd-body]")?.dataset.pdBody !== String(s.file)) return;
    const no = Number(row.dataset[sideAttr(s.side)]);
    if (!no || no === s.to) return;
    s.to = no;
    paintSelections(s.file);
  }

  function stopSelecting() {
    document.removeEventListener("mousemove", onSelectMove);
    document.removeEventListener("mouseup", onSelectEnd);
    overlay.classList.remove("pd-selecting");
  }

  function onSelectEnd() {
    stopSelecting();
    const s = selecting;
    selecting = null;
    const v = s ? views[s.file] : undefined;
    if (!s || !v) return;
    openDraft(v.file.filename, s.side, Math.min(s.from, s.to), Math.max(s.from, s.to));
  }

  /** Tints the lines being selected and those under an open editor. */
  function paintSelections(fileIndex?: number) {
    const ranges: { file: number; side: Side; from: number; to: number }[] = [];
    if (selecting) {
      const s = selecting;
      ranges.push({ file: s.file, side: s.side, from: Math.min(s.from, s.to), to: Math.max(s.from, s.to) });
    }
    for (const d of drafts.values()) {
      const file = indexByPath.get(d.path);
      if (file !== undefined && !isLoose(d)) ranges.push({ file, side: d.side, from: d.line, to: d.endLine ?? d.line });
    }
    const bodies = fileIndex === undefined
      ? [...content.querySelectorAll<HTMLElement>("[data-pd-body]")]
      : [bodyEl(fileIndex)];
    for (const body of bodies) {
      if (!body) continue;
      body.querySelectorAll(".pd-sel").forEach(el => el.classList.remove("pd-sel"));
      const file = Number(body.dataset.pdBody);
      for (const r of ranges) {
        if (r.file !== file) continue;
        const attr = sideAttr(r.side);
        body.querySelectorAll<HTMLElement>(`[data-row][data-${attr}]`).forEach(row => {
          const no = Number(row.dataset[attr]);
          if (no < r.from || no > r.to) return;
          // Split rows tint only the half the comment is about.
          const target = row.classList.contains("pd-srow") ? row.children[r.side === "old" ? 0 : 1] : row;
          target?.classList.add("pd-sel");
        });
      }
    }
  }

  // ── Comments ────────────────────────────────────────────────────────────────

  /** True when the diff shows that line of the file on that side. */
  function shows(path: string, side: Side, line: number): boolean {
    const i = indexByPath.get(path);
    return i !== undefined && views[i].lines.some(l => (side === "new" ? l.newNo : l.oldNo) === line);
  }

  /**
   * The line a card hangs under; null puts it in the panel — no line, one this
   * diff no longer shows, or code that changed since the user commented on it.
   */
  function anchorOf(ref: CardRef): { path: string; side: Side; line: number } | null {
    const c = ref.comment;
    if (c.placement !== "inline" || !c.path || c.line === null) return null;
    if (ref.kind === "user" && ageOf(ref.comment) === "outdated") return null;
    const line = c.endLine ?? c.line;
    return shows(c.path, c.side, line) ? { path: c.path, side: c.side, line } : null;
  }

  /** Written on another commit than the one on screen. */
  function onOtherCommit(sha: string): boolean {
    return !!sha && !!headSha && !headSha.toLowerCase().startsWith(sha.toLowerCase());
  }

  function linesOf(path: string): DiffLine[] {
    const i = indexByPath.get(path);
    return i === undefined ? [] : views[i].lines;
  }

  /**
   * A user comment from an older commit stays with its code while that code is
   * unchanged, as GitHub carries it over — on other lines if lines were added
   * above; changed code makes it outdated. GitHub's compare decides; until it
   * answers, the comment's own code at the same lines does. Saved without its
   * code, nobody can tell: it stays, flagged "older commit".
   */
  function ageOf(c: UserComment): "outdated" | "unverified" | undefined {
    if (!onOtherCommit(c.headSha) || !c.path || c.line === null) return undefined;
    const known = carried.get(c.id);
    if (known) return known.state === "moved" ? undefined : known.state === "outdated" ? "outdated" : "unverified";
    if (!c.diffHunk) return "unverified";
    return sameCode(c.diffHunk, c.side, c.line, c.endLine, linesOf(c.path)) ? undefined : "outdated";
  }

  /** Asks GitHub where comments written on older commits sit now; re-lays out only if that changes. */
  async function loadPositions() {
    if (!mine.comments.some(c => c.placement === "inline" && onOtherCommit(c.headSha))) {
      carried = new Map();
      return;
    }
    let list: CommentPosition[];
    try {
      list = await getCommentPositions(pr.repo, pr.id);
    } catch {
      return; // Their own code keeps deciding.
    }
    if (!overlay.isConnected) return;
    // Worked out on the PR's latest commit: no use for an older diff still on screen.
    const next = new Map(list.filter(p => p.headSha.toLowerCase() === headSha.toLowerCase()).map(p => [p.id, p]));
    if (JSON.stringify([...next]) === JSON.stringify([...carried])) return;
    carried = next;
    indexComments();
    layout();
  }

  async function saveSummary() {
    window.clearTimeout(summaryTimer);
    summaryTimer = 0;
    try {
      const saved = await setReviewSummary(pr.repo, pr.id, summaryText);
      // Only the stored text changes: a redraw would interrupt the typing.
      mine = { ...mine, summary: saved.summary };
    } catch (err) {
      // Said where it is being typed: in the publish panel.
      publishNote = `<span class="pd-publish__error">Your summary could not be saved: ${escHtml(errorMessage(err, "unknown error"))}</span>`;
      drawPublish();
    }
  }

  /** An editor from before a reload whose lines changed: it waits in the panel. */
  function isLoose(d: Draft): boolean {
    if (!onOtherCommit(d.headSha)) return false;
    return !d.diffHunk || !sameCode(d.diffHunk, d.side, d.line, d.endLine, linesOf(d.path));
  }

  /** Every card: the agents' comments not kept (kept ones are the user's now), then the user's. */
  function allRefs(): CardRef[] {
    const refs: CardRef[] = [];
    for (const review of reviews) {
      for (const comment of review.comments) {
        if (comment.status !== "kept") refs.push({ kind: "ai", review, comment });
      }
    }
    for (const comment of mine.comments) {
      // Carried to other lines of the diff's commit: shown there, as GitHub does.
      const moved = carried.get(comment.id)?.position;
      refs.push({
        kind: "user",
        comment: moved ? { ...comment, path: moved.path, line: moved.line, endLine: moved.endLine } : comment,
      });
    }
    return refs;
  }

  function findRef(key: string): CardRef | null {
    return allRefs().find(ref => cardKey(ref) === key) ?? null;
  }

  function draftFor(key: string): Draft | undefined {
    return key.startsWith("draft:") ? drafts.get(key.slice("draft:".length)) : undefined;
  }

  /**
   * Where GitHub shows a conversation in this diff: under its line on the
   * latest diff, or above the file for one on the whole file. Null puts it in
   * the GitHub list — outdated, or on a line this diff does not show.
   */
  function ghAnchor(t: GhThread): string | null {
    if (t.outdated) return null;
    if (t.line === null && t.originalLine === null) return indexByPath.has(t.path) ? fileKey(t.path) : null;
    if (t.line === null || !shows(t.path, t.side, t.line)) return null;
    return anchorKey(t.path, t.side, t.line);
  }

  function indexComments() {
    anchors = new Map();
    const add = (key: string, item: ThreadItem) => anchors.set(key, [...(anchors.get(key) ?? []), item]);
    // GitHub's conversations come first under a line: they were there before.
    for (const thread of threads) {
      const key = ghAnchor(thread);
      if (key) add(key, { kind: "gh", thread });
    }
    for (const ref of allRefs()) {
      const at = anchorOf(ref);
      if (at) add(anchorKey(at.path, at.side, at.line), ref);
    }
    for (const draft of drafts.values()) {
      if (!isLoose(draft)) add(anchorKey(draft.path, draft.side, draft.endLine ?? draft.line), { kind: "draft", draft });
    }
  }

  function renderItem(item: ThreadItem, inPanel = false): string {
    if (item.kind === "draft") return renderDraft(item.draft, errors.get(draftKey(item.draft)) ?? null);
    if (item.kind === "gh") return renderGhThread(item.thread, openThreads.has(item.thread.id), replyArea);
    const key = cardKey(item);
    return renderCard(item, {
      showLocation: inPanel,
      editing: edits.get(key) ?? null,
      error: errors.get(key) ?? null,
      armed: armedDelete === key,
      age: item.kind === "user" ? ageOf(item.comment) : undefined,
    });
  }

  const itemHtml: ItemHtml = item => renderItem(item);

  function countsFor(path: string): { open: number; pending: number } {
    let open = 0;
    let pending = 0;
    for (const ref of allRefs()) {
      if (ref.comment.path !== path) continue;
      if (ref.kind === "user") { open++; continue; }
      if (ref.comment.status === "pending") { open++; pending++; }
    }
    for (const thread of threads) {
      if (thread.path === path && !thread.resolved && ghAnchor(thread)) open++;
    }
    return { open, pending };
  }

  /** Redraws the panel; whoever is typing in it keeps the caret. */
  function drawPanel() {
    const panel = content.querySelector<HTMLElement>("[data-pd-ai]");
    if (!panel) return;
    const html = renderPanel({
      reviews, mine, headSha, armedDiscard, notice: mineNotice,
      drafts: [...drafts.values()].filter(isLoose)
        .map(d => renderDraft(d, errors.get(draftKey(d)) ?? null, true)).join(""),
      github: renderGhPanel(threads, threads.filter(t => !ghAnchor(t)), threadsNotice, id => openThreads.has(id), replyArea),
      inPanel: ref => !anchorOf(ref),
      card: ref => renderItem(ref, true),
    });
    keepingFocus(() => { panel.innerHTML = html; });
  }

  /** Redraws what hangs under one row, from state. */
  function redrawThread(v: FileView, row: HTMLElement) {
    const lineIn = (el: Element | null | undefined) => {
      const li = Number(el?.querySelector<HTMLElement>("[data-li]")?.dataset.li ?? -1);
      return li >= 0 ? v.lines[li] ?? null : null;
    };
    const path = v.file.filename;
    let html = "";
    if (row.classList.contains("pd-srow")) {
      html = splitThreadFor(path, lineIn(row.children[0]), lineIn(row.children[1]), anchors, itemHtml);
    } else {
      const line = lineIn(row);
      if (line) html = threadFor(path, line, anchors, itemHtml);
    }
    const next = row.nextElementSibling;
    const thread = next?.hasAttribute("data-thread") ? next : null;
    if (!html) thread?.remove();
    else if (thread) thread.outerHTML = html;
    else row.insertAdjacentHTML("afterend", html);
  }

  function redrawAt(path: string, side: Side, line: number) {
    const i = indexByPath.get(path);
    if (i === undefined || !views[i].rendered) return;
    const row = bodyEl(i)?.querySelector<HTMLElement>(`[data-row][data-${sideAttr(side)}="${line}"]`);
    if (row) redrawThread(views[i], row);
  }

  /** Under its line, or in the panel. */
  function redrawRef(ref: CardRef) {
    const at = anchorOf(ref);
    if (at) redrawAt(at.path, at.side, at.line); else drawPanel();
  }

  function redrawKey(key: string) {
    const thread = threadOfKey(key);
    if (thread) { redrawGhThread(thread); return; }
    const draft = draftFor(key);
    if (draft) { redrawDraft(draft); return; }
    const ref = findRef(key);
    if (ref) redrawRef(ref);
  }

  function editorOf(key: string) {
    return overlay.querySelector<HTMLTextAreaElement>(`[data-pd-card="${CSS.escape(key)}"] textarea`);
  }

  function focusEditor(key: string) {
    const area = editorOf(key);
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  /** A redraw replaces the textarea being typed in: put the caret back. */
  function keepingFocus(update: () => void) {
    const active = document.activeElement;
    const area = active instanceof HTMLTextAreaElement && overlay.contains(active) ? active : null;
    const key = area?.closest<HTMLElement>("[data-pd-card]")?.dataset.pdCard;
    const [start, end] = area ? [area.selectionStart, area.selectionEnd] : [0, 0];
    update();
    const again = key ? editorOf(key) : null;
    if (again && again !== area) {
      again.focus();
      again.setSelectionRange(start, end);
    }
  }

  /** Card and panel counts after any change. */
  function refreshChrome() {
    drawPanel();
    drawPublish();
    for (const [path, i] of indexByPath) {
      const btn = fileList.querySelector<HTMLElement>(`[data-pd-file="${i}"]`);
      if (btn) btn.outerHTML = renderFileButton(views[i], i, countsFor(path));
    }
    fileList.querySelector<HTMLElement>(`[data-pd-file="${activeIndex}"]`)?.classList.add("pd-file--active");
    applyFilter();
  }

  function afterChange(...touched: (CardRef | null)[]) {
    indexComments();
    keepingFocus(() => {
      for (const ref of touched) if (ref) redrawRef(ref);
      refreshChrome();
    });
  }

  /** One request per card at a time; a failure shows on the card and keeps the text. */
  async function run<T>(key: string, work: () => Promise<T>, fallback: string): Promise<T | null> {
    busy.add(key);
    try {
      const result = await work();
      errors.delete(key);
      return result;
    } catch (err) {
      errors.set(key, errorMessage(err, fallback));
      return null;
    } finally {
      busy.delete(key);
    }
  }

  function applyChange(change: CommentChange) {
    mine = change.mine;
    const review = change.review;
    if (review) reviews = reviews.map(r => r.source === review.source ? review : r);
  }

  /** Typed and not saved: a draft with text, or an edit that changed the comment. */
  function isUnsaved(key: string): boolean {
    if (key.startsWith("reply:")) return (replyEditors.get(key.slice("reply:".length)) ?? "").trim() !== "";
    const reply = replyOf(key);
    if (reply) {
      const text = edits.get(key);
      return text !== undefined && text.trim() !== reply.body.trim();
    }
    const draft = draftFor(key);
    if (draft) return draft.text.trim() !== "";
    const text = edits.get(key);
    const ref = findRef(key);
    return text !== undefined && !!ref && text.trim() !== ref.comment.body.trim();
  }

  /** Points at a comment not saved yet instead of closing over it; false when there is none. */
  function showUnsaved(message = UNSAVED): boolean {
    const key = [...drafts.values()].map(draftKey)
      .concat([...edits.keys()], [...replyEditors.keys()].map(replyKey))
      .find(isUnsaved);
    if (!key) return false;
    const thread = threadOfKey(key);
    // A reply inside a folded conversation: unfold it first.
    if (thread) openThreads.add(thread);
    const path = draftFor(key)?.path ?? findRef(key)?.comment.path ?? threads.find(t => t.id === thread)?.path;
    const i = path ? indexByPath.get(path) : undefined;
    if (i !== undefined && views[i].collapsed) toggleFile(i);
    errors.set(key, message);
    redrawKey(key);
    editorOf(key)?.scrollIntoView({ block: "center" });
    focusEditor(key);
    return true;
  }

  /** Esc in an editor cancels it — unless that would throw away what was typed. */
  function escapeEditor(area: HTMLTextAreaElement) {
    const key = area.closest<HTMLElement>("[data-pd-card]")?.dataset.pdCard;
    if (!key) return;
    if (isUnsaved(key)) {
      errors.set(key, UNSAVED);
      keepingFocus(() => redrawKey(key));
      return;
    }
    cancel(key);
  }

  function cancel(key: string) {
    if (key.startsWith("reply:")) {
      const thread = key.slice("reply:".length);
      replyEditors.delete(thread);
      errors.delete(key);
      redrawGhThread(thread);
      return;
    }
    const draft = draftFor(key);
    if (draft) { closeDraft(draft); return; }
    edits.delete(key);
    errors.delete(key);
    redrawKey(key);
  }

  function openDraft(path: string, side: Side, line: number, end: number) {
    const endLine = end > line ? end : null;
    // The same lines again: back to the comment already being written there.
    let draft = [...drafts.values()].find(d =>
      d.path === path && d.side === side && d.line === line && d.endLine === endLine && !isLoose(d));
    if (!draft) {
      const v = views[indexByPath.get(path) ?? -1];
      draft = {
        id: String(++draftSeq), path, side, line, endLine, text: "",
        headSha, diffHunk: v ? hunkFor(v.hunks, side, line, endLine) : null,
      };
      drafts.set(draft.id, draft);
      indexComments();
      keepingFocus(() => redrawAt(path, side, end));
    }
    paintSelections(indexByPath.get(path));
    focusEditor(draftKey(draft));
  }

  /** Under its lines, or in the panel once a reload changed them. */
  function redrawDraft(draft: Draft) {
    if (isLoose(draft)) drawPanel();
    else redrawAt(draft.path, draft.side, draft.endLine ?? draft.line);
  }

  function closeDraft(draft: Draft) {
    drafts.delete(draft.id);
    errors.delete(draftKey(draft));
    indexComments();
    redrawDraft(draft);
    paintSelections(indexByPath.get(draft.path));
  }

  /** An AI comment's code as the diff shows it — only when the diff is on the commit the agent reviewed. */
  function aiHunk(ref: AiRef): string | null {
    const c = ref.comment;
    const v = c.path ? views[indexByPath.get(c.path) ?? -1] : undefined;
    if (!v || c.line === null || c.placement !== "inline" || onOtherCommit(ref.review.headSha)) return null;
    return hunkFor(v.hunks, c.side, c.line, c.endLine);
  }

  /** ⌘/Ctrl+Enter or the primary button of an editor. */
  async function save(key: string) {
    if (busy.has(key)) return;
    if (key.startsWith("reply:")) { await addReply(key.slice("reply:".length), key); return; }
    const reply = replyOf(key);
    if (reply) { await saveReplyEdit(reply, key); return; }
    const draft = draftFor(key);
    const text = (draft ? draft.text : edits.get(key) ?? "").trim();
    if (!text) { focusEditor(key); return; }

    if (draft) {
      // Saved on the commit its lines were picked on, even after a reload moved the diff on.
      const saved = await run(key, () => addUserComment(pr.repo, pr.id, {
        path: draft.path, side: draft.side, line: draft.line, endLine: draft.endLine,
        headSha: draft.headSha, diffHunk: draft.diffHunk, body: text,
      }), "Could not save the comment.");
      if (saved) {
        mine = saved;
        closeDraft(draft);
        refreshChrome();
      } else {
        keepingFocus(() => redrawKey(key));
      }
      return;
    }

    const ref = findRef(key);
    if (!ref) return;
    if (ref.kind === "ai") { await keep(ref, key, text); return; }
    const saved = await run(key, () => updateUserComment(pr.repo, pr.id, ref.comment.id, text), "Could not save the comment.");
    if (saved) { mine = saved; edits.delete(key); }
    afterChange(ref);
  }

  /** The AI comment becomes the user's, reworded when `body` is given. */
  async function keep(ref: AiRef, key: string, body: string | null) {
    const change = await run(key, () => keepAiComment(ref.review, ref.comment.id, body, aiHunk(ref)), "Could not keep the comment.");
    if (!change) {
      // Most likely the agent replaced its review: show what is there now.
      await loadReviews(true);
      return;
    }
    applyChange(change);
    edits.delete(key);
    afterChange(ref);
  }

  async function setStatus(ref: AiRef, key: string, status: "pending" | "discarded") {
    const updated = await run(key, () => setAiCommentStatus(ref.review, ref.comment.id, status), "Could not update the comment.");
    if (!updated) { await loadReviews(true); return; }
    reviews = reviews.map(r => r.source === updated.source ? updated : r);
    afterChange(ref);
  }

  /** Two clicks: a comment the user wrote has no Undo. */
  /** First click arms, a second within four seconds confirms: what was written has no Undo. */
  function confirmTwice(key: string, redraw: () => void): boolean {
    window.clearTimeout(deleteTimer);
    if (armedDelete === key) {
      armedDelete = null;
      return true;
    }
    const previous = armedDelete;
    armedDelete = key;
    if (previous) redrawKey(previous);
    redraw();
    deleteTimer = window.setTimeout(() => {
      const armed = armedDelete;
      armedDelete = null;
      if (armed) redrawKey(armed);
    }, 4000);
    return false;
  }

  async function remove(ref: UserRef, key: string) {
    if (!confirmTwice(key, () => redrawRef(ref))) return;
    const change = await run(key, () => deleteUserComment(pr.repo, pr.id, ref.comment.id), "Could not delete the comment.");
    if (change) { applyChange(change); edits.delete(key); }
    // A kept comment comes back where it was, as the agent's, discarded.
    afterChange(ref);
  }

  async function onCardAction(button: HTMLElement) {
    const key = button.closest<HTMLElement>("[data-pd-card]")?.dataset.pdCard;
    const action = button.dataset.pdAction;
    if (!key || !action || busy.has(key)) return;
    if (action === "save") { await save(key); return; }
    if (action === "cancel") { cancel(key); return; }
    if (action === "reply-now") {
      const thread = threadOfKey(key);
      if (thread) await sendReplyNow(thread, key);
      return;
    }
    const reply = replyOf(key);
    if (reply) {
      if (action === "edit") {
        edits.set(key, reply.body);
        errors.delete(key);
        redrawGhThread(reply.threadId);
        focusEditor(key);
      }
      if (action === "delete") await removeReply(reply, key);
      return;
    }
    const ref = findRef(key);
    if (!ref) return;
    if (action === "edit") {
      edits.set(key, ref.comment.body);
      errors.delete(key);
      redrawRef(ref);
      focusEditor(key);
      return;
    }
    if (ref.kind === "ai") {
      if (action === "keep") await keep(ref, key, null);
      if (action === "discard" || action === "pending") await setStatus(ref, key, action === "discard" ? "discarded" : "pending");
      return;
    }
    if (action === "delete") await remove(ref, key);
  }

  // ── Replies to GitHub's conversations ──────────────────────────────────────

  const replyKey = (threadId: string) => `reply:${threadId}`;

  function replyOf(key: string): UserReply | undefined {
    return key.startsWith("rp:") ? mine.replies.find(r => r.id === key.slice("rp:".length)) : undefined;
  }

  /** The conversation a key belongs to: an open editor's, or a pending reply's. */
  function threadOfKey(key: string): string | undefined {
    return key.startsWith("reply:") ? key.slice("reply:".length) : replyOf(key)?.threadId;
  }

  /** A conversation's pending replies and editor, as its thread draws them. */
  const replyArea: ReplyArea = thread => {
    const pending = mine.replies.filter(r => r.threadId === thread.id).map(reply => {
      const key = `rp:${reply.id}`;
      return renderPendingReply(reply, {
        editing: edits.get(key) ?? null,
        error: errors.get(key) ?? null,
        armed: armedDelete === key,
      });
    }).join("");
    const text = replyEditors.get(thread.id);
    const key = replyKey(thread.id);
    return {
      pending,
      editor: text === undefined ? null : renderReplyEditor(thread, text, errors.get(key) ?? null, busy.has(key)),
      resolving: busy.has(resolveKey(thread.id)),
      error: errors.get(resolveKey(thread.id)) ?? null,
    };
  };

  const resolveKey = (threadId: string) => `resolve:${threadId}`;

  /**
   * Resolve conversation, or Unresolve: at once on GitHub, as there. A resolved
   * conversation folds, as GitHub folds it.
   */
  async function toggleResolved(threadId: string) {
    const thread = threads.find(t => t.id === threadId);
    const key = resolveKey(threadId);
    if (!thread || busy.has(key)) return;
    const want = !thread.resolved;
    const going = run(key, () => resolveThread(threadId, want), want ? "Could not resolve it." : "Could not open it again.");
    redrawGhThread(threadId);
    const resolved = await going;
    if (resolved !== null) {
      threads = threads.map(t => t.id === threadId
        ? { ...t, resolved, resolvedBy: resolved ? viewerLogin || t.resolvedBy : null }
        : t);
      // Already what GitHub has: the next refresh need not lay everything out again.
      threadsSig = threadsSignature(threads);
      if (resolved) openThreads.delete(threadId); else openThreads.add(threadId);
      indexComments();
    }
    redrawGhThread(threadId);
    refreshChrome();
  }

  /** Redraws a conversation wherever it shows: under its line, above its file, or in the panel. */
  function redrawGhThread(threadId: string) {
    const thread = threads.find(t => t.id === threadId);
    if (!thread) return;
    const key = ghAnchor(thread);
    keepingFocus(() => {
      if (key === null) drawPanel();
      else if (key === fileKey(thread.path)) redrawFileTop(thread.path);
      else if (thread.line !== null) redrawAt(thread.path, thread.side, thread.line);
    });
  }

  function redrawFileTop(path: string) {
    const i = indexByPath.get(path);
    const body = i === undefined ? null : bodyEl(i);
    if (i === undefined || !body || !views[i].rendered) return;
    const items = anchors.get(fileKey(path)) ?? [];
    const html = items.length ? `<div class="pd-ai-thread" data-file-thread>${items.map(it => itemHtml(it)).join("")}</div>` : "";
    const top = body.querySelector<HTMLElement>(":scope > [data-file-thread]");
    if (top) top.outerHTML = html;
    else if (html) body.insertAdjacentHTML("afterbegin", html);
  }

  function openReply(threadId: string) {
    if (!threadId) return;
    if (!replyEditors.has(threadId)) replyEditors.set(threadId, "");
    redrawGhThread(threadId);
    focusEditor(replyKey(threadId));
  }

  /** Add to review: the reply waits in ZuGit for the review it goes out with. */
  async function addReply(threadId: string, key: string) {
    const text = (replyEditors.get(threadId) ?? "").trim();
    if (!text) { focusEditor(key); return; }
    const saved = await run(key, () => saveReply(pr.repo, pr.id, null, threadId, text), "Could not save the reply.");
    if (saved) {
      mine = saved;
      replyEditors.delete(threadId);
    }
    redrawGhThread(threadId);
    refreshChrome();
  }

  /** Reply now: on GitHub at once and on its own, as its "Add single comment". */
  async function sendReplyNow(threadId: string, key: string) {
    const text = (replyEditors.get(threadId) ?? "").trim();
    if (!text) { focusEditor(key); return; }
    const sending = run(key, async () => { await replyNow(threadId, text); return true; }, "Could not reply.");
    redrawGhThread(threadId);
    if (await sending) {
      replyEditors.delete(threadId);
      // It comes back as one of GitHub's own comments.
      await loadThreads();
    }
    redrawGhThread(threadId);
  }

  async function saveReplyEdit(reply: UserReply, key: string) {
    const text = (edits.get(key) ?? "").trim();
    if (!text) { focusEditor(key); return; }
    const saved = await run(key, () => saveReply(pr.repo, pr.id, reply.id, reply.threadId, text), "Could not save the reply.");
    if (saved) {
      mine = saved;
      edits.delete(key);
    }
    redrawGhThread(reply.threadId);
  }

  async function removeReply(reply: UserReply, key: string) {
    if (!confirmTwice(key, () => redrawGhThread(reply.threadId))) return;
    const saved = await run(key, () => deleteReply(pr.repo, pr.id, reply.id), "Could not delete the reply.");
    if (saved) {
      mine = saved;
      edits.delete(key);
    }
    redrawGhThread(reply.threadId);
    refreshChrome();
  }

  // ── Publishing ──────────────────────────────────────────────────────────────

  function publishState(): PublishState {
    return { ownPr, busy: publishing, note: publishNote };
  }

  /** The top bar's way in, and the panel under it when open. */
  function drawPublish() {
    const count = mine.comments.length + mine.replies.length;
    const open = $<HTMLElement>("[data-pd-publish-open]");
    open.innerHTML = renderPublishOpen(count, publishOpen);
    open.setAttribute("aria-expanded", String(publishOpen));
    open.classList.toggle("pd-publish-open--waiting", count > 0);
    const pop = $<HTMLElement>("[data-pd-publish-pop]");
    pop.hidden = !publishOpen;
    if (!publishOpen) return;
    // Hung under its button, right edges aligned, whatever the top bar's height.
    const shell = $<HTMLElement>(".pd-shell");
    pop.style.top = `${open.offsetTop + open.offsetHeight + 6}px`;
    pop.style.right = `${Math.max(12, shell.clientWidth - open.offsetLeft - open.offsetWidth)}px`;
    keepingFocus(() => { pop.innerHTML = renderPublishPanel(mine, summaryText, publishState()); });
  }

  function togglePublish(open: boolean) {
    publishOpen = open;
    if (!open && !publishing) publishNote = "";
    drawPublish();
    if (open) focusEditor("summary");
  }

  /** Redraws the buttons alone: redrawing the panel would cost the summary its caret. */
  function syncPublishButtons() {
    const row = overlay.querySelector<HTMLElement>("[data-pd-publish-row]");
    if (row) {
      row.outerHTML = renderPublishButtons(publishState(), mine.comments.length + mine.replies.length, summaryText.trim() !== "");
    }
    // While the review goes out its text is the one sent: typed then, it would be lost.
    const text = overlay.querySelector<HTMLTextAreaElement>("[data-pd-review-text]");
    if (text) text.readOnly = publishing;
  }

  async function onPublish(button: HTMLElement) {
    const event = button.dataset.pdPublish;
    if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") return;
    // A button that cannot work says why.
    if (button.getAttribute("aria-disabled") === "true") {
      if (!publishing) publishNote = escHtml(button.title);
      syncPublishButtons();
      return;
    }
    await publish(event);
  }

  /** One click publishes, as GitHub's submit. What is still being typed would not go out: first saved or dropped. */
  async function publish(event: ReviewEvent) {
    if (publishing) return;
    // What is still being typed would not go out: the panel steps aside to show it.
    const unsaved = [...drafts.values()].map(draftKey).concat([...edits.keys()], [...replyEditors.keys()].map(replyKey)).some(isUnsaved);
    if (unsaved) {
      togglePublish(false);
      showUnsaved("Save this or cancel it first: it would not be published.");
      return;
    }
    publishing = true;
    publishNote = "";
    syncPublishButtons();
    try {
      if (summaryTimer) await saveSummary();
      const result = await publishReview(pr.repo, pr.id, event, headSha);
      mine = result.mine;
      summaryText = mine.summary ?? "";
      // Editors left open on what went out: a new comment given its id must not inherit one.
      for (const key of [...edits.keys()]) {
        if (!findRef(key) && !replyOf(key)) { edits.delete(key); errors.delete(key); }
      }
      publishNote = publishedNote(result);
      indexComments();
      layout();
      // What GitHub accepted comes back as its own conversations.
      await loadThreads();
    } catch (err) {
      publishNote = `<span class="pd-publish__error">${escHtml(errorMessage(err, "Could not publish the review."))}</span>`;
      // Refused for new commits: the reload notice shows at once.
      void checkHead();
    } finally {
      publishing = false;
      drawPanel();
      drawPublish();
    }
  }

  function publishedNote(result: PublishResult): string {
    const links = result.published.map(r => {
      const label = r.commit.toLowerCase() === headSha.toLowerCase() ? "View your review" : `On ${escHtml(r.commit.slice(0, 7))}`;
      return r.url.startsWith("https://") ? `<a class="pd-md-link" href="#" data-pd-link="${escHtml(r.url)}">${label}</a>` : label;
    });
    const failed = result.failed.map(f =>
      `<span class="pd-publish__error">${f.comments} not published — ${escHtml(f.error)} They stay here.</span>`);
    return [links.length ? `Published on GitHub · ${links.join(" · ")}` : "", ...failed].filter(Boolean).join(" ");
  }

  // Two clicks, no dialog: a whole review is the one thing worth a second thought.
  let disarmTimer = 0;
  async function onDiscardReview(source: string) {
    if (armedDiscard !== source) {
      armedDiscard = source;
      drawPanel();
      window.clearTimeout(disarmTimer);
      disarmTimer = window.setTimeout(() => { armedDiscard = null; drawPanel(); }, 4000);
      return;
    }
    armedDiscard = null;
    const review = reviews.find(r => r.source === source);
    if (!review) return;
    try {
      await discardAiReview(review);
    } finally {
      await loadReviews(true);
    }
  }

  async function copyPrompt(button: HTMLButtonElement) {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(reviewPrompt(pr.repo, pr.id, headSha));
      button.textContent = "Copied — paste it into your agent";
    } catch {
      button.textContent = "Could not copy";
    }
    window.setTimeout(() => { button.textContent = label; }, 2500);
  }

  /** Fetches GitHub's conversations again; re-lays the view out only when they changed. */
  async function loadThreads() {
    threadsAt = Date.now();
    let next: GhThread[];
    try {
      next = await getPrThreads(pr.repo, pr.id);
    } catch (err) {
      // Keep what is shown, and say it may be stale.
      threadsNotice = `GitHub conversations could not be refreshed: ${errorMessage(err, "unknown error")}`;
      drawPanel();
      return;
    }
    if (!overlay.isConnected) return;
    const hadNotice = threadsNotice !== null;
    threadsNotice = null;
    const signature = threadsSignature(next);
    if (signature === threadsSig) {
      if (hadNotice) drawPanel();
      return;
    }
    threadsSig = signature;
    threads = next;
    indexComments();
    if (views.length) layout();
  }

  /**
   * Asks GitHub for the PR's latest commit, as GitHub's own Refresh does: the
   * diff on screen never changes under the reader's hands, a notice offers to
   * reload. True while the diff is still on the latest commit.
   */
  async function checkHead(): Promise<boolean> {
    let head: string;
    try {
      head = await getPrHead(pr.repo, pr.id);
    } catch {
      return true; // Offline or rate-limited: the next look will tell.
    }
    if (!overlay.isConnected || head.toLowerCase() === headSha.toLowerCase()) return true;
    newHead = head;
    drawUpdate();
    return false;
  }

  function drawUpdate(error?: string) {
    const slot = $<HTMLElement>("[data-pd-update]");
    slot.hidden = !newHead && !error;
    slot.innerHTML = error
      ? `<span>${escHtml(error)}</span><button class="pd-ai-btn" type="button" data-pd-reload>Try again</button>`
      : newHead
        ? `<span>New commits since you opened this diff</span><button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pd-reload>Reload</button>`
        : "";
  }

  function onWindowFocus() {
    if (Date.now() - threadsAt <= THREADS_REFRESH_MS) return;
    threadsAt = Date.now();
    // Conversations placed on a newer commit would not line up with the diff on
    // screen: after a push they wait for the reload.
    void checkHead().then(current => { if (current && !newHead) void loadThreads(); });
  }
  window.addEventListener("focus", onWindowFocus);

  function drawSummary(diff: PrDiff) {
    const add = diff.files.reduce((n, f) => n + f.additions, 0);
    const del = diff.files.reduce((n, f) => n + f.deletions, 0);
    $<HTMLElement>("[data-pd-summary]").innerHTML =
      `<span class="rd-sep">·</span> ${diff.files.length.toLocaleString()} file${diff.files.length === 1 ? "" : "s"} ${renderStat(add, del)}` +
      (diff.truncated ? ` <span class="pd-reason">GitHub lists the first 3000 files only</span>` : "");
  }

  /** Puts a freshly read diff on screen; comments re-anchor to it on the next index. */
  function applyDiff(diff: PrDiff) {
    views = diff.files.map(toFileView);
    indexByPath.clear();
    views.forEach((v, i) => indexByPath.set(v.file.filename, i));
    if (diff.headSha) headSha = diff.headSha;
    // Worked out for the previous commit: asked again by loadPositions.
    carried = new Map();
    drawSummary(diff);
  }

  const fetchDiff = () => invoke<PrDiff>("fetch_pr_diff", { repo: pr.repo, number: pr.id });

  /**
   * Moves the view to the latest commit, on the reader's click. Comments and
   * editors stay on the commit they were written on: under their line while
   * that code is the same, in the panel with it otherwise.
   */
  async function reload() {
    const loading = $<HTMLElement>("[data-pd-loading]");
    loading.hidden = false;
    try {
      const [diff, next] = await Promise.all([
        fetchDiff(),
        getPrThreads(pr.repo, pr.id).catch((err: unknown) => {
          threadsNotice = `GitHub conversations could not be loaded: ${errorMessage(err, "unknown error")}`;
          return null;
        }),
      ]);
      if (!overlay.isConnected) return;
      applyDiff(diff);
      // The old ones were placed on the old commit: better none than misplaced.
      threads = next ?? [];
      threadsSig = next ? threadsSignature(next) : "";
      if (next) threadsNotice = null;
      threadsAt = Date.now();
      newHead = null;
      drawUpdate();
      indexComments();
      layout();
      void loadPositions();
    } catch (err) {
      drawUpdate(`Could not reload: ${errorMessage(err, "unknown error")}`);
    } finally {
      loading.hidden = true;
    }
  }

  /** Reloads proposals; re-lays the view out only when an agent replaced one. */
  async function loadReviews(force = false) {
    let next: AiReview[];
    try {
      next = await getAiReviews(pr.repo, pr.id);
    } catch {
      return;
    }
    const signature = next.map(r => `${r.source}@${r.createdAt}`).join(",");
    if (!force && signature === reviewSignature) return;
    reviewSignature = signature;
    reviews = next;
    indexComments();
    if (views.length) layout();
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  /** Draws the file list and sections in the current order; file bodies come lazily. */
  function layout() {
    const scroll = content.scrollTop;
    const ordered = groups();
    const fileButton = (path: string, depth?: number) => {
      const i = indexByPath.get(path) ?? -1;
      return i === -1 ? "" : renderFileButton(views[i], i, countsFor(path), depth);
    };
    fileList.innerHTML = asTree()
      ? renderTree(pathTree(views.map(v => v.file.filename)), 0, fileButton, folded)
      : ordered.map(g => {
        const files = g.files.map(path => fileButton(path)).join("");
        return g.title
          ? `<div class="pd-group" data-pd-group><div class="pd-group__title" title="${escHtml(g.why)}">${escHtml(g.title)}</div>${files}</div>`
          : files;
      }).join("");
    const tree = $<HTMLElement>("[data-pd-tree]");
    tree.hidden = orderMode !== "path";
    tree.setAttribute("aria-pressed", String(treeMode));
    overlay.querySelectorAll<HTMLElement>("[data-pd-order-mode]").forEach(btn => {
      btn.classList.toggle("rd-seg-btn--active", btn.dataset.pdOrderMode === orderMode);
    });
    overlay.querySelectorAll<HTMLElement>("[data-pd-view-mode]").forEach(btn => {
      btn.classList.toggle("rd-seg-btn--active", btn.dataset.pdViewMode === viewMode);
    });

    views.forEach(v => { v.rendered = false; v.renderGen++; });
    const sections = ordered.flatMap(g => g.files)
      .map(path => indexByPath.get(path))
      .filter((i): i is number => i !== undefined)
      .map(i => renderSection(views[i], i))
      .join("");
    content.innerHTML = `<div data-pd-ai></div>` +
      (sections || `<div class="pd-empty">This pull request changes no files.</div>`);
    drawPanel();

    // Bodies are drawn as they approach the viewport: a 500-file PR opens at once.
    observer?.disconnect();
    const lazy = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const i = Number((entry.target as HTMLElement).dataset.pdBody);
        lazy.unobserve(entry.target);
        if (!views[i].rendered) drawBody(i);
      }
    }, { root: content, rootMargin: "800px 0px" });
    content.querySelectorAll("[data-pd-body]").forEach(el => lazy.observe(el));
    observer = lazy;

    applyFilter();
    content.scrollTop = scroll;
    activeIndex = -1;
    const first = visibleIndexes()[0];
    if (first !== undefined) setActive(first);
  }

  // ── File bodies ─────────────────────────────────────────────────────────────

  function toggleFile(i: number) {
    const v = views[i];
    const sec = sectionEl(i);
    if (!v || !sec) return;
    v.collapsed = !v.collapsed;
    sec.classList.toggle("pd-section--collapsed", v.collapsed);
    sec.querySelector("[data-pd-toggle]")?.setAttribute("aria-expanded", String(!v.collapsed));
    if (!v.collapsed && !v.rendered) drawBody(i);
  }

  function drawBody(i: number) {
    const v = views[i];
    const body = bodyEl(i);
    if (!v || !body || v.collapsed) return;
    body.innerHTML = renderBody(v, i, anchors, viewMode, itemHtml);
    body.style.minHeight = "";
    v.rendered = true;
    paintSelections(i);
    if (pendingJump !== null) alignTo(pendingJump);
    const gen = ++v.renderGen;
    if (v.lang && v.hunks.length > 0) void highlightBody(v, v.lang, body, gen);
  }

  async function highlightBody(v: FileView, lang: DiffLang, body: HTMLElement, gen: number) {
    try {
      const { tokenize } = await import("./pr-diff-highlight");
      const perLine: (Token[] | undefined)[] = [];
      for (const hunk of v.hunks) {
        const sides = hunkSides(hunk);
        const hasDel = hunk.lines.some(l => l.kind === "del");
        const hasNew = hunk.lines.some(l => l.kind !== "del");
        const [oldSide, newSide] = await Promise.all([
          hasDel ? tokenize(sides.old, lang) : Promise.resolve([]),
          hasNew ? tokenize(sides.new, lang) : Promise.resolve([]),
        ]);
        perLine.push(...alignSides(hunk, oldSide, newSide));
      }
      if (gen !== v.renderGen || !body.isConnected) return;
      body.querySelectorAll<HTMLElement>(".pd-code[data-li]").forEach(el => {
        const k = Number(el.dataset.li);
        el.innerHTML = renderTokens(perLine[k], v.lines[k]?.text ?? "");
      });
    } catch {
      // Plain text is still a readable diff; the colours are a bonus.
    }
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  try {
    threadsAt = Date.now();
    const [diff, initialReviews, initialMine, initialThreads] = await Promise.all([
      fetchDiff(),
      getAiReviews(pr.repo, pr.id).catch(() => [] as AiReview[]),
      // Unreadable comments must not keep the diff from opening.
      getUserComments(pr.repo, pr.id).catch((err: unknown) => {
        mineNotice = errorMessage(err, "Your comments on this PR could not be read.");
        return null;
      }),
      // Nor may GitHub's conversations.
      getPrThreads(pr.repo, pr.id).catch((err: unknown) => {
        threadsNotice = `GitHub conversations could not be loaded: ${errorMessage(err, "unknown error")}`;
        return [] as GhThread[];
      }),
    ]);
    if (!overlay.isConnected) return;
    applyDiff(diff);
    reviews = initialReviews;
    if (initialMine) mine = initialMine;
    summaryText = mine.summary ?? "";
    threads = initialThreads;
    threadsSig = threadsNotice ? "" : threadsSignature(threads);
    reviewSignature = reviews.map(r => `${r.source}@${r.createdAt}`).join(",");
    indexComments();

    layout();
    drawPublish();
    aiPoll = window.setInterval(() => void loadReviews(), AI_POLL_MS);
    headPoll = window.setInterval(() => { if (!newHead) void checkHead(); }, HEAD_POLL_MS);
    void loadPositions();
  } catch (err) {
    content.innerHTML = `<div class="pd-empty pd-empty--error">${escHtml(errorMessage(err, "Unable to load the diff."))}</div>`;
  } finally {
    $<HTMLElement>("[data-pd-loading]").hidden = true;
  }
}
