/**
 * Markup for review comments in the PR diff view: the conversations already on
 * GitHub, an agent's proposals, the user's own comments and the editor for a
 * new one — cards under diff lines and the panel above the files. State
 * changes go through pr-diff.ts.
 */

import {
  READ_ONLY_HINT, agentLabel, isOutdated,
  type AiComment, type AiReview, type UserComment, type UserReply, type UserReview,
} from "./ai-review";
import { renderMarkdown, suggestionBlock } from "./markdown-lite";
import { hunkTail } from "./pr-diff-parse";
import type { GhComment, GhThread } from "./pr-threads";
import { escHtml, relativeTime } from "./utils";

export type Side = "new" | "old";

/** A comment card: one of an agent's proposals, or one of the user's own. */
export type CardRef =
  | { kind: "ai"; review: AiReview; comment: AiComment }
  | { kind: "user"; comment: UserComment };

/** A comment being written on lines the user selected. */
export interface Draft {
  id: string;
  path: string;
  side: Side;
  line: number;
  endLine: number | null;
  text: string;
  /** The commit the lines were picked on: the comment is saved on it. */
  headSha: string;
  /** Their code, kept with the comment. */
  diffHunk: string | null;
}

/** What hangs under a diff line: GitHub's conversations first, then the cards and editors. */
export type ThreadItem = CardRef | { kind: "draft"; draft: Draft } | { kind: "gh"; thread: GhThread };

/** Card id in the DOM: an agent's comment ids are unique within its review, the user's within theirs. */
export function cardKey(ref: CardRef): string {
  return ref.kind === "ai" ? `ai:${ref.review.source}|${ref.comment.id}` : `me:${ref.comment.id}`;
}

export const draftKey = (draft: Draft) => `draft:${draft.id}`;

/** Where an inline comment shows: under the last line of its range. */
export function anchorKey(path: string, side: Side, line: number): string {
  return `${path}|${side}|${line}`;
}

/** Comments on a whole file show above its first hunk. */
export const fileKey = (path: string) => `${path}|file`;

/** How a card is drawn right now. */
export interface CardState {
  /** In the panel: the card says which file and lines it is about. */
  showLocation?: boolean;
  /** The text being edited; null when not editing. */
  editing?: string | null;
  /** Why the last save failed. */
  error?: string | null;
  /** Delete was clicked once: the next click deletes. */
  armed?: boolean;
  /**
   * A user comment written on an older commit than the diff's: "outdated" when
   * its code changed since (it shows in the panel, with that code), "unverified"
   * when it was saved without its code and nobody can tell.
   */
  age?: "outdated" | "unverified";
}

const SEVERITY: Record<AiComment["severity"], string> = {
  bug: "Bug",
  suggestion: "Suggestion",
  nit: "Nit",
  question: "Question",
};

const SUBMIT_KEYS = navigator.platform.toUpperCase().includes("MAC") ? "⌘↵" : "Ctrl+Enter";

/** "Line 12", "Lines 12–15"; "(old)" when they are the base file's. */
export function rangeLabel(line: number, endLine: number | null, side: Side): string {
  const lines = endLine ? `Lines ${line}–${endLine}` : `Line ${line}`;
  return side === "old" ? `${lines} (old)` : lines;
}

type Located = Pick<AiComment, "path" | "line" | "endLine" | "side">;

/** In the panel, the file and lines; under the code, the range when it spans several lines. */
function location(c: Located, inPanel: boolean): string {
  if (!c.path) return "";
  if (inPanel) {
    const lines = c.line === null ? "" : c.endLine ? `:${c.line}–${c.endLine}` : `:${c.line}`;
    return `<span class="pd-ai-card__loc">${escHtml(c.path)}${lines}${c.side === "old" ? " (old)" : ""}</span>`;
  }
  return c.line !== null && c.endLine
    ? `<span class="pd-ai-card__loc">${rangeLabel(c.line, c.endLine, c.side)}</span>`
    : "";
}

function severityTag(severity: AiComment["severity"]): string {
  return `<span class="pd-ai-sev pd-ai-sev--${severity}">${SEVERITY[severity]}</span>`;
}

