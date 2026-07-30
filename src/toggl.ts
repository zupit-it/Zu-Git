import { invoke } from "@tauri-apps/api/core";
import { escHtml, errorMessage } from "./utils";
import { state } from "./state";
import { refreshGoogleStatus, setStatus } from "./render";
import type { Assignment, Candidate, PlannerEvent } from "./toggl-plan";
import {
  assignSlots, busyIntervals, calendarBlocks, candidatesFor, ceilTo, clockLabel, dateAt,
  floorTo, freeGaps, midnightOf, minutesFromMidnight, normalizeDescription,
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

/** An entry already on Toggl. Read-only, but shown in place among the proposals
 *  so the day reads as one timeline instead of two disconnected lists. */
interface LockedRow {
  id: string;
  startMin: number;
  endMin: number;
  description: string;
  projectName: string;
  kind: "calendar" | "story";
}

interface PanelState {
  date: string; // YYYY-MM-DD
  context: TogglDayContext | null;
  /** Working range of the loaded day, in minutes from its midnight. */
  range: { from: number; to: number };
  rows: PlanRow[];
  locked: LockedRow[];
  loading: boolean;
  submitting: boolean;
  /** Rows the user opened for editing. Attention rows are always open. */
  expanded: Set<string>;
  hoverId: string | null;
  dateOpen: boolean;
  /** Whole-request failure, distinct from the per-row errors. */
  apiError: string | null;
  notice: { text: string; tone: "info" | "danger" | "success" } | null;
}

/** Entries are fetched with half a day of margin around the working range, then
 *  clipped: the Toggl query filters on the entry start, so a meeting that began
 *  before the range would otherwise be missed and its slot booked twice. */
const FETCH_MARGIN_MIN = 720;

/** How far back the day picker may go. Filling a day older than this is almost
 *  always a mistake, and the stories in progress no longer describe it. */
const MAX_BACKFILL_DAYS = 7;

/** Rail density: 480px for a 6-hour day, held constant when the range widens. */
const PX_PER_MIN = 480 / 360;

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

function dayLabel(dateIso: string): string {
  return midnightOf(dateIso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

function isWeekend(dateIso: string): boolean {
  const day = midnightOf(dateIso).getDay();
  return day === 0 || day === 6;
}

/** "1h30m" — compact, so it never competes with the times next to it. */
function shortDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : h ? "" : "0m"}`;
}

function totalDuration(rows: PlanRow[]): string {
  const minutes = rows.reduce((sum, row) => sum + Math.max(0, row.endMin - row.startMin), 0);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// ── Task colours ──────────────────────────────────────────────────────────────

/** Keyed by task (Jira key, or the description for calendar rows) rather than by
 *  project: most rows of a day share one or two projects, so colouring by project
 *  would paint the whole timeline the same. Hues stay clear of the ok/warn/fail
 *  range so status colours keep their meaning. */
const PALETTE = [
  { bg: "#EEF0FF", bd: "#D9DCFE", fg: "#3730A3" },
  { bg: "#E6F3FE", bd: "#C9E4FB", fg: "#1E5BA8" },
  { bg: "#F1EFFC", bd: "#DCD6F5", fg: "#5B4FB0" },
  { bg: "#FCE9F1", bd: "#F5CFE0", fg: "#A8306A" },
  { bg: "#E3F6F6", bd: "#BFE7E7", fg: "#0E7C86" },
];
const PALETTE_NEUTRAL = { bg: "#F1F1EE", bd: "#DEDAD0", fg: "#5B5D66" };

/** A row with nothing in it yet has no task, and gets the neutral tone. */
function taskKey(row: PlanRow): string {
  return row.issueKey || row.description || "";
}

function hashIndex(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash % PALETTE.length;
}

/**
 * One colour per task for the whole day, hashed from the task key so a story
 * keeps its colour across days — but resolved against the tasks already on
 * screen, because hashing alone collides far too often: with five colours and
 * three tasks, two of them share a tone better than half the time.
 */
function buildTaskColors(rows: PlanRow[]): Map<string, (typeof PALETTE)[number]> {
  const colors = new Map<string, (typeof PALETTE)[number]>();
  const taken = new Set<number>();

  for (const row of rows) {
    const key = taskKey(row);
    if (!key || colors.has(key)) continue;

    const preferred = hashIndex(key);
    let index = preferred;
    // Walk to the first free tone; past five tasks the palette wraps and tones
    // repeat, which is unavoidable and still better than a random clash.
    for (let step = 0; step < PALETTE.length && taken.has(index); step += 1) {
      index = (preferred + step + 1) % PALETTE.length;
    }
    taken.add(index);
    colors.set(key, PALETTE[index]);
  }

  return colors;
}

function colorFor(colors: Map<string, (typeof PALETTE)[number]>, row: PlanRow) {
  const key = taskKey(row);
  return (key && colors.get(key)) || PALETTE_NEUTRAL;
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
  // A toss-up is left blank on purpose: pre-filling one of the candidates would
  // let a straight-through confirm book a story the user never chose, and the
  // empty description is what keeps the submit button disabled until they do.
  if (candidateKeys.length > 1) {
    return {
      id,
      startMin: from,
      endMin: to,
      issueKey: null,
      description: "",
      projectId: null,
      tags: [],
      billable: false,
      source: "story",
      candidateKeys,
      submitted: "pending",
    };
  }

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

/** Entries already on Toggl that overlap the working range. */
function buildLockedRows(context: TogglDayContext, dateIso: string, range: Interval): LockedRow[] {
  return context.existing
    .map((entry) => {
      const startMin = minutesFromMidnight(entry.start, dateIso);
      // A running entry has no stop and a negative duration — it runs up to now.
      const endMin = entry.stop
        ? minutesFromMidnight(entry.stop, dateIso)
        : minutesFromMidnight(new Date().toISOString(), dateIso);
      const project = context.account.projects.find((p) => p.id === entry.projectId);
      return {
        id: `locked-${entry.id}`,
        startMin,
        endMin,
        description: entry.description || "(no description)",
        projectName: project?.name ?? "",
        kind: "story" as const,
      };
    })
    .filter((row) => row.startMin < range.to && row.endMin > range.from)
    .sort((a, b) => a.startMin - b.startMin);
}

interface Interval {
  from: number;
  to: number;
}

/** The configured window, widened to fit any row that fell outside it. */
function effectiveRange(rows: { startMin: number; endMin: number }[], range: Interval): Interval {
  return rows.reduce(
    (acc, row) => ({ from: Math.min(acc.from, row.startMin), to: Math.max(acc.to, row.endMin) }),
    { ...range },
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const I = {
  clock: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5v3L8 8"/></svg>`,
  cal: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.3" width="9" height="8" rx="1.2"/><path d="M1.5 4.8h9M4 1.3v2M8 1.3v2"/></svg>`,
  warn: `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1.5L1.5 12.5h11L7 1.5Z"/><path d="M7 5.5v3M7 10.4h.01"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`,
  x: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`,
  trash: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5h7M4.5 3.5V2.3a.7.7 0 0 1 .7-.7h1.6a.7.7 0 0 1 .7.7v1.2M3.3 3.5l.4 6.4a1 1 0 0 0 1 .9h2.6a1 1 0 0 0 1-.9l.4-6.4"/></svg>`,
  plus: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5h6"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`,
  lock: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.3" width="7" height="5" rx="1"/><path d="M4 5.3V3.8a2 2 0 0 1 4 0v1.5"/></svg>`,
  split: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h3l2 2 2-2h1M2 9h3l2-2 2 2h1"/></svg>`,
  chev: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>`,
  pencil: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10l1-3 5-5 2 2-5 5z"/><path d="M7 3l2 2"/></svg>`,
  dollar: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.5v9M8.2 3.3c-.3-.5-1-.8-1.9-.8-1.2 0-2.1.6-2.1 1.5 0 2.1 4 1 4 3 0 .9-.9 1.5-2.1 1.5-.9 0-1.6-.3-1.9-.8"/></svg>`,
  spinner: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12.5 7A5.5 5.5 0 1 1 7 1.5"/></svg>`,
  moon: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 7.3A4 4 0 1 1 4.7 2.5a4.7 4.7 0 0 0 4.8 4.8Z"/></svg>`,
};

// ── Panel ─────────────────────────────────────────────────────────────────────

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
    locked: [],
    loading: true,
    submitting: false,
    expanded: new Set(),
    hoverId: null,
    dateOpen: false,
    apiError: null,
    notice: null,
  };

  const overlay = document.createElement("div");
  overlay.className = "tg-overlay";
  overlay.dataset.togglOverlay = "";
  overlay.innerHTML = `<div class="tg-shell" role="dialog" aria-modal="true" aria-label="Toggl day" data-tg-shell></div>`;
  document.body.appendChild(overlay);
  openPanel = overlay;

  const shell = () => overlay.querySelector<HTMLElement>("[data-tg-shell]");

  function close() {
    overlay.remove();
    openPanel = null;
    document.removeEventListener("keydown", onKey);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || st.submitting) return;
    if (st.dateOpen) {
      st.dateOpen = false;
      render();
      return;
    }
    close();
  }
  document.addEventListener("keydown", onKey);

  function render() {
    const target = shell();
    if (target) target.innerHTML = renderShell(st);
  }

  async function load(forceRelearn = false) {
    st.loading = true;
    st.apiError = null;
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
      st.locked = buildLockedRows(context, st.date, range);
      st.expanded = new Set();

      const busy = busyIntervals(context.existing, st.date, slot, Date.now());
      // Calendar events claim their slots first; the stories then fill what is
      // left, so a meeting is never overwritten by "work on PENT-123".
      const blocks = calendarBlocks(context.events ?? [], st.date, slot, range, busy);
      const calendarRows = buildCalendarRows(blocks, context.rules);
      const claimed = [...busy, ...blocks.map((block) => ({ from: block.from, to: block.to }))]
        .sort((a, b) => a.from - b.from);
      const gaps = freeGaps(range, claimed, slot);
      const candidates = candidatesFor(context.issues, range, st.date, slot);
      const storyRows = candidates.length
        ? buildRows(assignSlots(gaps, candidates), context.rules, candidates)
        : [];
      st.rows = [...calendarRows, ...storyRows].sort((a, b) => a.startMin - b.startMin);

      if (context.warnings.length > 0) {
        st.notice = { text: context.warnings.join(" · "), tone: "info" };
      }
      if (st.date !== todayIso()) {
        st.notice = { text: `Planning ${dayLabel(st.date)}, not today.`, tone: "info" };
      }
    } catch (error) {
      st.context = null;
      st.rows = [];
      st.locked = [];
      st.apiError = errorMessage(error, "Unexpected error.");
    } finally {
      st.loading = false;
      render();
    }
  }

  // ── Interactions ────────────────────────────────────────────────────────────

  overlay.addEventListener("click", (event) => {
    const target = event.target as Element;

    if (event.target === overlay) {
      if (!st.submitting) close();
      return;
    }
    if (target.closest("[data-tg-close]")) {
      if (!st.submitting) close();
      return;
    }

    // Any click outside the date menu closes it.
    if (st.dateOpen && !target.closest("[data-tg-date-menu]") && !target.closest("[data-tg-date-toggle]")) {
      st.dateOpen = false;
      render();
    }

    if (target.closest("[data-tg-date-toggle]")) {
      st.dateOpen = !st.dateOpen;
      render();
      return;
    }
    const day = target.closest<HTMLElement>("[data-tg-date-pick]");
    if (day) {
      st.date = day.dataset.tgDatePick ?? st.date;
      st.dateOpen = false;
      void load();
      return;
    }
    if (target.closest("[data-tg-relearn]") || target.closest("[data-tg-retry]")) {
      void load(target.closest("[data-tg-relearn]") !== null);
      return;
    }
    if (target.closest("[data-tg-dismiss-error]")) {
      st.apiError = null;
      render();
      return;
    }

    const removeBtn = target.closest<HTMLElement>("[data-tg-remove]");
    if (removeBtn) {
      st.rows = st.rows.filter((row) => row.id !== removeBtn.dataset.tgRemove);
      render();
      return;
    }
    const editBtn = target.closest<HTMLElement>("[data-tg-edit]");
    if (editBtn) {
      const id = editBtn.dataset.tgEdit ?? "";
      if (st.expanded.has(id)) st.expanded.delete(id);
      else st.expanded.add(id);
      render();
      return;
    }
    const billableBtn = target.closest<HTMLElement>("[data-tg-billable]");
    if (billableBtn) {
      const row = st.rows.find((candidate) => candidate.id === billableBtn.dataset.tgBillable);
      if (row) {
        row.billable = !row.billable;
        render();
      }
      return;
    }
    const splitBtn = target.closest<HTMLElement>("[data-tg-split]");
    if (splitBtn) {
      splitRow(splitBtn.dataset.tgSplit ?? "");
      return;
    }
    const storyBtn = target.closest<HTMLElement>("[data-tg-story-add]");
    if (storyBtn) {
      addStoryRow(storyBtn.dataset.tgStoryAdd ?? "");
      return;
    }
    const quick = target.closest<HTMLElement>("[data-tg-quick]");
    if (quick) {
      const which = quick.dataset.tgQuick ?? "";
      if (which === "row") addRow();
      else applyRecurring(which);
      return;
    }
    if (target.closest("[data-tg-submit]")) {
      void submit();
    }
  });

  // Hovering a rail block highlights its card and vice versa. Done by toggling a
  // class instead of re-rendering, so it cannot steal focus from an open input.
  overlay.addEventListener("mouseover", (event) => {
    const holder = (event.target as Element).closest<HTMLElement>("[data-tg-hover]");
    setHover(holder?.dataset.tgHover ?? null);
  });
  overlay.addEventListener("mouseout", (event) => {
    const holder = (event.target as Element).closest<HTMLElement>("[data-tg-hover]");
    if (holder) setHover(null);
  });

  function setHover(id: string | null) {
    if (st.hoverId === id) return;
    st.hoverId = id;
    overlay.querySelectorAll<HTMLElement>("[data-tg-hover]").forEach((element) => {
      element.classList.toggle("is-active", element.dataset.tgHover === id);
    });
  }

  overlay.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
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
      render();
      return;
    }

    if (target instanceof HTMLSelectElement && target.dataset.tgField === "tag") {
      row.tags = target.value ? [target.value] : [];
      render();
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

    // No re-render here: it would pull the caret out of the field being typed in.
    if (target.dataset.tgField === "description") {
      row.description = target.value;
      const submitBtn = overlay.querySelector<HTMLButtonElement>("[data-tg-submit]");
      if (submitBtn) submitBtn.disabled = !canSubmit(st);
    }
  });

  function clampToDay(value: number, max: number) {
    return Math.max(0, Math.min(value, max));
  }

  function nextSlotStart(): number {
    const last = [...st.rows, ...st.locked].sort((a, b) => a.endMin - b.endMin).pop();
    return last ? last.endMin : st.range.from;
  }

  function addRow() {
    const startMin = nextSlotStart();
    const id = `row-manual-${Date.now()}`;
    st.rows.push({
      id,
      startMin,
      endMin: startMin + state.togglSlotMinutes * 2,
      issueKey: null,
      description: "",
      projectId: null,
      tags: [],
      billable: false,
      source: "manual",
      candidateKeys: [],
      submitted: "pending",
    });
    // A blank row is useless collapsed — open it straight away.
    st.expanded.add(id);
    render();
  }

  /** Adds a row already pointing at one of the active stories. */
  function addStoryRow(key: string) {
    const context = st.context;
    const issue = context?.issues.find((candidate) => candidate.key === key);
    if (!context || !issue) return;
    const startMin = nextSlotStart();
    const row = makeRow(
      `row-story-${Date.now()}`,
      startMin,
      startMin + state.togglSlotMinutes * 2,
      issue.key,
      issue.summary,
      context.rules,
    );
    st.rows.push(row);
    st.expanded.add(row.id);
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
   *  gave them in the past. */
  function applyRecurring(normalized: string) {
    const rule = st.context?.rules.recurring.find((entry) => entry.normalized === normalized);
    if (!rule) return;
    const startMin = nextSlotStart();
    const id = `row-recurring-${Date.now()}`;
    st.rows.push({
      id,
      startMin,
      endMin: startMin + state.togglSlotMinutes * 2,
      issueKey: null,
      description: rule.label,
      projectId: rule.hint.projectId ?? null,
      tags: rule.hint.tags.slice(0, 1),
      billable: rule.hint.billable,
      source: "manual",
      candidateKeys: [],
      submitted: "pending",
    });
    st.expanded.add(id);
    render();
  }

  async function submit() {
    const context = st.context;
    if (!context || st.submitting || !canSubmit(st)) return;
    st.submitting = true;
    st.apiError = null;
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
      if (failed.length === 0) {
        setStatus(`Toggl: ${created} time entries created.`, "neutral");
        // Re-read the day so the new entries come back as locked rows — that is
        // the confirmation they really landed.
        st.submitting = false;
        await load();
        st.notice = {
          text: `${created} ${created === 1 ? "entry" : "entries"} created in Toggl.`,
          tone: "success",
        };
      } else {
        st.notice = {
          text: `${created} created, ${failed.length} rejected — see the rows below.`,
          tone: "danger",
        };
      }
    } catch (error) {
      st.apiError = `${errorMessage(error, "Unexpected error.")} Your proposal is safe — nothing was submitted.`;
    } finally {
      st.submitting = false;
      render();
    }
  }

  render();
  await load();
}

