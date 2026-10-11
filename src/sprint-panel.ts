/**
 * The Sprint tab's side panel: a story's detail (fields, PRs, checklist,
 * description, sub-tasks, comments) or the stories of a personal category.
 * One panel, two contents — opening a story from a category keeps a way back.
 */

import { invoke } from "@tauri-apps/api/core";
import { escHtml, errorMessage, SVG } from "./utils";
import { openExternal } from "./api";
import { openPrDiff } from "./pr-diff";
import { adfToHtml, type MediaRef } from "./adf";
import { closeLightbox, openLightbox, type LightboxItem } from "./sprint-lightbox";
import * as M from "./sprint-model";
import type { ChecklistItem } from "./state";
import type { PullRequestSummary } from "./shared/pr-model";
import { MOD_KEY, openMenu, showToast } from "./sprint-ui";
import {
  sp, ICON, avatar, issueByKey, inSprint, prsFor, columnName, columnCategory, categoryById,
  openInJira, browseUrl, openStatusMenu, openAssignMenu, openCategoryMenu, setPoints,
  fileInCategory, renameCategory, recolorCategory, deleteCategory, addComment, rerender, writePref,
  flagMeaning, openFlagMenu, dropFromCategory,
} from "./sprint-store";

type Load<T> = { status: "loading" } | { status: "ok"; value: T } | { status: "error"; error: string };

const details = new Map<string, Load<M.IssueDetail>>();
const checklists = new Map<string, Load<ChecklistItem[]>>();
const commentDrafts = new Map<string, string>();
const expandedComments = new Set<string>();
const expandedDescriptions = new Set<string>();
let editingPoints: string | null = null;
/** Categories whose stories outside the sprint are shown (they are hidden by default). */
const expandedOutside = new Set<string>();
/** Reading the outside stories of a category: "ok" lets a missing key mean "not on Jira". */
const outsideStatus = new Map<string, "loading" | "ok" | "failed">();

// ── Opening and closing ──────────────────────────────────────────────────────

export function openIssue(key: string, fromCategory: string | null = null) {
  sp.panel = { kind: "issue", key, fromCategory };
  editingPoints = null;
  void ensureDetail(key);
  void ensureChecklist(key);
  rerender();
}

export function openCategory(id: string) {
  sp.panel = { kind: "category", id };
  rerender();
  if (expandedOutside.has(id)) void ensureOutside(id);
}

export function closePanel() {
  sp.panel = null;
  editingPoints = null;
  closeLightbox();
  rerender();
}

/** Forget what was read: the next opening reads Jira again. */
export function forgetDetails() {
  details.clear();
  checklists.clear();
  outsideStatus.clear();
}

async function ensureDetail(key: string, force = false) {
  const hit = details.get(key);
  if (!force && hit && hit.status !== "error") return;
  details.set(key, { status: "loading" });
  try {
    const value = await invoke<M.IssueDetail>("sprint_issue_detail", { key });
    details.set(key, { status: "ok", value });
  } catch (error) {
    details.set(key, { status: "error", error: errorMessage(error, "Dettaglio non disponibile.") });
  }
  if (sp.panel?.kind === "issue" && sp.panel.key === key) renderPanel();
}

async function ensureChecklist(key: string) {
  if (checklists.has(key)) return;
  checklists.set(key, { status: "loading" });
  try {
    const value = await invoke<ChecklistItem[]>("fetch_draft_checklist", { jiraKey: key });
    checklists.set(key, { status: "ok", value });
  } catch (error) {
    checklists.set(key, { status: "error", error: errorMessage(error, "Checklist non disponibile.") });
  }
  if (sp.panel?.kind === "issue" && sp.panel.key === key) renderPanel();
}

/** Category stories outside the sprint are read by key when their list is
 *  opened: they are remembered, not shown, so most of the time never read. */
async function ensureOutside(id: string) {
  const category = categoryById(id);
  const status = outsideStatus.get(id);
  if (!category || status === "loading" || status === "ok") return;
  const missing = category.keys.filter((key) => !inSprint(key) && !sp.outside.has(key));
  outsideStatus.set(id, "loading");
  try {
    if (missing.length) {
      const found = await invoke<M.SprintIssue[]>("sprint_issues_by_keys", { keys: missing });
      for (const issue of found) sp.outside.set(issue.key, issue);
    }
    outsideStatus.set(id, "ok");
  } catch {
    // Shown as plain keys: the category still works without the details.
    outsideStatus.set(id, "failed");
  }
  if (sp.panel?.kind === "category" && sp.panel.id === id) renderPanel();
}

// ── Attachments ──────────────────────────────────────────────────────────────
// Jira serves attachments only with credentials, which an <img> cannot send:
// the backend downloads them and the panel shows them through blob URLs.
// Pictures are shown from the original file: Jira's thumbnails are scaled
// down and soft, unreadable for a screenshot. The thumbnail is only a fallback
// for files too large to download into the panel.

/** `${id}:${kind}` → object URL and size, least recently used first.
 *  Attachments never change, so an entry stays valid for the session. */
const blobUrls = new Map<string, { url: string; size: number }>();
const blobLoads = new Map<string, Promise<string>>();
let blobBytes = 0;
/** Originals add up over a long session: past this, the pictures no longer
 *  on screen are let go (and read again if they come back). */
const BLOB_BUDGET = 200 * 1024 * 1024;

function cachedUrl(key: string): string | undefined {
  const entry = blobUrls.get(key);
  if (!entry) return undefined;
  // Re-inserted: it moves to the recently used end.
  blobUrls.delete(key);
  blobUrls.set(key, entry);
  return entry.url;
}