function errorLine(error: string | null | undefined): string {
  return error ? `<div class="pd-ai-card__error">${escHtml(error)}</div>` : "";
}

function suggestion(code: string | null): string {
  return code ? suggestionBlock(code) : "";
}

/** Textarea and buttons; Esc and ⌘/Ctrl+Enter are handled by the view. */
function editor(text: string, error: string | null | undefined, save: string, placeholder = ""): string {
  const rows = Math.min(12, Math.max(3, text.split("\n").length + 1));
  return `<textarea class="pd-ai-edit" data-pd-edit rows="${rows}" placeholder="${escHtml(placeholder)}">${escHtml(text)}</textarea>` +
    errorLine(error) +
    `<div class="pd-ai-card__actions">` +
      `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pd-action="save" title="${SUBMIT_KEYS}">${save}</button>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="cancel">Cancel</button>` +
    `</div>`;
}

export function renderCard(ref: CardRef, state: CardState = {}): string {
  return ref.kind === "ai" ? renderAiCard(ref.review, ref.comment, state) : renderUserCard(ref.comment, state);
}

function renderAiCard(review: AiReview, comment: AiComment, state: CardState): string {
  const key = escHtml(cardKey({ kind: "ai", review, comment }));
  const editing = state.editing ?? null;

  if (comment.status === "discarded" && editing === null) {
    const firstLine = comment.body.split("\n")[0].slice(0, 90);
    return `<div class="pd-ai-card pd-ai-card--discarded" data-pd-card="${key}">` +
      severityTag(comment.severity) +
      `<span class="pd-ai-card__gone">Discarded · ${escHtml(firstLine)}</span>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="pending">Undo</button>` +
      `</div>`;
  }

  const head = `<div class="pd-ai-card__head">` +
    `<span class="pd-ai-agent">${escHtml(agentLabel(review.source))}</span>` +
    severityTag(comment.severity) +
    location(comment, !!state.showLocation) +
    `</div>`;

  if (editing !== null) {
    return `<div class="pd-ai-card pd-ai-card--editing" data-pd-card="${key}">` + head +
      editor(editing, state.error, "Save & keep") + `</div>`;
  }

  return `<div class="pd-ai-card pd-ai-card--${comment.severity}" data-pd-card="${key}">` +
    head +
    `<div class="pd-ai-card__body">${renderMarkdown(comment.body)}</div>` +
    suggestion(comment.suggestion) +
    errorLine(state.error) +
    `<div class="pd-ai-card__actions">` +
      `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pd-action="keep" title="Make it your comment">Keep</button>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="edit" title="Reword it, then keep it as yours">Edit</button>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="discard">Discard</button>` +
    `</div></div>`;
}

function renderUserCard(comment: UserComment, state: CardState): string {
  const key = escHtml(cardKey({ kind: "user", comment }));
  const editing = state.editing ?? null;
  const written = escHtml(comment.headSha.slice(0, 7));

  const head = `<div class="pd-ai-card__head">` +
    `<span class="pd-you">You</span>` +
    (state.age === "outdated" ? ghTag("Outdated", "outdated") : "") +
    (comment.severity ? severityTag(comment.severity) : "") +
    location(comment, !!state.showLocation) +
    (comment.keptFrom ? `<span class="pd-ai-card__note">from ${escHtml(agentLabel(comment.keptFrom.source))}</span>` : "") +
    (state.age === "unverified"
      ? `<span class="pd-ai-card__note" title="Written on ${written}: the PR has new commits since, so the lines may have moved.">older commit</span>`
      : "") +
    `</div>` +
    // The code it was written on, as GitHub shows above an outdated comment.
    (state.age === "outdated" && comment.diffHunk
      ? `<div class="pd-gh-where">written on <code>${written}</code></div>` +
        snippetHtml(comment.diffHunk, rangeSpan(comment.line, comment.endLine))
      : "");

  if (editing !== null) {
    return `<div class="pd-ai-card pd-ai-card--user pd-ai-card--editing" data-pd-card="${key}">` + head +
      editor(editing, state.error, "Save") + `</div>`;
  }

  return `<div class="pd-ai-card pd-ai-card--user" data-pd-card="${key}">` +
    head +
    `<div class="pd-ai-card__body">${renderMarkdown(comment.body)}</div>` +
    suggestion(comment.suggestion) +
    errorLine(state.error) +
    `<div class="pd-ai-card__actions">` +
      `<button class="pd-ai-btn" type="button" data-pd-action="edit">Edit</button>` +
      `<button class="pd-ai-btn${state.armed ? " pd-ai-btn--danger" : ""}" type="button" data-pd-action="delete">${state.armed ? "Click again to delete" : "Delete"}</button>` +
    `</div></div>`;
}

