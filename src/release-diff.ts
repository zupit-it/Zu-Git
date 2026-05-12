import { invoke } from "@tauri-apps/api/core";
import { escHtml } from "./utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReleaseDiffItem {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  fixVersion: string;
  prUrl?: string;
  prNumber?: number;
  branch: string;
  author: string;
  initials: string;
  avatarColor: string;
  avatarUrl?: string;
  isPreview: boolean;
  flag?: string; // "no-pr" | "no-jira"
}

interface ReleaseDiffResult {
  done: ReleaseDiffItem[];
  missing: ReleaseDiffItem[];
  extra: ReleaseDiffItem[];
  availableVersions: string[];
  syncedAt: string;
  repo: string;
}

// ── Design tokens ─────────────────────────────────────────────────────────────

const T = {
  ok: "#10965F", okSoft: "#E6F4EC", okBd: "#C7E5D2",
  fail: "#D0352B", failSoft: "#FCE9E7", failBd: "#F2C9C5",
  warn: "#B88217", warnSoft: "#FBF2DC", warnBd: "#F0DDA0",
  accent: "#4F46E5", accentSoft: "#EEF0FF", accentInk: "#3730A3",
  info: "#2563EB", infoSoft: "#DEECFE", infoBd: "#BDD7FC",
  ink: "#15161A", inkSoft: "#4A4C55", inkMuted: "#85858E",
};

// ── SVG icons ─────────────────────────────────────────────────────────────────

const I = {
  check:   `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`,
  x:       `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`,
  minus:   `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h6"/></svg>`,
  plus:    `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`,
  warn:    `<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5L1.5 12.5h11L7 1.5Z"/><path d="M7 5.5v3M7 10.4h.01"/></svg>`,
  ext:     `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5 2H2v8h8V6M7 2h3v3M5.2 6.8l4.6-4.6"/></svg>`,
  branch:  `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/><path d="M3 4.4v3.2M3 4.5C3 6 5 7 7.6 5.8"/></svg>`,
  chev:    `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>`,
  notes:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z"/><path d="M5 6h6M5 9h4"/></svg>`,
  info:    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.5v4M8 5h.01"/></svg>`,
  arrow:   `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>`,
  close:   `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`,
};

// ── Status chip styling ───────────────────────────────────────────────────────

interface StatusStyle { label: string; bg: string; fg: string; bd: string; }
const STATUS_MAP: Record<string, StatusStyle> = {
  "verified":      { label: "Verified",   bg: T.okSoft,   fg: T.ok,       bd: T.okBd },
  "merge-request": { label: "Merge req.", bg: T.accentSoft, fg: T.accentInk, bd: "#C9CDFB" },
  "developed":     { label: "Developed",  bg: T.warnSoft, fg: T.warn,     bd: T.warnBd },
  "in-progress":   { label: "In corso",   bg: T.infoSoft, fg: T.info,     bd: T.infoBd },
  "rejected":      { label: "Rejected",   bg: T.failSoft, fg: T.fail,     bd: T.failBd },
};

function statusStyle(status: string): StatusStyle {
  return STATUS_MAP[status.toLowerCase()] ?? { label: status, bg: "#FBFBF8", fg: T.inkSoft, bd: "#ECEAE2" };
}

// ── Release notes helpers ─────────────────────────────────────────────────────

function cleanTitle(summary: string): string {
  return summary.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
}

function buildReleaseNotes(done: ReleaseDiffItem[]): string {
  const power: ReleaseDiffItem[] = [];
  const bugs: ReleaseDiffItem[] = [];
  for (const item of done) {
    (item.issueType.toLowerCase() === "bug" ? bugs : power).push(item);
  }
  const lines: string[] = [];
  if (power.length > 0) {
    lines.push("⚡ *POWER*:");
    for (const item of power) lines.push(`• \`${item.key}\` ${cleanTitle(item.summary)}`);
  }
  if (bugs.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("🐛 *BUG*:");
    for (const item of bugs) lines.push(`• \`${item.key}\` ${cleanTitle(item.summary)}`);
  }
  return lines.join("\n");
}

// ── Modal state ───────────────────────────────────────────────────────────────