function remember(key: string, url: string, size: number) {
  blobUrls.set(key, { url, size });
  blobBytes += size;
  if (blobBytes <= BLOB_BUDGET) return;
  for (const [oldKey, entry] of blobUrls) {
    if (blobBytes <= BLOB_BUDGET * 0.75) break;
    if (oldKey === key || document.querySelector(`img[src="${CSS.escape(entry.url)}"]`)) continue;
    URL.revokeObjectURL(entry.url);
    blobUrls.delete(oldKey);
    blobBytes -= entry.size;
  }
}
const waiting: (() => void)[] = [];
let downloading = 0;

/** Four downloads at a time: a story with twenty screenshots stays polite. */
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      downloading += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          downloading -= 1;
          waiting.shift()?.();
        });
    };
    if (downloading < 4) run();
    else waiting.push(run);
  });
}

function loadAttachment(id: string, kind: "thumb" | "full"): Promise<string> {
  const key = `${id}:${kind}`;
  const ready = cachedUrl(key);
  if (ready) return Promise.resolve(ready);
  let pending = blobLoads.get(key);
  if (!pending) {
    pending = limited(() => invoke<ArrayBuffer>("sprint_attachment", { id, thumbnail: kind === "thumb" }))
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        const url = URL.createObjectURL(new Blob([bytes], { type: M.sniffImageType(bytes) ?? "" }));
        remember(key, url, bytes.byteLength);
        return url;
      })
      .finally(() => blobLoads.delete(key));
    blobLoads.set(key, pending);
  }
  return pending;
}

/** A picture at its own quality; Jira's thumbnail only when the original
 *  cannot be had (over the size limit, or the download failed). */
function loadPicture(id: string): Promise<string> {
  return loadAttachment(id, "full").catch(() => loadAttachment(id, "thumb"));
}

/** The picture already in memory, if any: the original, else its thumbnail. */
function pictureUrl(id: string): string | undefined {
  return cachedUrl(`${id}:full`) ?? cachedUrl(`${id}:thumb`);
}

function attachmentBrowserUrl(att: { id: string; filename: string }): string {
  const site = sp.data?.siteUrl ?? "";
  return `${site}/secure/attachment/${encodeURIComponent(att.id)}/${encodeURIComponent(att.filename)}`;
}

/** Media nodes of this story's documents, resolved for the ADF renderer. */
function mediaResolver(detail: M.IssueDetail) {
  return (attrs: Record<string, unknown>): MediaRef | null => {
    const att = M.attachmentForMedia(attrs, detail);
    if (!att) return null;
    // Paired with an attachment Jira did not list: the bytes will tell.
    const image = att.mimeType ? M.isPreviewable(att.mimeType) : true;
    return {
      id: att.id,
      filename: att.filename,
      image,
      sizeLabel: att.size ? M.formatBytes(att.size) : undefined,
      src: image ? pictureUrl(att.id) : undefined,
    };
  };
}

/** The story's pictures, for the full-size view: those in the text first,
 *  in reading order, then the other attached ones. */
function pictures(detail: M.IssueDetail, el: HTMLElement): LightboxItem[] {
  const items: LightboxItem[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const att = detail.attachments.find((a) => a.id === id);
    items.push({ id, filename: att?.filename ?? "Immagine", size: att?.size ?? 0 });
  };
  el.querySelectorAll<HTMLElement>(".adf [data-att-img]").forEach((holder) => add(holder.dataset.attImg ?? ""));
  for (const att of detail.attachments) if (M.isPreviewable(att.mimeType)) add(att.id);
  return items.filter((item) => item.id);
}

function attachmentsSection(detail: M.IssueDetail): string {
  if (detail.attachments.length === 0) return "";
  const images = detail.attachments.filter((att) => M.isPreviewable(att.mimeType));
  const files = detail.attachments.filter((att) => !M.isPreviewable(att.mimeType));
  return `<section class="sp-sec">
    <h3 class="sp-sec-title">Allegati <span>${detail.attachments.length}</span></h3>
    ${images.length
      ? `<div class="sp-att-grid">${images
          .map((att) => {
            const src = pictureUrl(att.id);
            return `<button type="button" class="sp-att-tile${src ? "" : " is-loading"}" data-att-img="${escHtml(att.id)}" title="${escHtml(`${att.filename} · ${M.formatBytes(att.size)}`)}">
              ${src ? `<img src="${escHtml(src)}" alt="" draggable="false">` : ""}
              <span class="sp-att-cap">${escHtml(att.filename)}</span>
            </button>`;
          })
          .join("")}</div>`
      : ""}
    ${files.length
      ? `<div class="sp-att-files">${files
          .map(
            (att) => `<button type="button" class="sp-att-file" data-att-file="${escHtml(att.id)}" title="Apri nel browser">
              <span class="sp-att-file-icon">${FILE_ICON}</span>
              <span class="sp-att-file-name">${escHtml(att.filename)}</span>
              <span class="sp-att-file-meta">${escHtml([M.formatBytes(att.size), att.author ?? ""].filter(Boolean).join(" · "))}</span>
              <span class="sp-att-file-open">${ICON.external}</span>
            </button>`,
          )
          .join("")}</div>`
      : ""}
  </section>`;
}

const FILE_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5Z"/><path d="M8 1.5V5h3.5"/></svg>`;

/** A picture that cannot be shown becomes a link to the file. */
function pictureFailed(holder: HTMLElement) {
  holder.classList.remove("is-loading");
  holder.classList.add("is-failed");
  holder.dataset.attFailed = "";
  holder.title = "Anteprima non disponibile: apri il file nel browser";
}

function placePicture(holder: HTMLElement, url: string) {
  holder.classList.remove("is-loading");
  const img = document.createElement("img");
  img.src = url;
  img.alt = holder.title;
  img.draggable = false;
  holder.insertBefore(img, holder.firstChild);
}