/**
 * The editor that opens under lines the user selected. `loose`: the diff was
 * reloaded on a newer commit that changed those lines, so it waits in the
 * panel with the code it was started on, and is saved on that commit.
 */
export function renderDraft(draft: Draft, error: string | null, loose = false): string {
  const where = loose
    ? `<span class="pd-ai-card__loc">${escHtml(draft.path)}:${draft.line}${draft.endLine ? `–${draft.endLine}` : ""}${draft.side === "old" ? " (old)" : ""}</span>`
    : `<span class="pd-ai-card__loc">${rangeLabel(draft.line, draft.endLine, draft.side)}</span>`;
  return `<div class="pd-ai-card pd-ai-card--user pd-ai-card--editing" data-pd-card="${escHtml(draftKey(draft))}">` +
    `<div class="pd-ai-card__head">` +
      `<span class="pd-you">You</span>` +
      (loose ? ghTag("Outdated", "outdated") : "") +
      where +
    `</div>` +
    (loose
      ? `<div class="pd-gh-where">These lines changed since you started: the comment is saved on <code>${escHtml(draft.headSha.slice(0, 7))}</code>, where you wrote it.</div>` +
        (draft.diffHunk ? snippetHtml(draft.diffHunk, rangeSpan(draft.line, draft.endLine)) : "")
      : "") +
    editor(draft.text, error, "Add comment", `Leave a comment — ${SUBMIT_KEYS} to add`) +
    `</div>`;
}

// ── Conversations on GitHub ──────────────────────────────────────────────────

function ghTag(label: string, kind: string): string {
  return `<span class="pd-gh-tag pd-gh-tag--${kind}">${label}</span>`;
}

/** "Comment on lines +12 to +15", as GitHub heads a conversation on several lines. */
function ghRange(start: number | null, end: number | null, side: Side): string {
  if (start === null || end === null || start === end) return "";
  const sign = side === "old" ? "-" : "+";
  return `<div class="pd-gh-range">Comment on lines ${sign}${start} to ${sign}${end}</div>`;
}

function ghComment(c: GhComment): string {
  const avatar = c.avatarUrl.startsWith("https://")
    ? `<img class="pd-gh-avatar" src="${escHtml(c.avatarUrl)}" alt="" loading="lazy">`
    : `<span class="pd-gh-avatar"></span>`;
  const meta = `<div class="pd-gh-meta"><span class="pd-gh-author">${escHtml(c.author)}</span>` +
    `<span>${escHtml(relativeTime(c.createdAt))}</span>` +
    (c.pending ? ghTag("Pending", "pending") : "") + `</div>`;
  const body = c.minimized !== null
    ? `<div class="pd-gh-hidden">Hidden on GitHub${c.minimized ? ` as ${escHtml(c.minimized)}` : ""}.</div>`
    : `<div class="pd-ai-card__body">${renderMarkdown(c.body)}</div>`;
  return `<div class="pd-gh-comment">${avatar}<div class="pd-gh-main">${meta}${body}</div></div>`;
}

/** Replying and resolving stay on GitHub. */
/**
 * What the user does with a conversation, drawn by the view: their pending
 * replies, the reply editor, and resolving it.
 */
export type ReplyArea = (thread: GhThread) => {
  pending: string;
  editor: string | null;
  /** Resolve or Unresolve is on its way to GitHub. */
  resolving: boolean;
  /** Why GitHub refused to resolve it, or to open it again. */
  error: string | null;
};