interface ModalState {
  releaseName: string;
  result: ReleaseDiffResult;
  tab: "all" | "done" | "missing" | "extra" | "flagged";
  selected: Set<string>;
  targetVersion: string;
  verDropOpen: boolean;
  notesOpen: boolean;
  applyStatus: string;
}

function isFlagged(item: ReleaseDiffItem, currentVersion: string): boolean {
  return !!item.flag || (!!item.fixVersion && item.fixVersion !== currentVersion && item.fixVersion !== "" && item.fixVersion !== "Unscheduled");
}

function computeCounts(result: ReleaseDiffResult, releaseName: string): { all: number; done: number; missing: number; extra: number; flagged: number } {
  const all = [...result.done, ...result.missing, ...result.extra];
  return {
    all: all.length,
    done: result.done.length,
    missing: result.missing.length,
    extra: result.extra.length,
    flagged: all.filter(it => isFlagged(it, releaseName)).length,
  };
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderStatusChip(status: string): string {
  if (!status) return "";
  const s = statusStyle(status);
  return `<span class="rd-status-chip" style="background:${s.bg};color:${s.fg};border:1px solid ${s.bd}">${escHtml(s.label)}</span>`;
}

function renderFlagChip(flag: string): string {
  const cfg: Record<string, { label: string; hint: string }> = {
    "no-pr":   { label: "Jira ahead of git", hint: "Status is set in Jira but no merged PR was found on main." },
    "no-jira": { label: "Git ahead of Jira", hint: "Merged on main but Jira status hasn't caught up." },
  };
  const c = cfg[flag];
  if (!c) return "";
  return `<span class="rd-flag-chip" title="${escHtml(c.hint)}">${I.warn} ${escHtml(c.label)}</span>`;
}

function renderItem(item: ReleaseDiffItem, kind: "done" | "missing" | "extra", selected: boolean, currentVersion: string): string {
  const selectable = kind !== "done";
  const cbCol = selectable
    ? `<div class="rd-item-cb-col">
        <label class="rd-cb-wrap">
          <span class="rd-cb-box ${selected ? "rd-cb-box--checked" : ""}" data-rd-cbbox="${escHtml(item.key)}">${selected ? I.check : ""}</span>
          <input class="rd-cb-real" type="checkbox" data-rd-key="${escHtml(item.key)}" ${selected ? "checked" : ""} />
        </label>
       </div>`
    : `<div class="rd-item-cb-col"></div>`;

  const keyChip = `<span class="rd-key-chip">${escHtml(item.key)}</span>`;

  const metaBranch = item.branch
    ? `<span class="rd-dot-sep">·</span>
       <span class="rd-branch">${I.branch} ${escHtml(item.branch)}</span>`
    : "";

  const avatarEl = item.avatarUrl
    ? `<img class="rd-avatar rd-avatar--img" src="${escHtml(item.avatarUrl)}" alt="${escHtml(item.author)}" width="14" height="14" />`
    : `<span class="rd-avatar" style="background:${escHtml(item.avatarColor)}">${escHtml(item.initials)}</span>`;

  const summaryCol = `<div class="rd-summary-col">
    <div class="rd-summary-title" title="${escHtml(item.summary)}">${escHtml(item.summary)}</div>
    <div class="rd-meta-row">
      ${item.author ? avatarEl : ""}
      ${item.author ? `<span class="rd-author">${escHtml(item.author)}</span>` : ""}
      ${metaBranch}
    </div>
  </div>`;

  // Divergence column — flag chip and/or jira-version chip and/or preview
  let divergence = "";
  if (item.flag) divergence += renderFlagChip(item.flag);
  if (item.fixVersion && item.fixVersion !== currentVersion && item.fixVersion !== "" && item.fixVersion !== "Unscheduled" && kind === "extra") {
    divergence += `<span class="rd-jira-ver-chip" title="Jira target version: ${escHtml(item.fixVersion)}">Jira: ${escHtml(item.fixVersion)}</span>`;
  }
  if (item.isPreview) {
    divergence += `<span class="rd-preview-chip">preview</span>`;
  }
  const divergenceCol = `<div class="rd-divergence-col">${divergence}</div>`;

  const statusCol = `<div class="rd-status-col">${renderStatusChip(item.status)}</div>`;

  const prNum = item.prNumber ? `#${item.prNumber}` : "";
  const prCol = item.prUrl
    ? `<div class="rd-pr-col"><a class="rd-pr-link" data-pr-link="${escHtml(item.prUrl)}" href="#" title="${escHtml(item.prUrl)}">PR ${escHtml(prNum)} ${I.ext}</a></div>`
    : `<div class="rd-pr-col"></div>`;

  return `<div class="rd-item" data-rd-item="${escHtml(item.key)}">
    ${cbCol}
    ${keyChip}
    ${summaryCol}
    ${divergenceCol}
    ${statusCol}
    ${prCol}
  </div>`;
}

interface SectionCfg { icon: string; label: string; fg: string; bg: string; bd: string; hint: string; }
const SECTION_CFG: Record<string, SectionCfg> = {
  done:    { icon: I.check, label: "Done",    fg: T.ok,   bg: T.okSoft,   bd: T.okBd,   hint: "Merged into main with this release version" },
  missing: { icon: I.minus, label: "Missing", fg: T.fail, bg: T.failSoft, bd: T.failBd, hint: "Targeted to this release in Jira but not yet merged" },
  extra:   { icon: I.plus,  label: "Extra",   fg: T.warn, bg: T.warnSoft, bd: T.warnBd, hint: "Merged into main but Jira target version differs" },
};

function renderSection(kind: "done" | "missing" | "extra", items: ReleaseDiffItem[], selected: Set<string>, currentVersion: string): string {
  const cfg = SECTION_CFG[kind];
  const selectable = kind !== "done";
  const selectedCount = items.filter(it => selected.has(it.key)).length;
  const allSelected = items.length > 0 && selectedCount === items.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const selectAllBtn = selectable && items.length > 0
    ? `<button class="rd-select-all" data-rd-select-all="${kind}">
        <span class="rd-select-all-box ${allSelected ? "rd-select-all-box--checked" : someSelected ? "rd-select-all-box--indeterminate" : ""}">
          ${allSelected ? I.check : someSelected ? `<span style="width:6px;height:1.5px;background:#4F46E5;display:block"></span>` : ""}
        </span>
        Select all
       </button>`
    : "";

  const header = `<div class="rd-section-hd">
    <span class="rd-kind-pill" style="background:${cfg.bg};color:${cfg.fg};border:1px solid ${cfg.bd}">${cfg.icon} ${cfg.label}</span>
    <span class="rd-count-pill">${items.length}</span>
    <span class="rd-hint">${escHtml(cfg.hint)}</span>
    <div class="rd-spacer"></div>
    ${selectAllBtn}
  </div>`;

  const rows = items.length === 0
    ? `<div class="rd-empty-section">No items</div>`
    : items.map(it => renderItem(it, kind, selected.has(it.key), currentVersion)).join("");

  return `<div class="rd-section" data-rd-section="${kind}">${header}<div>${rows}</div></div>`;
}

function renderTabs(tab: string, counts: ReturnType<typeof computeCounts>): string {
  const tabs: Array<{ id: string; label: string; count: number; warnColor?: boolean }> = [
    { id: "all",     label: "All",     count: counts.all },
    { id: "done",    label: "Done",    count: counts.done },
    { id: "missing", label: "Missing", count: counts.missing },
    { id: "extra",   label: "Extra",   count: counts.extra },
    { id: "flagged", label: "Flagged", count: counts.flagged, warnColor: true },
  ];
  return tabs.map(t => {
    const active = tab === t.id;
    const icon = t.id === "flagged" ? `<span style="color:${T.warn}">${I.warn}</span>` : "";
    return `<button class="rd-tab ${active ? "rd-tab--active" : ""}" data-rd-tab="${t.id}">
      ${icon}${escHtml(t.label)}<span class="rd-tab-count">${t.count}</span>
    </button>`;
  }).join("");
}

function renderProgressBar(counts: ReturnType<typeof computeCounts>): string {
  const total = Math.max(counts.all, 1);
  const segs = [
    { v: counts.done,    c: T.ok },
    { v: counts.missing, c: T.fail },
    { v: counts.extra,   c: T.warn },
  ].filter(s => s.v > 0);
  const bars = segs.map(s => `<div class="rd-progress-seg" style="flex:${s.v / total};background:${s.c}"></div>`).join("");
  const pct = Math.round((counts.done / total) * 100);
  const flaggedBtn = counts.flagged > 0
    ? `<span class="rd-dot-sep">·</span><button class="rd-flagged-btn" data-rd-tab="flagged">${I.warn} ${counts.flagged} flagged — review ${I.arrow}</button>`
    : "";
  return `<div class="rd-progress-area">
    <div class="rd-progress-bar">${bars}</div>
    <div class="rd-legend">
      <span class="rd-legend-dot"><span class="rd-legend-dot-circle" style="background:${T.ok}"></span><span class="rd-legend-val">${counts.done}</span> done</span>
      <span class="rd-legend-dot"><span class="rd-legend-dot-circle" style="background:${T.fail}"></span><span class="rd-legend-val">${counts.missing}</span> missing</span>
      <span class="rd-legend-dot"><span class="rd-legend-dot-circle" style="background:${T.warn}"></span><span class="rd-legend-val">${counts.extra}</span> extra</span>
      <span class="rd-dot-sep">·</span>
      <span style="color:${T.inkSoft};font-weight:600">${pct}% complete</span>
      <div class="rd-spacer"></div>
      ${flaggedBtn}
    </div>
  </div>`;
}

function renderBody(st: ModalState): string {
  const { result, tab, selected } = st;
  const ver = st.releaseName;

  const all = [...result.done, ...result.missing, ...result.extra];
  const flagged = all.filter(it => isFlagged(it, ver));

  const isFlaggedTab = tab === "flagged";
  const doneItems    = isFlaggedTab ? flagged.filter(it => result.done.includes(it))    : (tab === "all" || tab === "done")    ? result.done    : [];
  const missingItems = isFlaggedTab ? flagged.filter(it => result.missing.includes(it)) : (tab === "all" || tab === "missing") ? result.missing : [];
  const extraItems   = isFlaggedTab ? flagged.filter(it => result.extra.includes(it))   : (tab === "all" || tab === "extra")   ? result.extra   : [];

  const parts: string[] = [];
  if (tab === "all" || tab === "done"    || (isFlaggedTab && doneItems.length > 0))    parts.push(renderSection("done",    doneItems,    selected, ver));
  if (tab === "all" || tab === "missing" || (isFlaggedTab && missingItems.length > 0)) parts.push(renderSection("missing", missingItems, selected, ver));
  if (tab === "all" || tab === "extra"   || (isFlaggedTab && extraItems.length > 0))   parts.push(renderSection("extra",   extraItems,   selected, ver));

  return parts.length > 0 ? parts.join("") : `<div class="rd-empty-section" style="padding:32px 20px;text-align:center">No items in this view.</div>`;
}

function renderFooter(st: ModalState, counts: ReturnType<typeof computeCounts>): string {
  const { selected, result, targetVersion, verDropOpen } = st;
  const selectedIds = [...selected];
  if (selectedIds.length === 0) {
    return `<span class="rd-footer-hint">${I.info} Select <strong>Missing</strong> or <strong>Extra</strong> items to defer, adopt, or drop them from this release.</span>
            <div class="rd-spacer"></div>
            <button class="rd-close-btn" data-rd-close>Close</button>`;
  }

  const all = [...result.done, ...result.missing, ...result.extra];
  const selectedItems = all.filter(it => selected.has(it.key));
  const kinds = new Set(selectedItems.map(it =>
    result.missing.includes(it) ? "missing" : result.extra.includes(it) ? "extra" : "done"
  ));
  const onlyKind = kinds.size === 1 ? [...kinds][0] : "mixed";
  const primary = onlyKind === "missing" ? "Defer to" : onlyKind === "extra" ? "Adopt to" : "Move to";

  const fromLabel = onlyKind !== "mixed"
    ? `<span class="rd-sel-from">from <strong>${onlyKind}</strong></span>`
    : "";

  const versionOptions = result.availableVersions.map(v =>
    `<button class="rd-ver-option ${v === targetVersion ? "rd-ver-option--selected" : ""}" data-rd-ver-pick="${escHtml(v)}">${escHtml(v)}</button>`
  ).join("");

  const verPanel = verDropOpen
    ? `<div class="rd-ver-panel" data-rd-ver-panel>${versionOptions}</div>`
    : "";

  return `
    <span class="rd-sel-count">${I.check} ${selectedIds.length} selected</span>
    ${fromLabel}
    <div class="rd-spacer"></div>
    <span class="rd-action-label">${escHtml(primary)}</span>
    <div class="rd-ver-dropdown" data-rd-ver-dropdown>
      <button class="rd-ver-btn" data-rd-ver-toggle>${escHtml(targetVersion)} ${I.chev}</button>
      ${verPanel}
    </div>
    <button class="rd-drop-btn" data-rd-drop>Drop from release</button>
    <button class="rd-apply-btn" data-rd-apply>${escHtml(primary.split(" ")[0])} ${I.arrow}</button>
    <button class="rd-clear-btn" title="Clear selection" data-rd-clear>${I.close}</button>
  `;
}

// ── Modal construction ────────────────────────────────────────────────────────

function buildModal(releaseName: string, result: ReleaseDiffResult): HTMLElement {
  const st: ModalState = {
    releaseName,
    result,
    tab: "all",
    selected: new Set(),
    targetVersion: result.availableVersions[0] ?? releaseName,
    verDropOpen: false,
    notesOpen: false,
    applyStatus: "",
  };

  const counts = computeCounts(result, releaseName);

  const overlay = document.createElement("div");
  overlay.className = "rd-overlay";
  overlay.dataset.releaseDiffOverlay = "";

  overlay.innerHTML = `
    <div class="rd-shell" role="dialog" aria-modal="true" aria-label="Release diff">
      <!-- Header -->
      <div class="rd-header">
        <div class="rd-header-row1">
          <span class="rd-badge">Release status</span>
          <span class="rd-version">${escHtml(releaseName)}</span>
          <span class="rd-sep">·</span>
          <span class="rd-repo">${escHtml(result.repo)}</span>
          <span class="rd-sep">·</span>
          <span class="rd-synced">synced <strong>${escHtml(result.syncedAt)}</strong></span>
          <div class="rd-spacer"></div>
          <button class="rd-icon-btn" data-rd-refresh title="Refresh">${I.refresh}</button>
          <button class="rd-notes-btn" data-rd-notes-toggle>${I.notes} Release notes</button>
          <button class="rd-icon-btn rd-icon-btn--ghost" data-rd-close title="Close">${I.close}</button>
        </div>
        <div data-rd-progress>${renderProgressBar(counts)}</div>
      </div>

      <!-- Tabs -->
      <div class="rd-tabs" data-rd-tabs>${renderTabs(st.tab, counts)}</div>

      <!-- Body -->
      <div class="rd-body" data-rd-body>${renderBody(st)}</div>

      <!-- Notes panel (hidden by default) -->
      <div class="rd-body rd-notes-panel" data-rd-notes-panel hidden>
        <textarea class="rd-notes-textarea" data-rd-notes-text readonly spellcheck="false"></textarea>
        <button class="rd-notes-copy" data-rd-notes-copy>Copy</button>
      </div>

      <!-- Footer -->
      <div class="rd-footer" data-rd-footer>${renderFooter(st, counts)}</div>
    </div>
  `;

  // ── State update helpers ──────────────────────────────────────────────────

  function rerender() {
    const freshCounts = computeCounts(st.result, st.releaseName);
    const tabsEl   = overlay.querySelector<HTMLElement>("[data-rd-tabs]");
    const bodyEl   = overlay.querySelector<HTMLElement>("[data-rd-body]");
    const footerEl = overlay.querySelector<HTMLElement>("[data-rd-footer]");
    if (tabsEl)   tabsEl.innerHTML   = renderTabs(st.tab, freshCounts);
    if (bodyEl)   bodyEl.innerHTML   = renderBody(st);
    if (footerEl) footerEl.innerHTML = renderFooter(st, freshCounts);
    footerEl?.classList.toggle("rd-footer--active", st.selected.size > 0);
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  function closeModal() {
    overlay.remove();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener("keydown", function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onKey); }
  });

  // ── Event delegation ──────────────────────────────────────────────────────

  overlay.addEventListener("click", (e) => {
    const target = e.target as Element;

    // Close
    if (target.closest("[data-rd-close]")) { closeModal(); return; }

    // Tab switch
    const tabBtn = target.closest<HTMLElement>("[data-rd-tab]");
    if (tabBtn?.dataset.rdTab) {
      st.tab = tabBtn.dataset.rdTab as ModalState["tab"];
      if (st.notesOpen) { toggleNotes(false); return; }
      rerender(); return;
    }

    // Refresh
    if (target.closest("[data-rd-refresh]")) {
      void refreshDiff(); return;
    }

    // Notes toggle
    if (target.closest("[data-rd-notes-toggle]")) {
      toggleNotes(!st.notesOpen); return;
    }

    // Checkbox toggle (item)
    const cbReal = target.closest<HTMLInputElement>("[data-rd-key]");
    if (cbReal?.dataset.rdKey) {
      toggleSelected(cbReal.dataset.rdKey);
      return;
    }

    // Select all
    const selAllBtn = target.closest<HTMLElement>("[data-rd-select-all]");
    if (selAllBtn?.dataset.rdSelectAll) {
      const sectionKind = selAllBtn.dataset.rdSelectAll as "done" | "missing" | "extra";
      const items = getItemsByKind(sectionKind);
      const allOn = items.every(it => st.selected.has(it.key));
      if (allOn) items.forEach(it => st.selected.delete(it.key));
      else items.forEach(it => st.selected.add(it.key));
      rerender(); return;
    }

    // Version pick
    const verPick = target.closest<HTMLElement>("[data-rd-ver-pick]");
    if (verPick?.dataset.rdVerPick) {
      st.targetVersion = verPick.dataset.rdVerPick;
      st.verDropOpen = false;
      rerender(); return;
    }

    // Version dropdown toggle
    if (target.closest("[data-rd-ver-toggle]")) {
      st.verDropOpen = !st.verDropOpen;
      rerender(); return;
    }

    // Close ver dropdown when clicking elsewhere inside footer
    if (!target.closest("[data-rd-ver-dropdown]") && st.verDropOpen) {
      st.verDropOpen = false;
      rerender();
    }

    // Clear selection
    if (target.closest("[data-rd-clear]")) {
      st.selected.clear();
      rerender(); return;
    }

    // Drop from release
    if (target.closest("[data-rd-drop]")) {
      void handleDrop(); return;
    }

    // Apply (move)
    if (target.closest("[data-rd-apply]")) {
      void handleApply(); return;
    }

    // PR link
    const prLink = target.closest<HTMLElement>("[data-pr-link]");
    if (prLink?.dataset.prLink) {
      e.preventDefault();
      invoke("open_external", { url: prLink.dataset.prLink }).catch(console.error);
      return;
    }
  });

  // ── Toggle selected ───────────────────────────────────────────────────────

  function toggleSelected(key: string) {
    if (st.selected.has(key)) st.selected.delete(key);
    else st.selected.add(key);
    rerender();
  }

  function getItemsByKind(kind: "done" | "missing" | "extra"): ReleaseDiffItem[] {
    const { tab, result } = st;
    const all = [...result.done, ...result.missing, ...result.extra];
    const flagged = all.filter(it => isFlagged(it, st.releaseName));
    if (tab === "flagged") {
      if (kind === "done")    return flagged.filter(it => result.done.includes(it));
      if (kind === "missing") return flagged.filter(it => result.missing.includes(it));
      if (kind === "extra")   return flagged.filter(it => result.extra.includes(it));
    }
    return result[kind];
  }

  // ── Notes panel toggle ────────────────────────────────────────────────────

  function toggleNotes(open: boolean) {
    st.notesOpen = open;
    const bodyEl  = overlay.querySelector<HTMLElement>("[data-rd-body]");
    const notesEl = overlay.querySelector<HTMLElement>("[data-rd-notes-panel]");
    if (bodyEl)  bodyEl.hidden  = open;
    if (notesEl) notesEl.hidden = !open;
    if (open) {
      const ta = overlay.querySelector<HTMLTextAreaElement>("[data-rd-notes-text]");
      if (ta && !ta.value) ta.value = buildReleaseNotes(st.result.done);
    }
  }

  // Notes copy button
  overlay.querySelector("[data-rd-notes-copy]")?.addEventListener("click", async () => {
    const ta  = overlay.querySelector<HTMLTextAreaElement>("[data-rd-notes-text]");
    const btn = overlay.querySelector<HTMLButtonElement>("[data-rd-notes-copy]");
    if (!ta || !btn) return;
    await navigator.clipboard.writeText(ta.value);
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  });

  // ── Apply (move fixVersion) ───────────────────────────────────────────────

  async function handleApply() {
    const keys = [...st.selected];
    if (keys.length === 0) return;
    const target = st.targetVersion;
    if (!window.confirm(`Move ${keys.length} issue${keys.length !== 1 ? "s" : ""} to "${target}"?`)) return;

    setApplyBtnDisabled(true);
    try {
      await invoke("move_jira_fix_versions", { keys, targetVersion: target });
      // Remove moved items from relevant lists and selection
      keys.forEach(k => {
        st.result.missing = st.result.missing.filter(it => it.key !== k);
        st.result.extra   = st.result.extra.filter(it => it.key !== k);
        st.selected.delete(k);
      });
      rerender();
    } catch (err) {
      alert(`Error: ${String(err)}`);
    } finally {
      setApplyBtnDisabled(false);
    }
  }

  // ── Drop from release ─────────────────────────────────────────────────────

  async function handleDrop() {
    const keys = [...st.selected];
    if (keys.length === 0) return;
    if (!window.confirm(`Drop ${keys.length} issue${keys.length !== 1 ? "s" : ""} from release "${st.releaseName}"?`)) return;

    setApplyBtnDisabled(true);
    try {
      await invoke("drop_jira_fix_versions", { keys });
      keys.forEach(k => {
        st.result.missing = st.result.missing.filter(it => it.key !== k);
        st.result.extra   = st.result.extra.filter(it => it.key !== k);
        st.selected.delete(k);
      });
      rerender();
    } catch (err) {
      alert(`Error: ${String(err)}`);
    } finally {
      setApplyBtnDisabled(false);
    }
  }

  function setApplyBtnDisabled(disabled: boolean) {
    const applyBtn = overlay.querySelector<HTMLButtonElement>("[data-rd-apply]");
    const dropBtn  = overlay.querySelector<HTMLButtonElement>("[data-rd-drop]");
    if (applyBtn) applyBtn.disabled = disabled;
    if (dropBtn)  dropBtn.disabled  = disabled;
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async function refreshDiff() {
    const refreshBtn = overlay.querySelector<HTMLButtonElement>("[data-rd-refresh]");
    if (refreshBtn) refreshBtn.classList.add("is-loading");
    try {
      const fresh = await invoke<ReleaseDiffResult>("fetch_release_diff", {
        releaseName: st.releaseName,
      });
      st.result = fresh;
      st.selected.clear();
      // Update synced at in header
      const syncedEl = overlay.querySelector<HTMLElement>(".rd-synced strong");
      if (syncedEl) syncedEl.textContent = fresh.syncedAt;
      const progressEl = overlay.querySelector<HTMLElement>("[data-rd-progress]");
      if (progressEl) progressEl.innerHTML = renderProgressBar(computeCounts(fresh, st.releaseName));
      rerender();
    } catch (err) {
      console.error("Refresh error:", err);
    } finally {
      if (refreshBtn) refreshBtn.classList.remove("is-loading");
    }
  }

  return overlay;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function openReleaseDiff(
  releaseName: string,
  triggerBtn: HTMLButtonElement,
  projectKey?: string,
  repos?: string[]
): Promise<void> {
  triggerBtn.disabled = true;
  triggerBtn.classList.add("is-loading");

  try {
    console.info("[zugit][release-diff] opening", { releaseName, projectKey: projectKey ?? null, repos: repos ?? null });
    const params = {
      releaseName,
      ...(projectKey ? { projectKey } : {}),
      ...(repos && repos.length > 0 ? { repos } : {}),
    };
    const result = await invoke<ReleaseDiffResult>("fetch_release_diff", params);
    console.info("[zugit][release-diff] result", {
      releaseName,
      done: result.done.length,
      missing: result.missing.length,
      extra: result.extra.length,
    });
    document.querySelector("[data-release-diff-overlay]")?.remove();
    document.body.appendChild(buildModal(releaseName, result));
  } catch (err) {
    console.error("Release diff error:", err);
  } finally {
    triggerBtn.disabled = false;
    triggerBtn.classList.remove("is-loading");
  }
}