/** Fills the picture holders still waiting, as their downloads land. */
function hydratePictures(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-att-img].is-loading").forEach((holder) => {
    const id = holder.dataset.attImg ?? "";
    if (!id) return;
    loadPicture(id)
      .then((url) => {
        if (!holder.isConnected || !holder.classList.contains("is-loading")) return;
        placePicture(holder, url);
        updateDescriptionClamp(el);
      })
      .catch(() => {
        if (holder.isConnected) pictureFailed(holder);
      });
  });
}

function updateDescriptionClamp(el: HTMLElement) {
  const desc = el.querySelector<HTMLElement>("[data-sp-desc]");
  const toggle = el.querySelector<HTMLElement>("[data-sp-desc-toggle]");
  if (!desc || !toggle) return;
  const expanded = desc.classList.contains("is-expanded");
  const clamped = !expanded && desc.scrollHeight > desc.clientHeight + 4;
  desc.classList.toggle("is-clamped", clamped);
  toggle.hidden = !clamped && !expanded;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relative(iso: string | null): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return "adesso";
  if (minutes < 60) return `${minutes} min fa`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h fa`;
  if (minutes < 2880) return "ieri";
  if (minutes < 10080) return `${Math.floor(minutes / 1440)} g fa`;
  return new Date(at).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

const REVIEW_LABEL: Record<PullRequestSummary["reviewState"], { text: string; tone: string }> = {
  approved: { text: "Approvata", tone: "ok" },
  "approved-stale": { text: "Da riapprovare", tone: "warn" },
  "needs-review": { text: "In review", tone: "neutral" },
  "changes-requested": { text: "Modifiche richieste", tone: "warn" },
};

function prRow(pr: PullRequestSummary): string {
  const review = pr.isDraft ? { text: "Bozza", tone: "neutral" } : REVIEW_LABEL[pr.reviewState];
  const ci =
    pr.hasFailedPipeline || pr.pipelineState === "failure"
      ? `<span class="sp-pr-ci sp-pr-ci--fail" title="CI fallita">CI</span>`
      : pr.pipelineState === "success"
        ? `<span class="sp-pr-ci sp-pr-ci--ok" title="CI verde">CI</span>`
        : pr.pipelineState === "pending"
          ? `<span class="sp-pr-ci sp-pr-ci--pending" title="CI in corso">CI</span>`
          : "";
  return `<button type="button" class="sp-pr" data-sp-pr="${escHtml(`${pr.repo}#${pr.id}`)}" title="Apri il diff">
    <span class="sp-pr-icon">${pr.isDraft ? SVG.draft : SVG.gitpr}</span>
    <span class="sp-pr-main">
      <span class="sp-pr-title">${escHtml(pr.title)}</span>
      <span class="sp-pr-meta">${escHtml(pr.repo.split("/").pop() ?? pr.repo)} #${pr.id} · ${escHtml(pr.author)} · <span class="sp-pr-diff"><b>+${pr.additions}</b> <i>−${pr.deletions}</i></span></span>
    </span>
    <span class="sp-pr-state sp-pr-state--${review.tone}">${review.text}</span>
    ${ci}
  </button>`;
}

function field(label: string, value: string): string {
  return `<dt>${escHtml(label)}</dt><dd>${value}</dd>`;
}

// ── Issue detail ──────────────────────────────────────────────────────────────

function renderIssue(key: string, fromCategory: string | null): string {
  const issue = issueByKey(key);
  const detail = details.get(key);
  const perms = sp.data?.permissions ?? { transition: true, assign: true, edit: true, comment: true };
  const summary = issue?.summary ?? (detail?.status === "ok" ? detail.value.summary : key);
  const type = issue?.issueType ?? (detail?.status === "ok" ? detail.value.issueType : "");
  const back = fromCategory ? categoryById(fromCategory) : null;
  const category = M.categoryOf(key, sp.categories);

  const top = `<header class="sp-panel-top">
    ${back ? `<button type="button" class="sp-back" data-sp-back title="Torna a ${escHtml(back.name)}">${ICON.back}<span class="sp-dot" style="--dot:${escHtml(back.color)}"></span>${escHtml(back.name)}</button><span class="sp-top-sep"></span>` : ""}
    ${type ? `<span class="sp-type">${escHtml(type)}</span>` : ""}
    <button type="button" class="sp-panel-key" data-sp-copy="${escHtml(key)}" title="Copia la chiave">${escHtml(key)}</button>
    <span class="sp-grow"></span>
    ${back ? "" : `<button type="button" class="sp-icon-btn" data-sp-step="-1" title="Storia precedente (k)" aria-label="Storia precedente">${ICON.up}</button>
    <button type="button" class="sp-icon-btn" data-sp-step="1" title="Storia successiva (j)" aria-label="Storia successiva">${ICON.down}</button>`}
    <button type="button" class="sp-btn" data-sp-jira title="Apri in Jira">Jira ${ICON.external}</button>
    <button type="button" class="sp-icon-btn" data-sp-close title="Chiudi (Esc)" aria-label="Chiudi">${ICON.close}</button>
  </header>`;

  const banners: string[] = [];
  if (category) {
    banners.push(`<div class="sp-banner"><span class="sp-dot" style="--dot:${escHtml(category.color)}"></span>
      <span>In «${escHtml(category.name)}»: non compare sulla board.</span>
      <button type="button" class="sp-link" data-sp-restore="${escHtml(key)}">Riporta sulla board</button></div>`);
  }
  if (issue && !inSprint(key)) {
    banners.push(`<div class="sp-banner sp-banner--muted">Non è nello sprint che stai guardando.</div>`);
  }
  const props: string[] = [];
  if (issue) {
    const cat = columnCategory(issue);
    props.push(
      field(
        "Stato",
        `<button type="button" class="sp-field" data-sp-act="status"${perms.transition ? "" : " disabled"}>
          <span class="sp-status sp-status--${cat}">${escHtml(issue.statusName)}</span>
          ${columnName(issue) !== issue.statusName ? `<span class="sp-field-muted">${escHtml(columnName(issue))}</span>` : ""}
          ${perms.transition ? `<span class="sp-field-chev">${ICON.chevron}</span>` : ""}
        </button>`,
      ),
    );
    props.push(
      field(
        "Assegnatario",
        `<button type="button" class="sp-field" data-sp-act="assign"${perms.assign ? "" : " disabled"}>
          ${avatar(issue.assignee, 20)}
          <span>${issue.assignee ? escHtml(issue.assignee.displayName) : `<span class="sp-field-muted">Non assegnata</span>`}</span>
          ${perms.assign ? `<span class="sp-field-chev">${ICON.chevron}</span>` : ""}
        </button>`,
      ),
    );
    const canEditPoints = perms.edit && !!sp.data?.pointsField;
    props.push(
      field(
        "Punti",
        editingPoints === key
          ? `<input class="sp-points-input" data-sp-points-input type="text" inputmode="decimal" value="${issue.points === null ? "" : escHtml(String(issue.points))}" placeholder="—" aria-label="Punti">`
          : `<button type="button" class="sp-field sp-field--mono" data-sp-act="points"${canEditPoints ? "" : " disabled"} title="${canEditPoints ? "Modifica la stima" : "Stima in sola lettura"}">
              ${issue.points === null ? `<span class="sp-field-muted">Senza stima</span>` : `${escHtml(M.formatPoints(issue.points))} pt`}
            </button>`,
      ),
    );
    props.push(
      field(
        "Categoria",
        `<button type="button" class="sp-field" data-sp-act="category">
          ${category ? `<span class="sp-dot" style="--dot:${escHtml(category.color)}"></span>${escHtml(category.name)}` : `<span class="sp-field-muted">Nessuna · sulla board</span>`}
          <span class="sp-field-chev">${ICON.chevron}</span>
        </button>`,
      ),
    );
    if (issue.flagged) {
      props.push(
        field(
          "Flag",
          `<button type="button" class="sp-field" data-sp-flag-meaning title="Cambia il nome del flag su questa board">
            <span class="sp-flag">${ICON.flag}</span>${escHtml(flagMeaning().label)}
          </button>`,
        ),
      );
    }
    if (issue.epic) props.push(field("Epic", `<span class="sp-epic">${escHtml(issue.epic)}</span>`));
    if (issue.fixVersions.length) {
      props.push(field("Release", issue.fixVersions.map((v) => `<span class="sp-tag">${escHtml(v)}</span>`).join("")));
    }
    if (issue.priority) props.push(field("Priorità", `<span class="sp-plain">${escHtml(issue.priority)}</span>`));
    if (issue.labels.length) {
      props.push(field("Etichette", issue.labels.map((l) => `<span class="sp-tag sp-tag--soft">${escHtml(l)}</span>`).join("")));
    }
  }

  const sections: string[] = [];

  const linked = prsFor(key);
  sections.push(`<section class="sp-sec">
    <h3 class="sp-sec-title">Pull request aperte${linked.length ? ` <span>${linked.length}</span>` : ""}</h3>
    ${linked.length ? `<div class="sp-prs">${linked.map(prRow).join("")}</div>` : `<p class="sp-empty">Nessuna PR aperta collegata a ${escHtml(key)}.</p>`}
  </section>`);

  const checklist = checklists.get(key);
  if (checklist?.status === "ok" && checklist.value.length) {
    const doneCount = checklist.value.filter((item) => item.done).length;
    const pct = Math.round((doneCount / checklist.value.length) * 100);
    sections.push(`<section class="sp-sec">
      <h3 class="sp-sec-title">Checklist <span>${doneCount}/${checklist.value.length}</span></h3>
      <div class="sp-progress"><i style="width:${pct}%"></i></div>
      <ul class="sp-checklist">${checklist.value
        .map(
          (item, index) => `<li><label class="sp-check${item.done ? " is-done" : ""}">
            <input type="checkbox" data-sp-check="${index}"${item.done ? " checked" : ""}${perms.edit ? "" : " disabled"}>
            <span>${escHtml(item.text)}</span></label></li>`,
        )
        .join("")}</ul>
    </section>`);
  }

  if (!detail || detail.status === "loading") {
    sections.push(`<section class="sp-sec"><div class="sp-skeleton"></div><div class="sp-skeleton sp-skeleton--short"></div><div class="sp-skeleton"></div></section>`);
  } else if (detail.status === "error") {
    sections.push(`<section class="sp-sec"><p class="sp-error">${escHtml(detail.error)} <button type="button" class="sp-link" data-sp-retry>Riprova</button></p></section>`);
  } else {
    const d = detail.value;
    const media = mediaResolver(d);
    const description = adfToHtml(d.description, { media });
    const expanded = expandedDescriptions.has(key);
    sections.push(`<section class="sp-sec">
      <h3 class="sp-sec-title">Descrizione</h3>
      ${description
        ? `<div class="sp-desc adf${expanded ? " is-expanded" : ""}" data-sp-desc>${description}</div>
           <button type="button" class="sp-link sp-desc-toggle" data-sp-desc-toggle hidden>${expanded ? "Mostra meno" : "Mostra tutto"}</button>`
        : `<p class="sp-empty">Nessuna descrizione.</p>`}
    </section>`);

    sections.push(attachmentsSection(d));

    if (d.subtasks.length) {
      const doneCount = d.subtasks.filter((t) => t.statusCategory === "done").length;
      sections.push(`<section class="sp-sec">
        <h3 class="sp-sec-title">Sottotask <span>${doneCount}/${d.subtasks.length}</span></h3>
        <div class="sp-subtasks">${d.subtasks
          .map(
            (task) => `<button type="button" class="sp-subtask" data-sp-subtask="${escHtml(task.key)}" title="Apri in Jira">
              <span class="sp-status-dot sp-status-dot--${escHtml(task.statusCategory || "indeterminate")}"></span>
              <span class="sp-key">${escHtml(task.key)}</span>
              <span class="sp-subtask-title${task.statusCategory === "done" ? " is-done" : ""}">${escHtml(task.summary)}</span>
              <span class="sp-subtask-status">${escHtml(task.statusName)}</span>
            </button>`,
          )
          .join("")}</div>
      </section>`);
    }

    const newestFirst = [...d.comments].reverse();
    const showAll = expandedComments.has(key);
    const visible = showAll ? newestFirst : newestFirst.slice(0, 3);
    const hiddenCount = newestFirst.length - visible.length;
    const older = d.commentTotal - d.comments.length;
    sections.push(`<section class="sp-sec">
      <h3 class="sp-sec-title">Commenti${d.commentTotal ? ` <span>${d.commentTotal}</span>` : ""}</h3>
      ${perms.comment
        ? `<form class="sp-composer" data-sp-composer>
            <textarea data-sp-comment rows="1" placeholder="Scrivi un commento…">${escHtml(commentDrafts.get(key) ?? "")}</textarea>
            <div class="sp-composer-bar"><span class="sp-composer-hint">${MOD_KEY === "⌘" ? "⌘↵" : "Ctrl+Invio"} per inviare</span><button type="submit" class="sp-btn sp-btn--primary" data-sp-comment-send>Commenta</button></div>
          </form>`
        : ""}
      ${visible
        .map(
          (comment) => `<article class="sp-comment">
            ${avatar(comment.author, 22)}
            <div class="sp-comment-main">
              <div class="sp-comment-head"><b>${escHtml(comment.author?.displayName ?? "Utente")}</b><span>${escHtml(relative(comment.created))}</span></div>
              <div class="sp-comment-body adf">${adfToHtml(comment.body, { media }) || `<p class="sp-empty">—</p>`}</div>
            </div>
          </article>`,
        )
        .join("")}
      ${hiddenCount > 0 ? `<button type="button" class="sp-link" data-sp-more-comments>Mostra altri ${hiddenCount}</button>` : ""}
      ${older > 0 && (showAll || hiddenCount === 0) ? `<button type="button" class="sp-link" data-sp-jira>Altri ${older} commenti in Jira</button>` : ""}
      ${!d.commentTotal && !perms.comment ? `<p class="sp-empty">Nessun commento.</p>` : ""}
    </section>`);
  }

  return `${top}
  <div class="sp-panel-body" data-sp-panel-body>
    ${banners.join("")}
    <h2 class="sp-panel-title">${escHtml(summary)}</h2>
    ${props.length ? `<dl class="sp-props">${props.join("")}</dl>` : ""}
    ${sections.join("")}
  </div>`;
}

// ── Category ──────────────────────────────────────────────────────────────────

function categoryRow(key: string, categoryId: string, inSprintNow: boolean): string {
  const issue = issueByKey(key);
  const status = issue ? `<span class="sp-cat-status">${escHtml(issue.statusName)}</span>` : "";
  // In the sprint the story goes back on the board; outside it, it just leaves the category.
  const action = inSprintNow
    ? `<button type="button" class="sp-icon-btn sp-cat-restore" data-sp-restore="${escHtml(key)}" title="Riporta sulla board" aria-label="Riporta ${escHtml(key)} sulla board">${ICON.undo}</button>`
    : `<button type="button" class="sp-icon-btn sp-cat-restore" data-sp-uncategorize="${escHtml(key)}" title="Togli dalla categoria" aria-label="Togli ${escHtml(key)} dalla categoria">${ICON.close}</button>`;
  const title = issue
    ? escHtml(issue.summary)
    : `<span class="sp-field-muted">${outsideStatus.get(categoryId) === "ok" ? "Non trovata su Jira" : "…"}</span>`;
  return `<div class="sp-cat-row" data-sp-open="${escHtml(key)}" data-sp-from="${escHtml(categoryId)}" role="button" tabindex="0">
    ${avatar(issue?.assignee ?? null, 22)}
    <span class="sp-key">${escHtml(key)}</span>
    <span class="sp-cat-title">${title}</span>
    ${status}
    ${action}
  </div>`;
}

/** Outside the sprint and over for good: closed on Jira, or no longer there. */
function staleKeys(id: string, outside: string[]): string[] {
  const loaded = outsideStatus.get(id) === "ok";
  return outside.filter((key) => {
    const issue = sp.outside.get(key);
    return issue ? issue.statusCategory === "done" : loaded;
  });
}

function renderCategory(id: string): string {
  const category = categoryById(id);
  if (!category) {
    return `<header class="sp-panel-top"><span class="sp-grow"></span><button type="button" class="sp-icon-btn" data-sp-close aria-label="Chiudi">${ICON.close}</button></header>
      <div class="sp-panel-body"><p class="sp-empty">Categoria eliminata.</p></div>`;
  }
  const current = category.keys.filter(inSprint);
  const outside = category.keys.filter((key) => !inSprint(key));
  const showOutside = expandedOutside.has(id);
  const stale = showOutside ? staleKeys(id, outside) : [];
  const loading = outsideStatus.get(id) === "loading";
  return `<header class="sp-panel-top">
    <span class="sp-dot sp-dot--lg" style="--dot:${escHtml(category.color)}"></span>
    <h2 class="sp-panel-cat-name">${escHtml(category.name)}</h2>
    <span class="sp-count" title="${current.length} nello sprint${outside.length ? `, ${outside.length} ricordate fuori` : ""}">${current.length}</span>
    <span class="sp-grow"></span>
    <button type="button" class="sp-icon-btn" data-sp-cat-more title="Modifica la categoria" aria-label="Modifica la categoria">${ICON.more}</button>
    <button type="button" class="sp-icon-btn" data-sp-close title="Chiudi (Esc)" aria-label="Chiudi">${ICON.close}</button>
  </header>
  <div class="sp-panel-body" data-sp-panel-body>
    <p class="sp-panel-note">Fuori dalla board, dai totali e dal riepilogo; il loro stato qui non conta. La categoria è solo tua: resta su questo computer.</p>
    ${category.keys.length === 0
      ? `<div class="sp-cat-empty">
          <p><b>Nessuna storia</b></p>
          <p>Trascina una storia sul chip «${escHtml(category.name)}» in alto, oppure selezionane alcune con ${MOD_KEY}-clic e scegli «Categoria».</p>
        </div>`
      : ""}
    ${current.length
      ? `<div class="sp-cat-group"><h3 class="sp-sec-title">In questo sprint <span>${current.length}</span></h3>${current.map((key) => categoryRow(key, id, true)).join("")}</div>`
      : category.keys.length
        ? `<p class="sp-empty">Nessuna storia di «${escHtml(category.name)}» è in questo sprint.</p>`
        : ""}
    ${outside.length
      ? `<div class="sp-cat-outside">
          <button type="button" class="sp-cat-outside-toggle" data-sp-outside-toggle aria-expanded="${showOutside}">
            <span class="sp-chev${showOutside ? " is-up" : ""}">${ICON.chevron}</span>
            ${outside.length === 1 ? "1 ricordata" : `${outside.length} ricordate`}, fuori da questo sprint
          </button>
          ${showOutside
            ? `<p class="sp-cat-hint">Restano nella categoria ma non si vedono: appena rientrano in uno sprint tornano qui sopra, sempre fuori dalla board.${stale.length ? ` <button type="button" class="sp-link" data-sp-prune>Togli ${stale.length === 1 ? "la chiusa" : `le ${stale.length} chiuse`}</button>` : ""}</p>
               ${loading ? `<div class="sp-skeleton"></div><div class="sp-skeleton sp-skeleton--short"></div>` : outside.map((key) => categoryRow(key, id, false)).join("")}`
            : ""}
        </div>`
      : ""}
  </div>`;
}

function openCategoryActions(anchor: HTMLElement, id: string) {
  const category = categoryById(id);
  if (!category) return;
  openMenu(
    anchor,
    [
      { kind: "title", label: "Nome" },
      { kind: "input", placeholder: "Nome della categoria", value: category.name, submitLabel: "Salva", onSubmit: (name) => renameCategory(id, name) },
      { kind: "title", label: "Colore" },
      { kind: "swatches", colors: M.CATEGORY_COLORS, selected: category.color, onSelect: (color) => recolorCategory(id, color) },
      { kind: "sep" },
      {
        label: "Elimina categoria",
        danger: true,
        hint: category.keys.length ? `${category.keys.length} tornano sulla board` : undefined,
        onSelect: () => deleteCategory(id),
      },
    ],
    { width: 260 },
  );
}

// ── Width ─────────────────────────────────────────────────────────────────────
// The left edge drags. The width chosen is kept as it is; CSS shows
// min(width, 90vw) (`--sp-panel-cur`), so a wide panel set on a big screen
// shrinks on a laptop's and comes back on the big one.

const PANEL_DEFAULT_WIDTH = 460;
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_SHARE = 0.9;
const PANEL_KEY_STEP = 32;

function sprintRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sprint-root]");
}

function clampPanelWidth(width: number): number {
  const max = Math.max(PANEL_MIN_WIDTH, Math.floor(window.innerWidth * PANEL_MAX_SHARE));
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), max));
}

/** Width on screen right now (the CSS clamp included). */
function panelWidthNow(): number {
  return host()?.getBoundingClientRect().width || PANEL_DEFAULT_WIDTH;
}

export function applyPanelWidth() {
  sprintRoot()?.style.setProperty("--sp-panel-w", `${sp.panelWidth ?? PANEL_DEFAULT_WIDTH}px`);
}

function setPanelWidth(width: number | null) {
  sp.panelWidth = width === null ? null : clampPanelWidth(width);
  writePref("panelWidth", sp.panelWidth === null ? null : String(sp.panelWidth));
  applyPanelWidth();
  host()?.querySelector("[data-sp-resize]")?.setAttribute("aria-valuenow", String(Math.round(panelWidthNow())));
}

function resizeHandle(): string {
  const max = Math.max(PANEL_MIN_WIDTH, Math.floor(window.innerWidth * PANEL_MAX_SHARE));
  return `<div class="sp-resize" data-sp-resize role="separator" aria-orientation="vertical" aria-label="Larghezza del pannello"
    aria-valuemin="${PANEL_MIN_WIDTH}" aria-valuemax="${max}" aria-valuenow="${Math.round(panelWidthNow())}" tabindex="0"
    title="Trascina per cambiare la larghezza · doppio clic per tornare a quella normale"></div>`;
}

function startResize(el: HTMLElement, event: PointerEvent) {
  event.preventDefault();
  // The panel is anchored on the right: its width is that edge minus the pointer.
  const right = el.getBoundingClientRect().right;
  const root = sprintRoot();
  let width = panelWidthNow();
  document.body.classList.add("sp-is-resizing");
  const onMove = (move: PointerEvent) => {
    width = clampPanelWidth(right - move.clientX);
    root?.style.setProperty("--sp-panel-w", `${width}px`);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("sp-is-resizing");
    setPanelWidth(width);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

// ── Render ────────────────────────────────────────────────────────────────────

function host(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sp-panel]");
}

export function renderPanel() {
  const el = host();
  if (!el) return;
  const panel = sp.panel;
  el.classList.toggle("is-open", panel !== null);
  el.setAttribute("aria-hidden", String(panel === null));
  document.querySelector("[data-sprint-root]")?.classList.toggle("has-panel", panel !== null);
  if (!panel) {
    el.innerHTML = "";
    return;
  }

  // Keep the reading position and whatever is being typed across re-renders.
  const body = el.querySelector<HTMLElement>("[data-sp-panel-body]");
  const scroll = body?.scrollTop ?? 0;
  const renderedKey = el.dataset.spPanelFor;
  const active = document.activeElement;
  const focusComment = active instanceof HTMLTextAreaElement && active.matches("[data-sp-comment]");
  const focusHandle = active instanceof HTMLElement && active.matches("[data-sp-resize]");
  const caret = focusComment ? active.selectionStart : null;
  const panelFor = panel.kind === "issue" ? `issue:${panel.key}` : `category:${panel.id}`;

  el.innerHTML = resizeHandle() + (panel.kind === "issue" ? renderIssue(panel.key, panel.fromCategory) : renderCategory(panel.id));
  el.dataset.spPanelFor = panelFor;
  if (focusHandle) el.querySelector<HTMLElement>("[data-sp-resize]")?.focus();

  const newBody = el.querySelector<HTMLElement>("[data-sp-panel-body]");
  if (newBody && renderedKey === panelFor) newBody.scrollTop = scroll;
  updateDescriptionClamp(el);
  hydratePictures(el);
  const textarea = el.querySelector<HTMLTextAreaElement>("[data-sp-comment]");
  if (textarea) autosize(textarea);
  if (focusComment && textarea) {
    textarea.focus();
    if (caret !== null) textarea.setSelectionRange(caret, caret);
  }
  const pointsInput = el.querySelector<HTMLInputElement>("[data-sp-points-input]");
  if (pointsInput) {
    pointsInput.focus();
    pointsInput.select();
  }
}

function autosize(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
}

// ── Events ────────────────────────────────────────────────────────────────────

function commitPoints(input: HTMLInputElement) {
  const key = editingPoints;
  editingPoints = null;
  if (!key) return;
  const raw = input.value.trim().replace(",", ".");
  if (raw === "") {
    void setPoints(key, null);
    return;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1000) {
    showToast("Punti non validi: scrivi un numero, es. 3 o 0,5.", { tone: "danger" });
    renderPanel();
    return;
  }
  void setPoints(key, value);
}

async function sendComment(key: string, form: HTMLElement) {
  const textarea = form.querySelector<HTMLTextAreaElement>("[data-sp-comment]");
  const button = form.querySelector<HTMLButtonElement>("[data-sp-comment-send]");
  const text = textarea?.value.trim() ?? "";
  if (!text || !textarea || !button) {
    textarea?.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Invio…";
  const created = await addComment(key, text);
  if (created) {
    commentDrafts.delete(key);
    const detail = details.get(key);
    if (detail?.status === "ok") {
      detail.value.comments.push(created);
      detail.value.commentTotal += 1;
    }
    showToast(`Commento aggiunto a ${key}`);
    if (sp.panel?.kind === "issue" && sp.panel.key === key) renderPanel();
  } else {
    button.disabled = false;
    button.textContent = "Commenta";
  }
}

async function toggleChecklist(key: string, index: number, done: boolean) {
  const entry = checklists.get(key);
  if (entry?.status !== "ok") return;
  const before = entry.value;
  const items = before.map((item, i) => (i === index ? { ...item, done } : item));
  checklists.set(key, { status: "ok", value: items });
  renderPanel();
  try {
    await invoke("update_jira_checklist", { jiraKey: key, items });
  } catch (error) {
    checklists.set(key, { status: "ok", value: before });
    renderPanel();
    showToast(errorMessage(error, "Checklist non aggiornata."), { tone: "danger" });
  }
}

export function initPanelEvents(step: (delta: number) => void) {
  const el = host();
  if (!el) return;

  el.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && (event.target as Element).closest("[data-sp-resize]")) startResize(el, event);
  });
  el.addEventListener("dblclick", (event) => {
    if ((event.target as Element).closest("[data-sp-resize]")) setPanelWidth(null);
  });

  el.addEventListener("click", (event) => {
    const target = event.target as Element;
    const panel = sp.panel;
    if (!panel) return;

    const link = target.closest<HTMLAnchorElement>("a[data-ext-link]");
    if (link) {
      event.preventDefault();
      void openExternal(link.href);
      return;
    }
    if (target.closest("[data-sp-close]")) return closePanel();
    if (target.closest("[data-sp-back]") && panel.kind === "issue" && panel.fromCategory) {
      return openCategory(panel.fromCategory);
    }
    const stepButton = target.closest<HTMLElement>("[data-sp-step]");
    if (stepButton) return step(Number(stepButton.dataset.spStep));

    const restore = target.closest<HTMLElement>("[data-sp-restore]");
    if (restore) {
      event.stopPropagation();
      fileInCategory([restore.dataset.spRestore ?? ""], null);
      return;
    }
    if (panel.kind === "category") {
      const uncategorize = target.closest<HTMLElement>("[data-sp-uncategorize]");
      if (uncategorize) return dropFromCategory([uncategorize.dataset.spUncategorize ?? ""], panel.id);
      if (target.closest("[data-sp-outside-toggle]")) {
        if (expandedOutside.has(panel.id)) expandedOutside.delete(panel.id);
        else {
          expandedOutside.add(panel.id);
          void ensureOutside(panel.id);
        }
        renderPanel();
        return;
      }
      if (target.closest("[data-sp-prune]")) {
        const category = categoryById(panel.id);
        if (category) dropFromCategory(staleKeys(panel.id, category.keys.filter((key) => !inSprint(key))), panel.id);
        return;
      }
    }
    const open = target.closest<HTMLElement>("[data-sp-open]");
    if (open) return openIssue(open.dataset.spOpen ?? "", open.dataset.spFrom ?? null);

    const more = target.closest<HTMLElement>("[data-sp-cat-more]");
    if (more && panel.kind === "category") return openCategoryActions(more, panel.id);

    if (panel.kind !== "issue") return;
    const key = panel.key;

    const picture = target.closest<HTMLElement>("[data-att-img]");
    const file = target.closest<HTMLElement>("[data-att-file]");
    if (picture || file) {
      const detail = details.get(key);
      if (detail?.status !== "ok") return;
      const id = (picture?.dataset.attImg ?? file?.dataset.attFile) || "";
      const att = detail.value.attachments.find((a) => a.id === id) ?? { id, filename: picture?.title || "allegato" };
      if (file || picture?.dataset.attFailed !== undefined) {
        void openExternal(attachmentBrowserUrl(att));
        return;
      }
      openLightbox(pictures(detail.value, el), id, {
        load: (pictureId) => loadPicture(pictureId),
        cached: (pictureId) => pictureUrl(pictureId),
        browserUrl: (item) => attachmentBrowserUrl(item),
        openExternal: (url) => void openExternal(url),
      });
      return;
    }

    if (target.closest("[data-sp-jira]")) return openInJira(key);
    const flagButton = target.closest<HTMLElement>("[data-sp-flag-meaning]");
    if (flagButton) return openFlagMenu(flagButton);
    const copy = target.closest<HTMLElement>("[data-sp-copy]");
    if (copy) {
      void navigator.clipboard?.writeText(key).then(
        () => showToast(`${key} copiata`),
        () => showToast(browseUrl(key)),
      );
      return;
    }
    const act = target.closest<HTMLButtonElement>("[data-sp-act]");
    if (act && !act.disabled) {
      switch (act.dataset.spAct) {
        case "status": return void openStatusMenu(act, [key]);
        case "assign": return void openAssignMenu(act, [key]);
        case "category": return openCategoryMenu(act, [key]);
        case "points":
          editingPoints = key;
          renderPanel();
          return;
      }
    }
    const pr = target.closest<HTMLElement>("[data-sp-pr]");
    if (pr) {
      const match = prsFor(key).find((p) => `${p.repo}#${p.id}` === pr.dataset.spPr);
      if (match) void openPrDiff(match);
      return;
    }
    const subtask = target.closest<HTMLElement>("[data-sp-subtask]");
    if (subtask) return openInJira(subtask.dataset.spSubtask ?? key);
    if (target.closest("[data-sp-more-comments]")) {
      expandedComments.add(key);
      renderPanel();
      return;
    }
    if (target.closest("[data-sp-desc-toggle]")) {
      if (expandedDescriptions.has(key)) expandedDescriptions.delete(key);
      else expandedDescriptions.add(key);
      renderPanel();
      return;
    }
    if (target.closest("[data-sp-retry]")) void ensureDetail(key, true);
  });

  el.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    const panel = sp.panel;
    if (panel?.kind !== "issue" || !input.matches("[data-sp-check]")) return;
    void toggleChecklist(panel.key, Number(input.dataset.spCheck), input.checked);
  });

  el.addEventListener("input", (event) => {
    const textarea = event.target as HTMLTextAreaElement;
    const panel = sp.panel;
    if (panel?.kind !== "issue" || !textarea.matches("[data-sp-comment]")) return;
    commentDrafts.set(panel.key, textarea.value);
    autosize(textarea);
  });

  el.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = (event.target as Element).closest<HTMLElement>("[data-sp-composer]");
    const panel = sp.panel;
    if (form && panel?.kind === "issue") void sendComment(panel.key, form);
  });

  el.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-sp-resize]")) {
      // ← widens (the panel grows to the left), → narrows, Home resets.
      const delta = event.key === "ArrowLeft" ? PANEL_KEY_STEP : event.key === "ArrowRight" ? -PANEL_KEY_STEP : 0;
      if (delta) setPanelWidth(panelWidthNow() + delta);
      else if (event.key === "Home") setPanelWidth(null);
      else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (target.matches("[data-sp-comment]") && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const form = target.closest<HTMLElement>("[data-sp-composer]");
      const panel = sp.panel;
      if (form && panel?.kind === "issue") void sendComment(panel.key, form);
      return;
    }
    if (target.matches("[data-sp-points-input]")) {
      if (event.key === "Enter") {
        event.preventDefault();
        commitPoints(target as HTMLInputElement);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        editingPoints = null;
        renderPanel();
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && target.matches("[data-sp-open]")) {
      event.preventDefault();
      openIssue(target.dataset.spOpen ?? "", target.dataset.spFrom ?? null);
    }
  });

  // A downloaded file the webview cannot decode (HEIC, a broken PNG…) falls
  // back to a link; inline handlers are not allowed by the CSP.
  el.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      const holder = img.closest<HTMLElement>("[data-att-img]");
      if (!holder) return;
      img.remove();
      pictureFailed(holder);
    },
    true,
  );

  el.addEventListener("focusout", (event) => {
    const target = event.target as HTMLElement;
    if (target.matches("[data-sp-points-input]") && editingPoints) commitPoints(target as HTMLInputElement);
  });
}
