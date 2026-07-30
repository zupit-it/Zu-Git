import { invoke } from "@tauri-apps/api/core";
import { escHtml } from "./utils";
import { state } from "./state";
import { refreshGoogleStatus, setStatus } from "./render";
import type { Assignment, Candidate, PlannerEvent } from "./toggl-plan";
import {
  assignSlots, busyIntervals, calendarBlocks, candidatesFor, ceilTo, clockLabel, dateAt,
  durationLabel, floorTo, freeGaps, midnightOf, minutesFromMidnight, normalizeDescription,
  overlappingIds, parseClock, splitRange, toIsoWithOffset,
} from "./toggl-plan";

// ── Backend types ─────────────────────────────────────────────────────────────

interface TogglProject {
  id: number;
  workspaceId: number;
  name: string;
  color?: string | null;
  active: boolean;
  clientName?: string | null;
}

interface TogglTag {
  id: number;
  workspaceId: number;
  name: string;
}

interface TogglAccount {
  fullname: string;
  email: string;
  defaultWorkspaceId?: number | null;
  workspaces: { id: number; name: string }[];
  projects: TogglProject[];
  tags: TogglTag[];
}

interface TogglTimeEntry {
  id: number;
  workspaceId: number;
  projectId?: number | null;
  description: string;
  start: string;
  stop?: string | null;
  duration: number;
  tags: string[];
  billable: boolean;
}

interface ActiveIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  url: string;
  statusChangedAt?: string | null;
  stage: "in-progress" | "merge-request" | "other";
}

interface ProjectHint {
  projectId?: number | null;
  tags: string[];
  billable: boolean;
  description?: string | null;
  uses: number;
}

interface RecurringHint {
  label: string;
  normalized: string;
  hint: ProjectHint;
}

interface LearnedRules {
  version: number;
  byKey: Record<string, ProjectHint>;
  byPrefix: Record<string, ProjectHint>;
  recurring: RecurringHint[];
  entriesScanned: number;
  learnedAt: string;
}

interface TogglDayContext {
  account: TogglAccount;
  workspaceId: number;
  existing: TogglTimeEntry[];
  issues: ActiveIssue[];
  rules: LearnedRules;
  events: PlannerEvent[];
  warnings: string[];
}

interface CreatedEntry {
  clientRef: string;
  id?: number | null;
  description: string;
  ok: boolean;
  error?: string | null;
}

// ── Plan model ────────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  startMin: number;
  endMin: number;
  issueKey: string | null;
  description: string;
  projectId: number | null;
  tags: string[];
  billable: boolean;
  /** Where the row came from — a Jira story, the calendar, or the user. */
  source: "story" | "calendar" | "manual";
  /** Keys plausible for this slot — populated only when the pick was a toss-up. */
  candidateKeys: string[];
  /** Set once the user (or a submit) has settled the row. */
  submitted: "pending" | "ok" | "error";
  error?: string;
}

interface PanelState {
  date: string; // YYYY-MM-DD
  context: TogglDayContext | null;
  /** Working range of the loaded day, in minutes from its midnight. */
  range: { from: number; to: number };
  rows: PlanRow[];
  loading: boolean;
  submitting: boolean;
  notice: { text: string; tone: "info" | "danger" | "success" } | null;
}

/** Entries are fetched with half a day of margin around the working range, then
 *  clipped: the Toggl query filters on the entry start, so a meeting that began
 *  before the range would otherwise be missed and its slot booked twice. */
const FETCH_MARGIN_MIN = 720;

/** How far back the day picker may go. Filling a day older than this is almost
 *  always a mistake, and the stories in progress no longer describe it. */
const MAX_BACKFILL_DAYS = 7;