/**
 * The thread's foot, as on GitHub: Reply… (unless the editor is open), Resolve
 * or Unresolve conversation, the rest of it on GitHub.
 */
function ghFoot(thread: GhThread, area: ReturnType<ReplyArea>): string {
  const id = escHtml(thread.id);
  const url = thread.comments[0]?.url ?? "";
  const more = thread.moreComments ? `${thread.moreComments} more repl${thread.moreComments === 1 ? "y" : "ies"} · ` : "";
  const open = url.startsWith("https://")
    ? `<a class="pd-md-link" href="#" data-pd-link="${escHtml(url)}">Open on GitHub</a>`
    : "";
  const label = area.resolving
    ? (thread.resolved ? "Unresolving…" : "Resolving…")
    : (thread.resolved ? "Unresolve conversation" : "Resolve conversation");
  return `<div class="pd-gh-foot">` +
      (area.editor !== null ? "" : `<button class="pd-gh-replyopen" type="button" data-pd-reply="${id}">Reply…</button>`) +
      `<button class="pd-ai-btn" type="button" data-pd-resolve="${id}"${area.resolving ? " disabled" : ""}>${label}</button>` +
      `<span class="pd-gh-foot__more">${more}${open}</span>` +
    `</div>` +
    (area.error ? `<div class="pd-gh-foot__error">${escHtml(area.error)}</div>` : "");
}

/** Comments, the user's pending replies, the editor, the foot. */
function ghConversation(thread: GhThread, reply: ReplyArea): string {
  const area = reply(thread);
  return thread.comments.map(ghComment).join("") + area.pending + (area.editor ?? "") + ghFoot(thread, area);
}

/** A reply of the user's waiting for their review, inside the conversation as on GitHub. */
export function renderPendingReply(reply: UserReply, state: CardState): string {
  const key = escHtml(`rp:${reply.id}`);
  const editing = state.editing ?? null;
  const body = editing !== null
    ? editor(editing, state.error, "Save")
    : `<div class="pd-ai-card__body">${renderMarkdown(reply.body)}</div>` +
      errorLine(state.error) +
      `<div class="pd-ai-card__actions">` +
        `<button class="pd-ai-btn" type="button" data-pd-action="edit">Edit</button>` +
        `<button class="pd-ai-btn${state.armed ? " pd-ai-btn--danger" : ""}" type="button" data-pd-action="delete">${state.armed ? "Click again to delete" : "Delete"}</button>` +
      `</div>`;
  return `<div class="pd-gh-comment pd-gh-comment--pending" data-pd-card="${key}">` +
    `<span class="pd-gh-avatar pd-gh-avatar--you"></span>` +
    `<div class="pd-gh-main">` +
      `<div class="pd-gh-meta"><span class="pd-you">You</span>${ghTag("Pending", "pending")}<span>goes out with your review</span></div>` +
      body +
    `</div></div>`;
}

/** The reply editor under a conversation: into the review, or straight to GitHub. */
export function renderReplyEditor(thread: GhThread, text: string, error: string | null, busy: boolean): string {
  const rows = Math.min(10, Math.max(3, text.split("\n").length + 1));
  return `<div class="pd-gh-reply" data-pd-card="${escHtml(`reply:${thread.id}`)}">` +
    `<textarea class="pd-ai-edit" data-pd-edit rows="${rows}" placeholder="Reply — ${SUBMIT_KEYS} adds it to your review">${escHtml(text)}</textarea>` +
    errorLine(error) +
    `<div class="pd-ai-card__actions">` +
      `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pd-action="save" title="${SUBMIT_KEYS} — goes out when you publish your review"${busy ? " disabled" : ""}>Add to review</button>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="reply-now" title="Posts it on GitHub now, on its own"${busy ? " disabled" : ""}>${busy ? "Replying…" : "Reply now"}</button>` +
      `<button class="pd-ai-btn" type="button" data-pd-action="cancel">Cancel</button>` +
    `</div></div>`;
}

/** The folded line: who started it and how. */
function ghGist(thread: GhThread): string {
  const first = thread.comments[0];
  if (!first) return "";
  const text = first.minimized !== null ? "hidden comment" : first.body.replace(/\s+/g, " ").trim().slice(0, 90);
  return `<span class="pd-gh-gist"><strong>${escHtml(first.author)}</strong> ${escHtml(text)}</span>`;
}