// ── Submit guard ──────────────────────────────────────────────────────────────

function canSubmit(st: PanelState): boolean {
  const rows = st.rows.filter((row) => row.submitted !== "ok");
  if (rows.length === 0 || st.submitting) return false;
  if (overlappingIds([...rows, ...st.locked.map((l) => ({ id: l.id, startMin: l.startMin, endMin: l.endMin }))]).size > 0) {
    return false;
  }
  return rows.every((row) => row.description.trim().length > 0 && row.endMin > row.startMin);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderShell(st: PanelState): string {
  const complete = !st.loading && st.context !== null && st.rows.length === 0 && st.locked.length > 0;
  const noStory =
    !st.loading &&
    st.context !== null &&
    st.rows.length === 0 &&
    st.locked.length === 0 &&
    (st.context?.issues.length ?? 0) === 0;

  return `
    ${renderHeader(st)}
    ${renderApiError(st)}
    ${renderNotice(st)}
    ${st.loading || complete || noStory ? "" : renderStoryChips(st)}
    <div class="tg-body">
      ${
        st.loading
          ? renderLoading()
          : st.context === null
            ? renderDisconnected()
            : complete
              ? renderComplete(st)
              : noStory
                ? renderNoStory(st)
                : renderPlan(st)
      }
    </div>
    ${st.loading || complete || st.context === null ? "" : renderFooter(st)}
  `;
}

function renderHeader(st: PanelState): string {
  const account = st.context?.account;
  const workspace = account?.workspaces.find((w) => w.id === st.context?.workspaceId);
  const today = todayIso();
  const days = Array.from({ length: MAX_BACKFILL_DAYS + 1 }, (_, i) => shiftDays(today, -i));

  return `
    <div class="tg-header">
      <span class="tg-badge">Toggl</span>
      <div class="tg-date-wrap">
        <button class="tg-date-btn" data-tg-date-toggle type="button">
          ${escHtml(dayLabel(st.date))}<span class="tg-date-chev">${I.chev}</span>
        </button>
        ${
          st.dateOpen
            ? `<div class="tg-date-menu" data-tg-date-menu>
                 ${days
                   .map(
                     (day) =>
                       `<div class="tg-date-item ${day === st.date ? "is-current" : ""} ${
                         isWeekend(day) ? "is-weekend" : ""
                       }" data-tg-date-pick="${day}">${escHtml(dayLabel(day))}</div>`,
                   )
                   .join("")}
                 <div class="tg-date-note">Only the last ${MAX_BACKFILL_DAYS} days are available</div>
               </div>`
            : ""
        }
      </div>
      <span class="tg-range">${clockLabel(st.range.from)}–${clockLabel(st.range.to)}</span>
      <span class="tg-sep">·</span>
      <span class="tg-account">${
        account
          ? `${escHtml(account.fullname || account.email)}${workspace ? ` <span class="tg-sep">·</span> ${escHtml(workspace.name)}` : ""}`
          : "not connected"
      }</span>
      <div class="tg-spacer"></div>
      <button class="tg-icon-btn" data-tg-relearn type="button" title="Re-read Toggl history">${I.refresh}</button>
      <button class="tg-icon-btn tg-icon-btn--ghost" data-tg-close type="button" title="Close">${I.close}</button>
    </div>`;
}

function renderApiError(st: PanelState): string {
  if (!st.apiError) return "";
  return `
    <div class="tg-banner tg-banner--fail">
      ${I.x}
      <span class="tg-banner-text">${escHtml(st.apiError)}</span>
      <button class="tg-banner-action" data-tg-retry type="button">Retry</button>
      <button class="tg-banner-close" data-tg-dismiss-error type="button" title="Dismiss">${I.close}</button>
    </div>`;
}

function renderNotice(st: PanelState): string {
  if (!st.notice) return "";
  const icon = st.notice.tone === "success" ? I.check : I.warn;
  return `
    <div class="tg-banner tg-banner--${st.notice.tone}">
      ${icon}
      <span class="tg-banner-text">${escHtml(st.notice.text)}</span>
    </div>`;
}

function renderStoryChips(st: PanelState): string {
  const issues = st.context?.issues ?? [];
  if (issues.length === 0) return "";
  return `
    <div class="tg-chips">
      ${issues
        .map(
          (issue) => `
        <span class="tg-story-chip">
          ${escHtml(issue.key)}<span class="tg-story-status">· ${escHtml(issue.status)}</span>
          <button class="tg-story-add" data-tg-story-add="${escHtml(issue.key)}" type="button"
                  title="Add a row for ${escHtml(issue.key)}">${I.plus}</button>
        </span>`,
        )
        .join("")}
      <div class="tg-spacer"></div>
      ${renderLegend(st)}
    </div>`;
}

/** Built from the tasks actually in today's proposal — the set changes daily,
 *  unlike the project, which rarely does. */
function renderLegend(st: PanelState): string {
  const seen = new Set<string>();
  const tasks = st.rows.filter((row) => {
    if (row.candidateKeys.length > 1) return false;
    const key = taskKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (tasks.length === 0) return "";
  const colors = buildTaskColors(st.rows);
  return `
    <div class="tg-legend">
      ${tasks
        .map((row) => {
          const color = colorFor(colors, row);
          return `<span class="tg-legend-item">
            <span class="tg-legend-dot" style="background:${color.bg};border-color:${color.bd}"></span>
            ${escHtml(row.issueKey || row.description || "Untitled")}
          </span>`;
        })
        .join("")}
    </div>`;
}

// ── Timeline rail ─────────────────────────────────────────────────────────────

function renderRail(st: PanelState): string {
  const range = effectiveRange([...st.rows, ...st.locked], st.range);
  const total = Math.max(range.to - range.from, 60);
  const height = total * PX_PER_MIN;

  const hours: string[] = [];
  for (let minute = ceilTo(range.from, 60); minute <= range.to; minute += 60) {
    hours.push(
      `<div class="tg-rail-hour" style="top:${(minute - range.from) * PX_PER_MIN - 5}px">${clockLabel(minute)}</div>`,
    );
  }

  const block = (
    id: string,
    startMin: number,
    endMin: number,
    className: string,
    style: string,
    title: string,
  ) => `
    <div class="tg-rail-block ${className}" data-tg-hover="${id}"
         style="top:${(startMin - range.from) * PX_PER_MIN}px;height:${Math.max((endMin - startMin) * PX_PER_MIN, 3)}px;${style}"
         title="${escHtml(title)}"></div>`;

  const lockedBlocks = st.locked
    .map((row) =>
      block(row.id, row.startMin, row.endMin, "tg-rail-block--locked", "", `${clockLabel(row.startMin)}–${clockLabel(row.endMin)} · ${row.description}`),
    )
    .join("");

  const clashing = overlappingIds([
    ...st.rows,
    ...st.locked.map((l) => ({ id: l.id, startMin: l.startMin, endMin: l.endMin })),
  ]);

  const colors = buildTaskColors(st.rows);
  const rowBlocks = st.rows
    .map((row) => {
      const status = rowStatus(row, clashing.has(row.id));
      const color = colorFor(colors, row);
      const style =
        status === "ok"
          ? `background:${color.bg};border-color:${color.bd}`
          : "";
      return block(
        row.id,
        row.startMin,
        row.endMin,
        `tg-rail-block--${status}`,
        style,
        `${clockLabel(row.startMin)}–${clockLabel(row.endMin)} · ${row.description || "Untitled"}`,
      );
    })
    .join("");

  return `
    <div class="tg-rail" style="height:${height}px">
      ${hours.join("")}
      <div class="tg-rail-track" style="height:${height}px">${lockedBlocks}${rowBlocks}</div>
    </div>`;
}

type RowStatus = "ok" | "ambiguous" | "clash" | "submitted" | "error";

function rowStatus(row: PlanRow, clashing: boolean): RowStatus {
  if (row.submitted === "ok") return "submitted";
  if (row.submitted === "error") return "error";
  if (clashing) return "clash";
  if (row.candidateKeys.length > 1) return "ambiguous";
  return "ok";
}

// ── Plan ──────────────────────────────────────────────────────────────────────

function renderPlan(st: PanelState): string {
  const clashing = overlappingIds([
    ...st.rows,
    ...st.locked.map((l) => ({ id: l.id, startMin: l.startMin, endMin: l.endMin })),
  ]);
  const items: { startMin: number; html: string }[] = [
    ...st.locked.map((row) => ({ startMin: row.startMin, html: renderLockedCard(row) })),
    ...st.rows.map((row) => ({ startMin: row.startMin, html: renderCard(row, st, clashing.has(row.id)) })),
  ].sort((a, b) => a.startMin - b.startMin);

  return `
    <div class="tg-plan">
      ${renderRail(st)}
      <div class="tg-cards">${items.map((item) => item.html).join("")}</div>
    </div>`;
}

function renderLockedCard(row: LockedRow): string {
  return `
    <div class="tg-card tg-card--locked" data-tg-hover="${row.id}">
      <span class="tg-card-icon">${I.lock}</span>
      <span class="tg-card-time">${clockLabel(row.startMin)}–${clockLabel(row.endMin)}</span>
      <span class="tg-card-desc">${escHtml(row.description)}</span>
      ${row.projectName ? `<span class="tg-card-project">${escHtml(row.projectName)}</span>` : ""}
      <span class="tg-card-locked-label">Already on Toggl</span>
    </div>`;
}

function renderCard(row: PlanRow, st: PanelState, clashing: boolean): string {
  const context = st.context;
  if (!context) return "";

  const status = rowStatus(row, clashing);
  const needsAttention = status === "ambiguous" || status === "clash" || status === "error";
  const expanded = st.expanded.has(row.id) || needsAttention;
  const submitted = status === "submitted";
  const color = colorFor(buildTaskColors(st.rows), row);
  const outside = row.startMin < st.range.from || row.endMin > st.range.to;
  const duration = shortDuration(row.endMin - row.startMin);

  const tone =
    status === "ok"
      ? `style="background:${color.bg};border-color:${color.bd}"`
      : "";

  const project = context.account.projects.find((p) => p.id === row.projectId);

  return `
    <div class="tg-card tg-card--${status}" data-tg-row="${row.id}" data-tg-hover="${row.id}" ${tone}>
      <div class="tg-card-main">
        <span class="tg-card-icon" ${status === "ok" ? `style="color:${color.fg}"` : ""}>
          ${row.source === "calendar" ? I.cal : I.clock}
        </span>

        ${
          expanded && !submitted
            ? `<input class="tg-time" type="text" inputmode="numeric" maxlength="5" data-tg-field="start"
                      value="${clockLabel(row.startMin)}" aria-label="Start" />
               <span class="tg-dash">–</span>
               <input class="tg-time" type="text" inputmode="numeric" maxlength="5" data-tg-field="end"
                      value="${clockLabel(row.endMin)}" aria-label="End" />`
            : `<span class="tg-card-time">${clockLabel(row.startMin)}–${clockLabel(row.endMin)}</span>`
        }
        <span class="tg-card-dur">${duration}</span>
        ${
          outside
            ? `<span class="tg-outside" title="Falls outside the usual working window">${I.moon} Outside hours</span>`
            : ""
        }

        ${
          expanded && !submitted
            ? `<input class="tg-desc-input" type="text" data-tg-field="description"
                      value="${escHtml(row.description)}" placeholder="What were you working on?" />`
            : `<span class="tg-card-desc ${row.description ? "" : "is-empty"}">${
                escHtml(row.description) || "No description"
              }</span>`
        }

        ${
          submitted
            ? `<span class="tg-card-created">${I.check} Created</span>`
            : expanded
              ? `${renderProjectSelect(row, context)}${renderTagSelect(row, context)}${renderBillable(row)}`
              : `<span class="tg-pill ${project ? "" : "tg-pill--empty"}">${
                  project ? escHtml(project.name) : "No project"
                }</span>
                 ${row.tags[0] ? `<span class="tg-pill-tag">#${escHtml(row.tags[0])}</span>` : ""}
                 <span class="tg-bill-mark ${row.billable ? "is-on" : ""}" title="${
                   row.billable ? "Billable" : "Non-billable"
                 }">${I.dollar}</span>`
        }

        ${
          !needsAttention && !submitted
            ? `<button class="tg-card-btn ${expanded ? "is-done" : ""}" data-tg-edit="${row.id}" type="button"
                       title="${expanded ? "Done editing" : "Edit"}">${expanded ? I.check : I.pencil}</button>`
            : ""
        }
        ${
          submitted
            ? ""
            : `<button class="tg-card-btn tg-card-btn--danger" data-tg-remove="${row.id}" type="button" title="Delete">${I.trash}</button>`
        }
      </div>

      ${
        status === "ambiguous"
          ? `<div class="tg-band tg-band--warn">
               ${I.warn}
               <span class="tg-band-text">Which story was this from?</span>
               ${renderIssueSelect(row, context)}
               <button class="tg-band-btn" data-tg-split="${row.id}" type="button">
                 ${I.split} Split between ${row.candidateKeys.length}
               </button>
             </div>`
          : ""
      }
      ${
        status === "clash"
          ? `<div class="tg-band tg-band--fail">${I.warn}
               <span class="tg-band-text">Overlaps another entry — adjust the time to submit.</span>
             </div>`
          : ""
      }
      ${
        status === "error"
          ? `<div class="tg-band tg-band--fail">${I.x}
               <span class="tg-band-text">${escHtml(row.error ?? "Toggl rejected this entry.")}</span>
             </div>`
          : ""
      }
    </div>`;
}

function renderProjectSelect(row: PlanRow, context: TogglDayContext): string {
  const projects = context.account.projects.filter((p) => p.workspaceId === context.workspaceId);
  const options = projects
    .map(
      (project) =>
        `<option value="${project.id}" ${row.projectId === project.id ? "selected" : ""}>${escHtml(
          project.name,
        )}${project.clientName ? ` · ${escHtml(project.clientName)}` : ""}</option>`,
    )
    .join("");
  return `
    <select class="tg-mini-select ${row.projectId === null ? "tg-mini-select--empty" : ""}" data-tg-field="project">
      <option value="">Select project</option>
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

function renderTagSelect(row: PlanRow, context: TogglDayContext): string {
  const current = row.tags[0] ?? "";
  const known = knownTags(context);
  // A tag that no longer exists in the workspace is still shown while selected,
  // so editing another field cannot silently drop it.
  const options = (known.includes(current) || !current ? known : [current, ...known])
    .map((tag) => `<option value="${escHtml(tag)}" ${tag === current ? "selected" : ""}>${escHtml(tag)}</option>`)
    .join("");
  return `
    <select class="tg-mini-select" data-tg-field="tag">
      <option value="">+ Tag</option>
      ${options}
    </select>`;
}

function renderBillable(row: PlanRow): string {
  return `
    <button class="tg-bill ${row.billable ? "is-on" : ""}" data-tg-billable="${row.id}" type="button" title="Billable">
      ${I.dollar}${row.billable ? "Billable" : "Non-bill."}
    </button>`;
}

function renderIssueSelect(row: PlanRow, context: TogglDayContext): string {
  const options = row.candidateKeys
    .map((key) => context.issues.find((issue) => issue.key === key))
    .filter((issue): issue is ActiveIssue => Boolean(issue))
    .map((issue) => `<option value="${escHtml(issue.key)}">${escHtml(issue.key)} · ${escHtml(issue.status)}</option>`)
    .join("");
  return `
    <select class="tg-band-select" data-tg-field="issue">
      <option value="">Choose story…</option>
      ${options}
    </select>`;
}

// ── Footer ────────────────────────────────────────────────────────────────────

function renderFooter(st: PanelState): string {
  const pending = st.rows.filter((row) => row.submitted !== "ok");
  const recurring = (st.context?.rules.recurring ?? []).slice(0, 4);
  const learned = st.context?.rules.entriesScanned ?? 0;
  const ready = canSubmit(st);

  return `
    <div class="tg-footer">
      <div class="tg-quick">
        <span class="tg-quick-label">Quick add</span>
        <button class="tg-quick-chip" data-tg-quick="row" type="button">${I.plus} Row</button>
        ${recurring
          .map(
            (rule) =>
              `<button class="tg-quick-chip" data-tg-quick="${escHtml(rule.normalized)}" type="button">${I.cal} ${escHtml(
                rule.label,
              )}</button>`,
          )
          .join("")}
      </div>
      <div class="tg-totals-row">
        <span class="tg-totals">
          <strong>${pending.length}</strong> ${pending.length === 1 ? "entry" : "entries"} ·
          <strong>${totalDuration(pending)}</strong> total${
            learned ? ` · mapped from ${learned} past entries` : ""
          }
        </span>
        <div class="tg-spacer"></div>
        <button class="tg-submit" data-tg-submit type="button" ${ready ? "" : "disabled"}>
          ${
            st.submitting
              ? `<span class="tg-spin">${I.spinner}</span> Creating…`
              : `Create in Toggl${pending.length ? ` <span class="tg-submit-count">(${pending.length})</span>` : ""}`
          }
        </button>
      </div>
    </div>`;
}

// ── Whole-body states ─────────────────────────────────────────────────────────

function renderLoading(): string {
  return `
    <div class="tg-loading">
      <div class="tg-loading-label"><span class="tg-spin">${I.spinner}</span> Reading Toggl, Jira and your calendar…</div>
      ${[0, 1, 2, 3].map(() => `<div class="tg-skeleton"></div>`).join("")}
    </div>`;
}

function renderDisconnected(): string {
  return `
    <div class="tg-state">
      <div class="tg-state-icon tg-state-icon--muted">${I.warn}</div>
      <div class="tg-state-title">Toggl is not reachable</div>
      <div class="tg-state-text">Check the token and the day range in Settings, then try again.</div>
    </div>`;
}

function renderComplete(st: PanelState): string {
  return `
    <div class="tg-plan">
      ${renderRail(st)}
      <div class="tg-state">
        <div class="tg-state-icon tg-state-icon--ok">${I.check}</div>
        <div class="tg-state-title">Today's timesheet is complete</div>
        <div class="tg-state-text">
          Every working minute between ${clockLabel(st.range.from)} and ${clockLabel(st.range.to)}
          is already booked on Toggl. Nothing to propose.
        </div>
      </div>
    </div>`;
}

function renderNoStory(st: PanelState): string {
  return `
    <div class="tg-plan">
      ${renderRail(st)}
      <div class="tg-state">
        <div class="tg-state-icon tg-state-icon--muted">${I.warn}</div>
        <div class="tg-state-title">No active story in the open sprint</div>
        <div class="tg-state-text">Jira has nothing assigned to you right now. Add rows by hand for the rest of the day.</div>
        <button class="tg-quick-chip" data-tg-quick="row" type="button">${I.plus} Add a row</button>
      </div>
    </div>`;
}

// ── Settings helpers ──────────────────────────────────────────────────────────

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
      label.textContent = errorMessage(error, "Unexpected error.");
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
      result.textContent = errorMessage(error, "Unexpected error.");
      result.classList.add("field-hint--danger");
    }
  } finally {
    button.disabled = false;
  }
}