function shiftDays(dateIso: string, days: number): string {
  const date = midnightOf(dateIso);
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// ── Row building ──────────────────────────────────────────────────────────────

function hintFor(rules: LearnedRules, key: string | null): ProjectHint | null {
  if (!key) return null;
  const exact = rules.byKey[key];
  if (exact) return exact;
  const prefix = key.split("-")[0];
  return rules.byPrefix[prefix] ?? null;
}

/** One planner row for a story over a time span, pre-filled from the learned rules. */
function makeRow(
  id: string,
  from: number,
  to: number,
  key: string | null,
  summary: string,
  rules: LearnedRules,
  candidateKeys: string[] = [],
): PlanRow {
  const hint = hintFor(rules, key);
  // Past wording for this exact story wins — that is what "reproduce my past
  // choices" means in practice.
  const description = rules.byKey[key ?? ""]?.description ?? (key ? `${key} ${summary}`.trim() : "");

  return {
    id,
    startMin: from,
    endMin: to,
    issueKey: key,
    description,
    projectId: hint?.projectId ?? null,
    tags: hint?.tags.slice(0, 1) ?? [],
    billable: hint?.billable ?? false,
    source: "story",
    candidateKeys,
    submitted: "pending",
  };
}

/** Calendar events become rows of their own, pre-filled from the recurring rule
 *  that matches their title — the retro on the calendar lands on the project and
 *  tags you always give it. */
function buildCalendarRows(
  blocks: { event: PlannerEvent; from: number; to: number }[],
  rules: LearnedRules,
): PlanRow[] {
  return blocks.map((block, index) => {
    const normalized = normalizeDescription(block.event.summary);
    const rule = rules.recurring.find((candidate) => candidate.normalized === normalized);
    return {
      id: `cal-${index}-${block.from}`,
      startMin: block.from,
      endMin: block.to,
      issueKey: null,
      description: block.event.summary,
      projectId: rule?.hint.projectId ?? null,
      tags: rule?.hint.tags.slice(0, 1) ?? [],
      billable: rule?.hint.billable ?? false,
      source: "calendar",
      candidateKeys: [],
      submitted: "pending",
    };
  });
}

function buildRows(
  assignments: Assignment[],
  rules: LearnedRules,
  candidates: Candidate[],
): PlanRow[] {
  return assignments
    .map((assignment, index) =>
      makeRow(
        `row-${index}-${assignment.from}`,
        assignment.from,
        assignment.to,
        assignment.chosen?.key ?? null,
        assignment.chosen?.summary ?? "",
        rules,
        assignment.candidateKeys.length > 1 ? assignment.candidateKeys : [],
      ),
    )
    .filter((row) => row.endMin > row.startMin || candidates.length > 0);
}

// ── Panel ─────────────────────────────────────────────────────────────────────

const I = {
  close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.5 7.5h5L10 4"/></svg>`,
  plus: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 1v10M1 6h10"/></svg>`,
  warn: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5L1.5 12.5h11L7 1.5Z"/><path d="M7 5.5v3M7 10.4h.01"/></svg>`,
  calendar: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="11" height="10" rx="1.5"/><path d="M1.5 5.5h11M4.5 1.5v2M9.5 1.5v2"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`,
};

let openPanel: HTMLElement | null = null;

export async function openTogglPanel() {
  if (openPanel) {
    openPanel.remove();
    openPanel = null;
  }

  const st: PanelState = {
    date: todayIso(),
    context: null,
    range: { from: parseClock(state.togglDayStart), to: parseClock(state.togglDayEnd) },
    rows: [],
    loading: true,
    submitting: false,
    notice: null,
  };

  const overlay = document.createElement("div");
  overlay.className = "tg-overlay";
  overlay.dataset.togglOverlay = "";
  overlay.innerHTML = `
    <div class="tg-shell" role="dialog" aria-modal="true" aria-label="Toggl day">
      <div class="tg-header">
        <span class="tg-badge">Toggl</span>
        <input class="tg-date" type="date" data-tg-date value="${st.date}"
               min="${shiftDays(st.date, -MAX_BACKFILL_DAYS)}" max="${st.date}" />
        <span class="tg-range" data-tg-range></span>
        <span class="tg-sep">·</span>
        <span class="tg-account" data-tg-account>loading…</span>
        <div class="tg-spacer"></div>
        <button class="tg-icon-btn" data-tg-relearn title="Re-read Toggl history">${I.refresh}</button>
        <button class="tg-icon-btn tg-icon-btn--ghost" data-tg-close title="Close">${I.close}</button>
      </div>
      <div class="tg-notice" data-tg-notice hidden></div>
      <div class="tg-body" data-tg-body></div>
      <div class="tg-footer" data-tg-footer></div>
    </div>
  `;

  document.body.appendChild(overlay);
  openPanel = overlay;

  const bodyEl = () => overlay.querySelector<HTMLElement>("[data-tg-body]");
  const footerEl = () => overlay.querySelector<HTMLElement>("[data-tg-footer]");

  function close() {
    overlay.remove();
    openPanel = null;
    document.removeEventListener("keydown", onKey);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && !st.submitting) close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && !st.submitting) close();
  });

  function renderNotice() {
    const el = overlay.querySelector<HTMLElement>("[data-tg-notice]");
    if (!el) return;
    if (!st.notice) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = `tg-notice tg-notice--${st.notice.tone}`;
    el.textContent = st.notice.text;
  }

  function render() {
    const body = bodyEl();
    const footer = footerEl();
    if (body) body.innerHTML = renderBody(st);
    if (footer) footer.innerHTML = renderFooter(st);
    const rangeEl = overlay.querySelector<HTMLElement>("[data-tg-range]");
    if (rangeEl) rangeEl.textContent = `${state.togglDayStart}–${state.togglDayEnd}`;
    const accountEl = overlay.querySelector<HTMLElement>("[data-tg-account]");
    if (accountEl) {
      const account = st.context?.account;
      const workspace = account?.workspaces.find((w) => w.id === st.context?.workspaceId);
      accountEl.textContent = account
        ? `${account.fullname || account.email}${workspace ? ` · ${workspace.name}` : ""}`
        : "not connected";
    }
    renderNotice();
  }

  async function load(forceRelearn = false) {
    st.loading = true;
    st.notice = null;
    render();

    const slot = state.togglSlotMinutes;
    let startMin = parseClock(state.togglDayStart);
    let endMin = parseClock(state.togglDayEnd);
    if (endMin <= startMin) endMin += 1440; // overnight shift
    startMin = floorTo(startMin, slot);
    endMin = ceilTo(endMin, slot);

    try {
      const context = await invoke<TogglDayContext>("toggl_prepare_day", {
        // Half a day of margin on both sides: the Toggl query filters on the
        // entry start, so a meeting that began before the range would otherwise
        // be invisible and its slot would look free.
        rangeStart: toIsoWithOffset(dateAt(st.date, startMin - FETCH_MARGIN_MIN)),
        rangeEnd: toIsoWithOffset(dateAt(st.date, endMin + FETCH_MARGIN_MIN)),
        forceRelearn,
      });
      st.context = context;
      const range = { from: startMin, to: endMin };
      st.range = range;
      const busy = busyIntervals(context.existing, st.date, slot, Date.now());
      // Calendar events claim their slots first; the stories then fill what is
      // left, so a meeting is never overwritten by "work on PENT-123".
      const blocks = calendarBlocks(context.events ?? [], st.date, slot, range, busy);
      const calendarRows = buildCalendarRows(blocks, context.rules);
      const claimed = [...busy, ...blocks.map((block) => ({ from: block.from, to: block.to }))]
        .sort((a, b) => a.from - b.from);
      const gaps = freeGaps(range, claimed, slot);
      const candidates = candidatesFor(context.issues, range, st.date, slot);
      st.rows = [...calendarRows, ...buildRows(assignSlots(gaps, candidates), context.rules, candidates)]
        .sort((a, b) => a.startMin - b.startMin);
      if (context.warnings.length > 0) {
        st.notice = { text: context.warnings.join(" · "), tone: "info" };
      }
      if (st.date !== todayIso()) {
        st.notice = {
          text: `Stai pianificando ${st.date}, non oggi.`,
          tone: "info",
        };
      }
    } catch (error) {
      st.context = null;
      st.rows = [];
      st.notice = {
        text: error instanceof Error ? error.message : String(error),
        tone: "danger",
      };
    } finally {
      st.loading = false;
      render();
    }
  }

  // ── Interactions ────────────────────────────────────────────────────────────

  overlay.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest("[data-tg-close]")) {
      if (!st.submitting) close();
      return;
    }
    if (target.closest("[data-tg-relearn]")) {
      void load(true);
      return;
    }
    const removeBtn = target.closest<HTMLElement>("[data-tg-remove]");
    if (removeBtn) {
      st.rows = st.rows.filter((row) => row.id !== removeBtn.dataset.tgRemove);
      render();
      return;
    }
    if (target.closest("[data-tg-add-row]")) {
      addRow();
      return;
    }
    const splitBtn = target.closest<HTMLElement>("[data-tg-split]");
    if (splitBtn) {
      splitRow(splitBtn.dataset.tgSplit ?? "");
      return;
    }
    const chip = target.closest<HTMLElement>("[data-tg-recurring]");
    if (chip) {
      applyRecurring(chip.dataset.tgRecurring ?? "");
      return;
    }
    if (target.closest("[data-tg-submit]")) {
      void submit();
    }
  });

  overlay.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;

    const dateInput = target.closest<HTMLInputElement>("[data-tg-date]");
    if (dateInput) {
      // min/max on the input can be bypassed by typing — clamp here too, so a
      // stray keystroke can never write entries onto a random past day.
      const today = todayIso();
      const earliest = shiftDays(today, -MAX_BACKFILL_DAYS);
      const picked = dateInput.value || today;
      st.date = picked > today ? today : picked < earliest ? earliest : picked;
      dateInput.value = st.date;
      void load();
      return;
    }

    const rowId = target.closest<HTMLElement>("[data-tg-row]")?.dataset.tgRow;
    const row = st.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;

    if (target instanceof HTMLSelectElement && target.dataset.tgField === "issue") {
      const context = st.context;
      const issue = context?.issues.find((candidate) => candidate.key === target.value);
      row.issueKey = issue?.key ?? null;
      if (issue && context) {
        const hint = hintFor(context.rules, issue.key);
        row.description =
          context.rules.byKey[issue.key]?.description ?? `${issue.key} ${issue.summary}`.trim();
        row.projectId = hint?.projectId ?? row.projectId;
        row.tags = hint?.tags.slice(0, 1) ?? row.tags;
        row.billable = hint?.billable ?? row.billable;
      }
      row.candidateKeys = [];
      render();
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset.tgField === "project") {
      row.projectId = target.value ? Number.parseInt(target.value, 10) : null;
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset.tgField === "tag") {
      row.tags = target.value ? [target.value] : [];
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.tgField === "billable") {
      row.billable = target.checked;
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.tgField === "start") {
      row.startMin = clampToDay(parseClock(target.value), row.endMin - state.togglSlotMinutes);
      render();
      return;
    }

    if (target instanceof HTMLInputElement && target.dataset.tgField === "end") {
      const parsed = parseClock(target.value);
      row.endMin = parsed <= row.startMin ? parsed + 1440 : parsed;
      render();
    }
  });

  overlay.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    const rowId = target.closest<HTMLElement>("[data-tg-row]")?.dataset.tgRow;
    const row = st.rows.find((candidate) => candidate.id === rowId);
    if (!row || !(target instanceof HTMLInputElement)) return;

    if (target.dataset.tgField === "description") {
      row.description = target.value;
      const submitBtn = overlay.querySelector<HTMLButtonElement>("[data-tg-submit]");
      if (submitBtn) submitBtn.disabled = !canSubmit(st);
    }
  });

  function clampToDay(value: number, max: number) {
    return Math.max(0, Math.min(value, max));
  }

  function addRow() {
    const slot = state.togglSlotMinutes;
    const last = st.rows[st.rows.length - 1];
    const startMin = last ? last.endMin : parseClock(state.togglDayStart);
    st.rows.push({
      id: `row-manual-${Date.now()}`,
      startMin,
      endMin: startMin + slot * 2,
      issueKey: null,
      description: "",
      projectId: null,
      tags: [],
      billable: false,
      source: "manual",
      candidateKeys: [],
      submitted: "pending",
    });
    render();
  }

  /** Shares an ambiguous slot equally between the stories that could own it,
   *  instead of forcing a single pick. */
  function splitRow(rowId: string) {
    const context = st.context;
    const index = st.rows.findIndex((row) => row.id === rowId);
    const row = st.rows[index];
    if (!context || !row || row.candidateKeys.length < 2) return;

    const pieces = splitRange(row.startMin, row.endMin, row.candidateKeys.length, state.togglSlotMinutes);
    const replacement = pieces.map((piece, i) => {
      const key = row.candidateKeys[i] ?? row.candidateKeys[row.candidateKeys.length - 1];
      const issue = context.issues.find((candidate) => candidate.key === key);
      return makeRow(`${row.id}-split-${i}`, piece.from, piece.to, key, issue?.summary ?? "", context.rules);
    });

    st.rows.splice(index, 1, ...replacement);
    render();
  }

  /** Recurring meetings (retro, estimation…) replay the project and tags the user
   *  gave them in the past; they land on the last row so it can be split by hand. */
  function applyRecurring(normalized: string) {
    const rule = st.context?.rules.recurring.find((entry) => entry.normalized === normalized);
    if (!rule) return;
    const slot = state.togglSlotMinutes;
    const last = st.rows[st.rows.length - 1];
    const startMin = last ? last.endMin : parseClock(state.togglDayStart);
    st.rows.push({
      id: `row-recurring-${Date.now()}`,
      startMin,
      endMin: startMin + slot * 2,
      issueKey: null,
      description: rule.label,
      projectId: rule.hint.projectId ?? null,
      tags: rule.hint.tags.slice(0, 1),
      billable: rule.hint.billable,
      source: "manual",
      candidateKeys: [],
      submitted: "pending",
    });
    render();
  }

  async function submit() {
    const context = st.context;
    if (!context || st.submitting || !canSubmit(st)) return;
    st.submitting = true;
    st.notice = { text: "Creating entries on Toggl…", tone: "info" };
    render();

    const pending = st.rows.filter((row) => row.submitted !== "ok");
    try {
      const results = await invoke<CreatedEntry[]>("toggl_submit_entries", {
        entries: pending.map((row) => ({
          description: row.description.trim(),
          start: toIsoWithOffset(dateAt(st.date, row.startMin)),
          stop: toIsoWithOffset(dateAt(st.date, row.endMin)),
          durationSeconds: (row.endMin - row.startMin) * 60,
          projectId: row.projectId,
          tags: row.tags,
          billable: row.billable,
          clientRef: row.id,
        })),
      });

      for (const result of results) {
        const row = st.rows.find((candidate) => candidate.id === result.clientRef);
        if (!row) continue;
        row.submitted = result.ok ? "ok" : "error";
        row.error = result.error ?? undefined;
      }

      const failed = results.filter((result) => !result.ok);
      const created = results.length - failed.length;
      st.notice = failed.length
        ? {
            text: `${created} entry create, ${failed.length} fallite: ${failed[0]?.error ?? ""}`,
            tone: "danger",
          }
        : { text: `${created} entry create su Toggl.`, tone: "success" };
      if (failed.length === 0) {
        setStatus(`Toggl: ${created} time entries created.`, "neutral");
        // Re-read the day so the new entries show up under "already on Toggl" —
        // that is the confirmation the entries really landed.
        st.submitting = false;
        const notice = st.notice;
        await load();
        st.notice = notice;
      }
    } catch (error) {
      st.notice = {
        text: error instanceof Error ? error.message : String(error),
        tone: "danger",
      };
    } finally {
      st.submitting = false;
      render();
    }
  }

  render();
  await load();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function canSubmit(st: PanelState): boolean {
  const rows = st.rows.filter((row) => row.submitted !== "ok");
  if (rows.length === 0 || st.submitting) return false;
  if (overlappingIds(rows).size > 0) return false;
  return rows.every((row) => row.description.trim().length > 0 && row.endMin > row.startMin);
}

function renderProjectSelect(row: PlanRow, projects: TogglProject[]): string {
  const options = projects
    .map(
      (project) =>
        `<option value="${project.id}" ${row.projectId === project.id ? "selected" : ""}>${escHtml(
          project.name,
        )}${project.clientName ? ` · ${escHtml(project.clientName)}` : ""}</option>`,
    )
    .join("");
  return `
    <select class="tg-select ${row.projectId === null ? "tg-select--empty" : ""}" data-tg-field="project">
      <option value="">No project</option>
      ${options}
    </select>`;
}

/** Every tag the account knows about: the workspace ones plus anything seen in
 *  the learned history, so a tag deleted from the workspace is still offered. */
function knownTags(context: TogglDayContext): string[] {
  const names = new Set<string>();
  for (const tag of context.account.tags) {
    if (tag.workspaceId === context.workspaceId) names.add(tag.name);
  }
  const rules = context.rules;
  for (const hint of [...Object.values(rules.byKey), ...Object.values(rules.byPrefix)]) {
    hint.tags.forEach((tag) => names.add(tag));
  }
  for (const rule of rules.recurring) rule.hint.tags.forEach((tag) => names.add(tag));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** One tag per entry, as a plain select: the same control and the same height as
 *  the project picker. Toggl accepts several tags per entry, but tracking one is
 *  what the history shows and what keeps the row readable. */
function renderTagPicker(row: PlanRow, context: TogglDayContext): string {
  const current = row.tags[0] ?? "";
  const known = knownTags(context);
  // A tag that no longer exists in the workspace is still shown while selected,
  // so editing another field cannot silently drop it.
  const options = (known.includes(current) || !current ? known : [current, ...known])
    .map(
      (tag) =>
        `<option value="${escHtml(tag)}" ${tag === current ? "selected" : ""}>${escHtml(tag)}</option>`,
    )
    .join("");

  return `
    <select class="tg-select" data-tg-field="tag">
      <option value="">Nessun tag</option>
      ${options}
    </select>`;
}

function renderIssueSelect(row: PlanRow, issues: ActiveIssue[]): string {
  const options = issues
    .map(
      (issue) =>
        `<option value="${escHtml(issue.key)}" ${row.issueKey === issue.key ? "selected" : ""}>${escHtml(
          issue.key,
        )} · ${escHtml(issue.status)}</option>`,
    )
    .join("");
  return `
    <select class="tg-select tg-select--issue" data-tg-field="issue">
      <option value="">Choose story…</option>
      ${options}
    </select>`;
}

function renderRow(row: PlanRow, context: TogglDayContext, clashing: boolean): string {
  const projects = context.account.projects.filter(
    (project) => project.workspaceId === context.workspaceId,
  );
  const ambiguous = row.candidateKeys.length > 1;
  const classes = [
    "tg-row",
    ambiguous ? "tg-row--ambiguous" : "",
    clashing ? "tg-row--clash" : "",
    row.submitted === "ok" ? "tg-row--done" : "",
    row.submitted === "error" ? "tg-row--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const candidates = row.candidateKeys
    .map((key) => context.issues.find((issue) => issue.key === key))
    .filter((issue): issue is ActiveIssue => Boolean(issue));

  return `
    <div class="${classes}" data-tg-row="${row.id}">
      <div class="tg-cell tg-cell--time">
        <input class="tg-time" type="text" inputmode="numeric" maxlength="5" data-tg-field="start"
               value="${clockLabel(row.startMin)}" aria-label="Inizio" />
        <span class="tg-dash">–</span>
        <input class="tg-time" type="text" inputmode="numeric" maxlength="5" data-tg-field="end"
               value="${clockLabel(row.endMin)}" aria-label="Fine" />
        <span class="tg-duration">${durationLabel(row.endMin - row.startMin)}</span>
      </div>
      <div class="tg-cell tg-cell--desc">
        ${row.source === "calendar" ? `<span class="tg-source" title="Da Google Calendar">${I.calendar}</span>` : ""}
        <input class="tg-input" type="text" data-tg-field="description" value="${escHtml(row.description)}" placeholder="Description" />
        ${
          ambiguous
            ? `<div class="tg-ambiguous">
                 ${I.warn}
                 <span>Su quale story vuoi tracciare questo slot?</span>
                 <button class="tg-split" data-tg-split="${row.id}" type="button">
                   Dividi tra ${candidates.length}
                 </button>
                 ${renderIssueSelect(row, candidates)}
               </div>`
            : ""
        }
        ${row.error ? `<div class="tg-row-error">${escHtml(row.error)}</div>` : ""}
      </div>
      <div class="tg-cell tg-cell--project">${renderProjectSelect(row, projects)}</div>
      <div class="tg-cell tg-cell--tags">${renderTagPicker(row, context)}</div>
      <div class="tg-cell tg-cell--billable">
        <label class="tg-check" title="Billable">
          <input type="checkbox" data-tg-field="billable" ${row.billable ? "checked" : ""} />
        </label>
      </div>
      <div class="tg-cell tg-cell--actions">
        ${
          row.submitted === "ok"
            ? `<span class="tg-done-mark">${I.check}</span>`
            : `<button class="tg-icon-btn tg-icon-btn--ghost" data-tg-remove="${row.id}" title="Remove">${I.trash}</button>`
        }
      </div>
    </div>`;
}

function renderExisting(
  context: TogglDayContext,
  dateIso: string,
  range: { from: number; to: number },
): string {
  // Entries are fetched with a margin around the range; only the ones that
  // actually overlap it explain a skipped slot.
  const inRange = context.existing
    .map((entry) => {
      const from = minutesFromMidnight(entry.start, dateIso);
      // A running entry has no stop and a negative duration — it runs up to now.
      const to = entry.stop
        ? minutesFromMidnight(entry.stop, dateIso)
        : minutesFromMidnight(new Date().toISOString(), dateIso);
      return { entry, from, to };
    })
    .filter(({ from, to }) => from < range.to && to > range.from);
  if (inRange.length === 0) return "";

  const rows = inRange
    .sort((a, b) => a.from - b.from)
    .map(({ entry, from, to }) => {
      const project = context.account.projects.find((candidate) => candidate.id === entry.projectId);
      return `
        <div class="tg-existing-row">
          <span class="tg-existing-time">${clockLabel(from)}–${clockLabel(to)}</span>
          <span class="tg-existing-desc">${escHtml(entry.description || "(no description)")}</span>
          <span class="tg-existing-project">${escHtml(project?.name ?? "")}</span>
        </div>`;
    })
    .join("");

  return `
    <div class="tg-existing">
      <div class="tg-existing-title">Già su Toggl in questa fascia — questi slot vengono saltati</div>
      ${rows}
    </div>`;
}

function renderBody(st: PanelState): string {
  if (st.loading) {
    return `<div class="tg-empty"><div class="tg-spinner"></div><span>Reading Toggl and Jira…</span></div>`;
  }
  const context = st.context;
  if (!context) {
    return `<div class="tg-empty"><span>Toggl non raggiungibile. Controlla token e impostazioni.</span></div>`;
  }

  const clashing = overlappingIds(st.rows);
  const rows = st.rows.length
    ? st.rows.map((row) => renderRow(row, context, clashing.has(row.id))).join("")
    : `<div class="tg-empty"><span>Nessuno slot libero da riempire in questa fascia oraria.</span></div>`;

  const issueSummary = context.issues.length
    ? `<div class="tg-issues">
        ${context.issues
          .map(
            (issue) =>
              `<span class="tg-issue-chip tg-issue-chip--${issue.stage}">${escHtml(issue.key)} · ${escHtml(
                issue.status,
              )}</span>`,
          )
          .join("")}
      </div>`
    : `<div class="tg-issues tg-issues--empty">Nessuna story assegnata a te in corso — compila le righe a mano.</div>`;

  return `
    ${issueSummary}
    <div class="tg-table">
      <div class="tg-table-head">
        <span>Orario</span><span>Descrizione</span><span>Progetto</span><span>Tag</span><span>Fatt.</span><span></span>
      </div>
      ${rows}
    </div>
    ${renderExisting(context, st.date, st.range)}`;
}

function renderFooter(st: PanelState): string {
  const pending = st.rows.filter((row) => row.submitted !== "ok");
  const totalMinutes = pending.reduce((sum, row) => sum + Math.max(0, row.endMin - row.startMin), 0);
  const recurring = (st.context?.rules.recurring ?? [])
    .slice(0, 6)
    .map(
      (rule) =>
        `<button class="tg-chip" data-tg-recurring="${escHtml(rule.normalized)}" type="button">${I.plus} ${escHtml(
          rule.label,
        )}</button>`,
    )
    .join("");

  const learned = st.context?.rules.entriesScanned ?? 0;
  const learnedAt = st.context?.rules.learnedAt;
  const learnedOn = learnedAt
    ? new Date(learnedAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })
    : "";

  return `
    <div class="tg-footer-left">
      <button class="tg-chip" data-tg-add-row type="button">${I.plus} Riga</button>
      ${recurring}
    </div>
    <div class="tg-footer-right">
      <span class="tg-total">${pending.length} entry · ${durationLabel(totalMinutes)}</span>
      ${
        learned
          ? `<span class="tg-learned">mapping da ${learned} entry storiche${
              learnedOn ? ` · letto il ${learnedOn}` : ""
            }</span>`
          : ""
      }
      <button class="tg-submit" data-tg-submit type="button" ${canSubmit(st) ? "" : "disabled"}>
        ${st.submitting ? "Invio…" : "Crea su Toggl"}
      </button>
    </div>`;
}

// ── Settings helper ───────────────────────────────────────────────────────────

export async function connectGoogleCalendar(button: HTMLButtonElement) {
  const label = document.querySelector<HTMLElement>("[data-google-status]");
  button.disabled = true;
  if (label) {
    label.textContent = "Ho aperto il browser: completa il consenso Google…";
    label.classList.remove("field-hint--danger");
  }
  try {
    const connection = await invoke<{ calendarId: string; summary: string }>("google_connect");
    if (label) label.textContent = `Collegato a ${connection.calendarId}.`;
    await refreshGoogleStatus();
  } catch (error) {
    if (label) {
      label.textContent = error instanceof Error ? error.message : String(error);
      label.classList.add("field-hint--danger");
    }
  } finally {
    button.disabled = false;
  }
}

export async function disconnectGoogleCalendar(button: HTMLButtonElement) {
  button.disabled = true;
  try {
    await invoke("google_disconnect");
    await refreshGoogleStatus();
  } finally {
    button.disabled = false;
  }
}

export async function testTogglConnection(button: HTMLButtonElement) {
  const result = document.querySelector<HTMLElement>("[data-toggl-test-result]");
  button.disabled = true;
  if (result) {
    result.hidden = false;
    result.textContent = "Checking…";
    result.classList.remove("field-hint--danger");
  }
  try {
    const account = await invoke<TogglAccount>("toggl_check_connection");
    const workspaces = account.workspaces.map((w) => `${w.name} (${w.id})`).join(", ");
    if (result) {
      result.textContent = `Connected as ${account.fullname || account.email}. Workspaces: ${workspaces || "none"}. Projects: ${account.projects.length}.`;
    }
  } catch (error) {
    if (result) {
      result.textContent = error instanceof Error ? error.message : String(error);
      result.classList.add("field-hint--danger");
    }
  } finally {
    button.disabled = false;
  }
}