/** A conversation under its line. Resolved ones fold, as on GitHub. */
export function renderGhThread(thread: GhThread, open: boolean, reply: ReplyArea): string {
  const id = escHtml(thread.id);
  const inner = ghRange(thread.startLine, thread.line, thread.side) + ghConversation(thread, reply);
  if (!thread.resolved) return `<div class="pd-gh-thread" data-pd-gh="${id}">${inner}</div>`;
  const by = thread.resolvedBy ? ` by ${escHtml(thread.resolvedBy)}` : "";
  return `<details class="pd-gh-thread" data-pd-gh="${id}"${open ? " open" : ""}>` +
    `<summary class="pd-gh-summary">${ghTag(`Resolved${by}`, "resolved")}${ghGist(thread)}</summary>${inner}</details>`;
}

/** How many lines a range covers. */
function rangeSpan(line: number | null, endLine: number | null): number {
  return line !== null && endLine !== null ? endLine - line + 1 : 1;
}

/** The code a comment was written on: the end of its hunk, at least four lines, as GitHub shows it. */
function snippetHtml(diffHunk: string, span: number): string {
  const lines = hunkTail(diffHunk, Math.max(4, span));
  if (!lines.length) return "";
  return `<div class="pd-snippet">` + lines.map(l =>
    `<div class="pd-line pd-line--${l.kind}"><span class="pd-ln">${l.oldNo ?? ""}</span><span class="pd-ln">${l.newNo ?? ""}</span>` +
    `<span class="pd-sign">${l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span><span class="pd-code">${escHtml(l.text)}</span></div>`,
  ).join("") + `</div>`;
}

/** A conversation the latest diff has no line for: folded, with the code it was written on. */
export function renderLooseThread(thread: GhThread, open: boolean, reply: ReplyArea): string {
  const line = thread.originalLine ?? thread.line;
  const where = escHtml(thread.path) + (line !== null ? `:${line}` : "") + (thread.side === "old" && line !== null ? " (old)" : "");
  const status = thread.outdated ? ghTag("Outdated", "outdated")
    : line === null ? ghTag("File", "file")
    : ghTag("Not in this diff", "outdated");
  const commit = thread.originalCommit ? ` · written on <code>${escHtml(thread.originalCommit.slice(0, 7))}</code>` : "";
  return `<details class="pd-gh-thread" data-pd-gh="${escHtml(thread.id)}"${open ? " open" : ""}>` +
    `<summary class="pd-gh-summary">${status}${thread.resolved ? ghTag("Resolved", "resolved") : ""}` +
    `<span class="pd-ai-card__loc">${where}</span>${ghGist(thread)}</summary>` +
    `<div class="pd-gh-where">${where}${commit}</div>` +
    snippetHtml(thread.diffHunk, rangeSpan(thread.originalStartLine, thread.originalLine)) +
    ghRange(thread.originalStartLine, thread.originalLine, thread.side) +
    ghConversation(thread, reply) +
    `</details>`;
}

/** The panel's GitHub block: the count, then the conversations without a line in this diff. */
export function renderGhPanel(
  all: GhThread[], loose: GhThread[], notice: string | null, isOpen: (id: string) => boolean, reply: ReplyArea,
): string {
  const warning = notice ? `<div class="pd-ai-outdated">${escHtml(notice)}</div>` : "";
  if (all.length === 0) return warning ? `<div class="pd-ai-panel pd-ai-panel--gh">${warning}</div>` : "";
  const unresolved = all.filter(t => !t.resolved).length;
  const meta = `${all.length} conversation${all.length === 1 ? "" : "s"} on GitHub` +
    (unresolved ? ` · <strong>${unresolved} unresolved</strong>` : "") +
    (loose.length ? ` · ${loose.length} outdated or not in this diff, below` : " · under their lines");
  return `<div class="pd-ai-panel pd-ai-panel--gh">` +
    `<div class="pd-ai-panel__head"><span class="pd-gh-badge">GitHub</span><span class="pd-ai-panel__meta">${meta}</span></div>` +
    warning +
    (loose.length ? `<div class="pd-ai-general">${loose.map(t => renderLooseThread(t, isOpen(t.id), reply)).join("")}</div>` : "") +
    `</div>`;
}

function counts(review: AiReview): string {
  const by = (s: AiComment["status"]) => review.comments.filter(c => c.status === s).length;
  const parts = [`${review.comments.length} comment${review.comments.length === 1 ? "" : "s"}`];
  const pending = by("pending");
  if (pending) parts.push(`<strong>${pending} to triage</strong>`);
  if (by("kept")) parts.push(`${by("kept")} kept`);
  if (by("discarded")) parts.push(`${by("discarded")} discarded`);
  return parts.join(" · ");
}

export interface PanelInput {
  reviews: AiReview[];
  mine: UserReview;
  headSha: string;
  armedDiscard: string | null;
  /** Why the user's comments could not be read, if they could not. */
  notice: string | null;
  /** The GitHub block, drawn by renderGhPanel. */
  github: string;
  /** Editors whose lines changed after a reload, drawn by renderDraft. */
  drafts: string;
  /** True for comments shown here rather than under a line. */
  inPanel: (ref: CardRef) => boolean;
  card: (ref: CardRef) => string;
}

/**
 * Above the files: the user's comments first, with those that have no line to
 * hang under, then GitHub's conversations without a line in this diff, then
 * one block per agent with its summary and its comments without a line.
 */
export interface PublishState {
  /** GitHub refuses a verdict on one's own pull request. */
  ownPr: boolean;
  busy: boolean;
  /** What the last publish did, as markup. */
  note: string;
}

const OWN_PR = "GitHub doesn't let you approve or request changes on your own pull request.";

/**
 * Comment, Request changes, Approve: one click publishes, as GitHub's submit.
 * A button that cannot work says why on hover (aria-disabled keeps the tooltip
 * that a disabled button would lose) and in the note when clicked.
 */
export function renderPublishButtons(state: PublishState, count: number, hasSummary: boolean): string {
  const button = (event: string, label: string, primary: boolean, why: string | null) =>
    `<button class="pd-ai-btn${primary ? " pd-ai-btn--primary" : ""}" type="button" data-pd-publish="${event}"` +
    (why ? ` aria-disabled="true" title="${escHtml(why)}"` : "") + `>${label}</button>`;
  const busy = state.busy ? "Publishing…" : null;
  return `<div class="pd-publish" data-pd-publish-row>` +
    button("COMMENT", busy ?? (count ? `Comment · ${count}` : "Comment"), true,
      busy ?? (count || hasSummary ? null : "Nothing to publish yet: comment on some lines, or write a summary.")) +
    button("REQUEST_CHANGES", "Request changes", false,
      busy ?? (state.ownPr ? OWN_PR : hasSummary ? null : "Write a summary first: GitHub needs a text to request changes.")) +
    button("APPROVE", "Approve", false, busy ?? (state.ownPr ? OWN_PR : null)) +
    (state.note ? `<span class="pd-publish__note">${state.note}</span>` : "") +
    `</div>`;
}

/** What "Publish review" opens, under the top bar: the review's text and its verdict. */
export function renderPublishPanel(mine: UserReview, summary: string, state: PublishState): string {
  const count = mine.comments.length + mine.replies.length;
  const comments = mine.comments.length;
  const replies = mine.replies.length;
  const written = [
    comments ? `${comments} comment${comments === 1 ? "" : "s"}` : "",
    replies ? `${replies} repl${replies === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean).join(" and ");
  // Comments with no line to sit on join the review's text when it is published.
  const lineless = mine.comments.filter(c => c.placement === "general" || !c.path || c.line === null).length;
  return `<div class="pd-publish-pop__head">` +
      `<strong>Publish your review</strong>` +
      `<span>${written ? `${written} go out as one review` : "Nothing written yet: an approval needs no comment"}</span>` +
    `</div>` +
    `<div class="pd-summary" data-pd-card="summary">` +
      `<textarea class="pd-ai-edit" data-pd-review-text${state.busy ? " readonly" : ""} rows="${Math.min(10, Math.max(3, summary.split("\n").length + 1))}" ` +
        `placeholder="Summary — optional; it heads your review on GitHub">${escHtml(summary)}</textarea>` +
      (lineless
        ? `<div class="pd-summary__note">${lineless} comment${lineless === 1 ? "" : "s"} with no line ${lineless === 1 ? "joins" : "join"} this text.</div>`
        : "") +
    `</div>` +
    renderPublishButtons(state, count, summary.trim() !== "");
}

/** The top bar's way in, with what is waiting to go out. */
export function renderPublishOpen(count: number, open: boolean): string {
  return `Publish review${count ? `<span class="pd-publish-open__count">${count}</span>` : ""}` +
    `<span class="pd-publish-open__caret" aria-hidden="true">${open ? "▴" : "▾"}</span>`;
}

export function renderPanel(p: PanelInput): string {
  const own = p.mine.comments.map((comment): CardRef => ({ kind: "user", comment }));
  const ownHere = own.filter(p.inPanel);
  const notice = p.notice ? `<div class="pd-ai-outdated">${escHtml(p.notice)}</div>` : "";
  // What the user wrote that has no line here: outdated, or about no line at all.
  const replies = p.mine.replies.length;
  const written = [
    own.length ? `${own.length} comment${own.length === 1 ? "" : "s"}` : "",
    replies ? `${replies} repl${replies === 1 ? "y" : "ies"}` : "",
  ].filter(Boolean).join(" and ");
  const yours = ownHere.length || p.drafts || notice
    ? `<div class="pd-ai-panel pd-ai-panel--mine">` +
        `<div class="pd-ai-panel__head">` +
          `<span class="pd-you">You</span>` +
          `<span class="pd-ai-panel__meta">${written ? `${written} · ` : ""}not on a line of this diff, below · publish from the top bar</span>` +
        `</div>` +
        notice +
        (ownHere.length || p.drafts
          ? `<div class="pd-ai-general">${p.drafts}${ownHere.map(p.card).join("")}</div>`
          : "") +
      `</div>`
    : own.length ? "" : `<div class="pd-hint">Click a line number to comment on that line, or drag across line numbers to comment on a block.</div>`;

  if (p.reviews.length === 0) {
    return yours + p.github +
      `<div class="pd-ai-panel pd-ai-panel--empty">` +
      `<span>No AI review yet. Ask an agent with the ZuGit MCP to review this PR — its comments land here, and nothing is posted to GitHub. ${escHtml(READ_ONLY_HINT)}</span>` +
      `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pd-copy-prompt>Copy review prompt</button>` +
      `</div>`;
  }
  return yours + p.github + p.reviews.map(review => {
    const here = review.comments
      .filter(c => c.status !== "kept")
      .map((comment): CardRef => ({ kind: "ai", review, comment }))
      .filter(p.inPanel);
    const outdated = isOutdated(review, p.headSha);
    const armed = p.armedDiscard === review.source;
    return `<div class="pd-ai-panel" data-pd-ai-review="${escHtml(review.source)}">` +
      `<div class="pd-ai-panel__head">` +
        `<span class="pd-ai-agent">${escHtml(agentLabel(review.source))}</span>` +
        `<span class="pd-ai-panel__meta">reviewed <code>${escHtml(review.headSha.slice(0, 7))}</code> · ${escHtml(relativeTime(review.createdAt))} · ${counts(review)}</span>` +
        `<div class="rd-spacer"></div>` +
        `<button class="pd-ai-btn${armed ? " pd-ai-btn--danger" : ""}" type="button" data-pd-ai-discard="${escHtml(review.source)}">${armed ? "Click again to discard" : "Discard review"}</button>` +
      `</div>` +
      (outdated ? `<div class="pd-ai-outdated">Made on an older commit — the PR has new pushes since, so some comments may point at moved lines.</div>` : "") +
      (review.summary ? `<div class="pd-ai-summary">${renderMarkdown(review.summary)}</div>` : "") +
      (here.length ? `<div class="pd-ai-general">${here.map(p.card).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}
