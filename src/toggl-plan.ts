/**
 * Day-planning maths for the Toggl autofill: which parts of the working range
 * are free, and which Jira story each free slot belongs to.
 *
 * Pure functions with no DOM or Tauri dependency — everything here is expressed
 * in minutes from midnight of the planned day, so an overnight range simply runs
 * past 1440 instead of needing a second date.
 */

/** "touched": not active in Jira, but moved by the user during the day or seen
 *  in local activity (commits, AI sessions). "sprint": only in the sprint —
 *  it can receive filled time, never compete for a slot. */
export type IssueStage = "in-progress" | "merge-request" | "touched" | "sprint" | "other";

export interface PlannerIssue {
  key: string;
  summary: string;
  status: string;
  stage: IssueStage;
  statusChangedAt?: string | null;
}

export interface PlannerEntry {
  start: string;
  stop?: string | null;
  duration: number;
}

export interface Interval {
  from: number;
  to: number;
}

export interface Candidate {
  key: string;
  summary: string;
  stage: IssueStage;
  status: string;
  /** Window inside the day during which this story was plausibly worked on. */
  fromMin: number;
  toMin: number;
  /** 0 = most plausible. */
  rank: number;
}

/** A trace of work on a story (see `activity.rs`). */
export interface PlannerActivity {
  key: string;
  /** RFC3339. */
  at: string;
  /** "ai-session" | "commit" | "jira" */
  source: string;
  /** "during": work was happening then · "end": work happened before it ·
   *  "start": work happens after it. */
  kind: string;
  detail: string;
  /** 1 by default; lower for Jira moves made in bulk. */
  weight?: number;
}

/** A sprint story's claim on the time no evidence explains (see `toggl_day.rs`). */
export interface FillStory {
  key: string;
  points: number;
  pointsAssumed: boolean;
  bookedMinutes: number;
  budgetMinutes?: number | null;
  weight: number;
}

export interface Assignment {
  from: number;
  to: number;
  chosen: Candidate | null;
  /** Other stories plausible for this span, most plausible first — offered as
   *  one-click swaps. */
  alternatives: string[];
  /** "activity" when work on the story was seen around this time; "status"
   *  when only its Jira status backs the pick; "fill" when the time was shared
   *  out by remaining estimate. */
  basis: "activity" | "status" | "fill";
  /** Short summary of the evidence, e.g. "2 commits · Claude Code". */
  reason: string;
}

// ── Clock helpers ─────────────────────────────────────────────────────────────

/** Reads a 24h clock the way people type it: "8:00", "08:00", "0830", "14". */
export function parseClock(value: string): number {
  const trimmed = value.trim();
  const clamp = (h: number, m: number) =>
    Math.min(23, Math.max(0, h)) * 60 + Math.min(59, Math.max(0, m));

  if (!trimmed.includes(":")) {
    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 0) return 0;
    if (digits.length <= 2) return clamp(Number.parseInt(digits, 10), 0);
    return clamp(
      Number.parseInt(digits.slice(0, -2), 10),
      Number.parseInt(digits.slice(-2), 10),
    );
  }

  const [h, m] = trimmed.split(":");
  return clamp(Number.parseInt(h ?? "0", 10) || 0, Number.parseInt(m ?? "0", 10) || 0);
}

export function clockLabel(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function midnightOf(dateIso: string): Date {
  const [y, m, d] = dateIso.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0);
}

export function dateAt(dateIso: string, minutes: number): Date {
  return new Date(midnightOf(dateIso).getTime() + minutes * 60_000);
}

export function minutesFromMidnight(iso: string, dateIso: string): number {
  return (new Date(iso).getTime() - midnightOf(dateIso).getTime()) / 60_000;
}

/** RFC3339 with the local UTC offset — Toggl stores the instant, but sending the
 *  offset keeps the entry on the right day for anyone reading it in this zone. */
export function toIsoWithOffset(date: Date): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

export const floorTo = (value: number, step: number) => Math.floor(value / step) * step;
export const ceilTo = (value: number, step: number) => Math.ceil(value / step) * step;
export const roundTo = (value: number, step: number) => Math.round(value / step) * step;

// ── Free time ─────────────────────────────────────────────────────────────────

/** Union of the busy intervals, snapped outwards to the slot grid so a generated
 *  entry can never bite into an existing one. */
export function busyIntervals(
  entries: PlannerEntry[],
  dateIso: string,
  slot: number,
  nowMs: number,
): Interval[] {
  const raw: Interval[] = entries
    .map((entry) => {
      const from = minutesFromMidnight(entry.start, dateIso);
      // A running entry (negative duration) has no stop yet — it occupies up to now.
      const to = entry.stop
        ? minutesFromMidnight(entry.stop, dateIso)
        : (nowMs - midnightOf(dateIso).getTime()) / 60_000;
      return { from: floorTo(from, slot), to: ceilTo(to, slot) };
    })
    .filter((interval) => interval.to > interval.from)
    .sort((a, b) => a.from - b.from);

  const merged: Interval[] = [];
  for (const interval of raw) {
    const last = merged[merged.length - 1];
    if (last && interval.from <= last.to) {
      last.to = Math.max(last.to, interval.to);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The parts of `range` not covered by `busy`, dropping anything shorter than one slot. */
export function freeGaps(range: Interval, busy: Interval[], slot: number): Interval[] {
  const gaps: Interval[] = [];
  let cursor = range.from;
  for (const interval of busy) {
    if (interval.to <= range.from || interval.from >= range.to) continue;
    if (interval.from > cursor) gaps.push({ from: cursor, to: Math.min(interval.from, range.to) });
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < range.to) gaps.push({ from: cursor, to: range.to });
  return gaps.filter((gap) => gap.to - gap.from >= slot);
}

// ── Story windows ─────────────────────────────────────────────────────────────

/**
 * Turns Jira stories into activity windows.
 *
 * A story that moved *into* "in progress" during the day was picked up at that
 * moment, so it only covers the part of the day after it. One that moved *into*
 * the merge-request status covers the part before it — that is when the work on
 * it actually happened. Transitions from earlier days cover the whole range, and
 * so do "touched" stories: their own activity says where they belong.
 */
export function candidatesFor(
  issues: PlannerIssue[],
  range: Interval,
  dateIso: string,
  slot: number,
): Candidate[] {
  return issues
    .filter((issue) => issue.stage !== "other")
    .map((issue) => {
      const touched = issue.stage === "touched";
      const changedMin =
        issue.statusChangedAt && !touched
          ? roundTo(minutesFromMidnight(issue.statusChangedAt, dateIso), slot)
          : null;
      const changedToday = changedMin !== null && changedMin > range.from && changedMin < range.to;
      const inProgress = issue.stage === "in-progress";

      let fromMin = range.from;
      let toMin = range.to;
      if (changedToday && changedMin !== null) {
        if (inProgress) fromMin = changedMin;
        else toMin = changedMin;
      }

      const rank =
        issue.stage === "sprint" ? 5 : touched ? 4 : changedToday ? (inProgress ? 0 : 1) : inProgress ? 2 : 3;
      return {
        key: issue.key,
        summary: issue.summary,
        stage: issue.stage,
        status: issue.status,
        fromMin,
        toMin,
        rank,
      };
    })
    .filter((candidate) => candidate.toMin > candidate.fromMin)
    .sort((a, b) => a.rank - b.rank || b.fromMin - a.fromMin);
}

// ── Story allocation ──────────────────────────────────────────────────────────

/** Baseline plausibility from the Jira status alone, by candidate rank: moved
 *  to in progress today, moved to merge request today, in progress, in merge
 *  request, touched. A story sitting in review is rarely worked on — unless
 *  activity says otherwise, and then the activity carries it. */
const RANK_PRIOR = [1.3, 1.15, 1, 0.15, 0.05];
/** A story's prior outside its status window (before it was picked up, after it
 *  was handed over) — unlikely, not impossible. */
const OUTSIDE_WINDOW = 0.15;
/** On a day with activity, statuses count for less: a story left "in progress"
 *  for weeks must not outweigh the one that actually has commits today — but it
 *  still owns the stretches nothing else explains. */
const PRIOR_ON_ACTIVE_DAY = 0.5;
/** Stories scoring at least this share of the best are plausible for a slot. */
const PLAUSIBLE = 0.6;
/** Evidence score above which a pick counts as backed by activity. */
const EVIDENCE_FLOOR = 0.25;
/** Shortest block worth a row: a timesheet in quarter-hour shreds is noise. */
const MIN_BLOCK = 60;

interface Signal {
  key: string;
  at: number;
  source: string;
  kind: string;
  detail: string;
  weight: number;
}

/**
 * How strongly one signal says "this story was being worked on at `minute`".
 *
 * An AI exchange is work happening right then, so it weighs symmetrically. A
 * commit or a move to Developed / Merge Request closes work: it reaches back
 * over the hour or so before it and barely forward. A move to In Progress opens
 * work: it reaches forward.
 */
function signalWeight(signal: Signal, minute: number): number {
  const delta = minute - signal.at;
  if (signal.kind === "during") return signal.weight * Math.exp(-Math.abs(delta) / 25);
  if (signal.kind === "start") return signal.weight * 2 * (delta >= 0 ? Math.exp(-delta / 90) : Math.exp(delta / 10));
  const weight = signal.source === "jira" ? 2 : 1.5;
  return signal.weight * weight * (delta <= 0 ? Math.exp(delta / 75) : Math.exp(-delta / 15));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** "2 commits · Claude Code · → Developed" for the signals around a span. */
function describeSignals(signals: Signal[]): string {
  const commits = signals.filter((s) => s.source === "commit").length;
  const tools = new Set(signals.filter((s) => s.source === "ai-session").map((s) => s.detail || "AI session"));
  const moves = new Set(signals.filter((s) => s.source === "jira").map((s) => s.detail));
  return [commits ? plural(commits, "commit") : "", ...tools, ...moves].filter(Boolean).join(" · ");
}

interface Cell {
  from: number;
  to: number;
  /** Index of the gap the cell belongs to — runs never cross a meeting. */
  gap: number;
  scores: Map<string, number>;
  evidence: Map<string, number>;
  /** No evidence explains the slot and filling is on: shared by estimate. */
  fill: boolean;
  pick: string | null;
}

/**
 * Shares the free time between the candidate stories.
 *
 * Every slot of free time gets a score per story: a baseline from its Jira
 * status, plus the activity seen around that moment. Each story is then given a
 * share of the day in proportion to its total score, and the slots are handed
 * out in time order, preferring to stay on the same story while it is still
 * plausible and has share left. The result is a few contiguous blocks — the
 * morning on the story with this morning's commits, the afternoon on the one
 * moved to Developed at five — instead of every gap cut in equal halves.
 */
export function planStories(
  gaps: Interval[],
  candidates: Candidate[],
  activity: PlannerActivity[],
  dateIso: string,
  slot: number,
  fill: FillStory[] = [],
): Assignment[] {
  if (candidates.length === 0 || gaps.length === 0) return [];
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));

  const signals: Signal[] = activity
    .filter((event) => byKey.has(event.key))
    .map((event) => ({ ...event, weight: event.weight ?? 1, at: minutesFromMidnight(event.at, dateIso) }));
  const dayFrom = gaps[0].from;
  const dayTo = gaps[gaps.length - 1].to;
  const activeDay = signals.some((signal) => signal.at > dayFrom - 60 && signal.at < dayTo + 60);
  const priorScale = activeDay ? PRIOR_ON_ACTIVE_DAY : 1;

  const cells: Cell[] = [];
  gaps.forEach((gap, gapIndex) => {
    for (let from = gap.from; from < gap.to; from += slot) {
      const to = Math.min(from + slot, gap.to);
      const middle = (from + to) / 2;
      const scores = new Map<string, number>();
      const evidence = new Map<string, number>();
      for (const candidate of candidates) {
        const inside = middle >= candidate.fromMin && middle <= candidate.toMin;
        const prior = (RANK_PRIOR[candidate.rank] ?? 0) * (inside ? 1 : OUTSIDE_WINDOW) * priorScale;
        const seen = signals
          .filter((signal) => signal.key === candidate.key)
          .reduce((sum, signal) => sum + signalWeight(signal, middle), 0);
        scores.set(candidate.key, prior + seen);
        evidence.set(candidate.key, seen);
      }
      cells.push({ from, to, gap: gapIndex, scores, evidence, fill: false, pick: null });
    }
  });

  applyFill(cells, fill, byKey);

  const plausibleIn = (cell: Cell) => {
    // Filled slots are shared by every story with a claim, in proportion to it.
    if (cell.fill) return [...cell.scores].filter(([, score]) => score > 0).map(([key]) => key);
    const best = Math.max(...cell.scores.values());
    return candidates
      .map((candidate) => candidate.key)
      .filter((key) => (cell.scores.get(key) ?? 0) >= best * PLAUSIBLE);
  };

  // Each story's share of the free time: every slot is split between the
  // stories plausible for it, in proportion to their scores. A story that is
  // clearly ahead takes the slot whole; a genuine tie is shared.
  const remaining = new Map(candidates.map((candidate) => [candidate.key, 0]));
  for (const cell of cells) {
    const plausible = plausibleIn(cell);
    const total = plausible.reduce((sum, key) => sum + (cell.scores.get(key) ?? 0), 0) || 1;
    for (const key of plausible) {
      remaining.set(key, (remaining.get(key) ?? 0) + ((cell.to - cell.from) * (cell.scores.get(key) ?? 0)) / total);
    }
  }

  const order = (a: string, b: string, cell: Cell) =>
    (cell.scores.get(b) ?? 0) - (cell.scores.get(a) ?? 0) ||
    (remaining.get(b) ?? 0) - (remaining.get(a) ?? 0) ||
    (byKey.get(a)?.rank ?? 9) - (byKey.get(b)?.rank ?? 9) ||
    a.localeCompare(b);

  let previous: string | null = null;
  for (const cell of cells) {
    const plausible = plausibleIn(cell);
    let pick: string;
    if (previous && plausible.includes(previous) && (remaining.get(previous) ?? 0) > 0) {
      pick = previous;
    } else {
      const withShare = plausible.filter((key) => (remaining.get(key) ?? 0) > 0);
      pick = (withShare.length ? withShare : plausible).sort((a, b) => order(a, b, cell))[0];
    }
    cell.pick = pick;
    remaining.set(pick, (remaining.get(pick) ?? 0) - (cell.to - cell.from));
    previous = pick;
  }

  smoothRuns(cells, Math.max(slot * 2, MIN_BLOCK));
  return buildAssignments(cells, candidates, byKey, signals, fill);
}

/**
 * Hands the slots no evidence explains over to the sprint's stories, by what
 * their estimates leave unbooked. Only as many stories as can each get a block
 * of at least an hour take part — the heaviest claims first — so the slack of
 * a quiet afternoon becomes two solid blocks, not six slivers.
 */
function applyFill(cells: Cell[], fill: FillStory[], byKey: Map<string, Candidate>) {
  const unexplained = cells.filter((cell) => Math.max(...cell.evidence.values()) < EVIDENCE_FLOOR);
  const minutes = unexplained.reduce((sum, cell) => sum + (cell.to - cell.from), 0);
  const claims = fill
    .filter((story) => story.weight > 0 && byKey.has(story.key))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Math.floor(minutes / MIN_BLOCK)));
  if (claims.length === 0) return;

  const top = claims[0].weight;
  for (const cell of unexplained) {
    cell.fill = true;
    for (const key of cell.scores.keys()) cell.scores.set(key, 0);
    for (const story of claims) cell.scores.set(story.key, story.weight / top);
  }
}

interface Run {
  key: string;
  gap: number;
  cells: Cell[];
}

function runsOf(cells: Cell[]): Run[] {
  const runs: Run[] = [];
  for (const cell of cells) {
    const last = runs[runs.length - 1];
    const contiguous = last && last.gap === cell.gap && last.cells[last.cells.length - 1].to === cell.from;
    if (last && contiguous && last.key === cell.pick) last.cells.push(cell);
    else runs.push({ key: cell.pick ?? "", gap: cell.gap, cells: [cell] });
  }
  return runs;
}

/** Folds runs shorter than `minRun` into the neighbour that fits them best —
 *  a timesheet of half-hour shreds is noise. One run at a time, shortest
 *  first, so two short neighbours merge instead of swapping places. */
function smoothRuns(cells: Cell[], minRun: number) {
  const length = (run: Run) => run.cells.reduce((sum, cell) => sum + (cell.to - cell.from), 0);
  for (let guard = 0; guard < cells.length; guard += 1) {
    const runs = runsOf(cells);
    const short = runs
      .map((run, index) => ({ run, index }))
      .filter(({ run, index }) => {
        if (length(run) >= minRun) return false;
        const sameGap = (other: Run | undefined) => Boolean(other) && other?.gap === run.gap;
        return sameGap(runs[index - 1]) || sameGap(runs[index + 1]);
      })
      .sort((a, b) => length(a.run) - length(b.run));
    if (short.length === 0) return;

    const { run, index } = short[0];
    const fit = (key: string) => run.cells.reduce((sum, cell) => sum + (cell.scores.get(key) ?? 0), 0);
    const target = [runs[index - 1], runs[index + 1]]
      .filter((other): other is Run => Boolean(other) && other.gap === run.gap)
      .sort((a, b) => fit(b.key) - fit(a.key) || length(b) - length(a))[0];
    for (const cell of run.cells) cell.pick = target.key;
  }
}

function hours(minutes: number): string {
  const value = Math.round((minutes / 60) * 10) / 10;
  return `${value}h`;
}

/** "Riempimento · 8 pt · 6h prenotate su 24h" */
function describeFill(story: FillStory | undefined): string {
  if (!story) return "Riempimento";
  const points = `${story.points} pt${story.pointsAssumed ? " (stimato)" : ""}`;
  const booked = story.budgetMinutes
    ? `${hours(story.bookedMinutes)} prenotate su ${hours(story.budgetMinutes)}`
    : `${hours(story.bookedMinutes)} prenotate`;
  return `${points} · ${booked}`;
}

function buildAssignments(
  cells: Cell[],
  candidates: Candidate[],
  byKey: Map<string, Candidate>,
  signals: Signal[],
  fill: FillStory[],
): Assignment[] {
  return runsOf(cells).map((run) => {
    const from = run.cells[0].from;
    const to = run.cells[run.cells.length - 1].to;
    const mean = (key: string) =>
      run.cells.reduce((sum, cell) => sum + (cell.scores.get(key) ?? 0), 0) / run.cells.length;
    const evidence = Math.max(...run.cells.map((cell) => cell.evidence.get(run.key) ?? 0));
    const filled = run.cells.every((cell) => cell.fill);
    const basis: Assignment["basis"] = evidence >= EVIDENCE_FLOOR ? "activity" : filled ? "fill" : "status";

    const chosenMean = mean(run.key);
    // Filled time can go to any sprint story with estimate left, heaviest first.
    const alternatives =
      basis === "fill"
        ? fill
            .filter((story) => story.key !== run.key && story.weight > 0 && byKey.has(story.key))
            .sort((a, b) => b.weight - a.weight)
            .map((story) => story.key)
            .slice(0, 3)
        : candidates
            .map((candidate) => candidate.key)
            .filter((key) => key !== run.key)
            .filter((key) => basis === "status" || mean(key) >= chosenMean * PLAUSIBLE)
            .sort((a, b) => mean(b) - mean(a))
            .slice(0, 3);

    const chosen = byKey.get(run.key) ?? null;
    const nearby = signals.filter((s) => s.key === run.key && s.at >= from - 90 && s.at <= to + 30);
    const reason =
      basis === "activity" && nearby.length > 0
        ? describeSignals(nearby)
        : basis === "fill"
          ? describeFill(fill.find((story) => story.key === run.key))
          : chosen
            ? `Jira: ${chosen.status}`
            : "";

    return { from, to, chosen, alternatives, basis, reason };
  });
}

// ── Calendar ──────────────────────────────────────────────────────────────────

export interface PlannerEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  declined: boolean;
  transparent: boolean;
  eventType: string;
  /** The recurring series this occurrence belongs to. */
  recurringEventId?: string | null;
}

export interface CalendarBlock {
  event: PlannerEvent;
  from: number;
  to: number;
}

/**
 * Calendar events that deserve a time entry, as slot-aligned blocks.
 *
 * Dropped: declined invitations, events marked "free" rather than busy, anything
 * outside the working range, and events whose slot is already covered by a Toggl
 * entry — that one is tracked already. Overlapping events are trimmed against
 * each other so the resulting blocks never collide.
 */
export function calendarBlocks(
  events: PlannerEvent[],
  dateIso: string,
  slot: number,
  range: Interval,
  busy: Interval[],
): CalendarBlock[] {
  const blocks: CalendarBlock[] = [];

  const candidates = events
    .filter((event) => !event.declined && !event.transparent)
    .map((event) => ({
      event,
      from: floorTo(minutesFromMidnight(event.start, dateIso), slot),
      to: ceilTo(minutesFromMidnight(event.end, dateIso), slot),
    }))
    .sort((a, b) => a.from - b.from);

  for (const candidate of candidates) {
    const from = Math.max(candidate.from, range.from);
    const to = Math.min(candidate.to, range.to);
    if (to - from < slot) continue;
    if (busy.some((interval) => interval.from < to && from < interval.to)) continue;

    const previous = blocks[blocks.length - 1];
    const start = previous ? Math.max(from, previous.to) : from;
    if (to - start < slot) continue;

    blocks.push({ event: candidate.event, from: start, to });
  }

  return blocks;
}

/** Mirrors `normalize_description` in `toggl.rs`, so a calendar event can be
 *  matched against the rules learned from Toggl history. Accented letters are
 *  kept: "Attività" must not turn into "attivit" here and "attività" there. */
export function normalizeDescription(description: string): string {
  return description
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .replace(/[^\p{L}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Lookup keys for a calendar event, most specific first — mirrors `event_keys`
 *  in `toggl.rs`: the recurring series, then the normalised title. */
export function eventKeys(event: { recurringEventId?: string | null; summary: string }): string[] {
  const keys: string[] = [];
  if (event.recurringEventId) keys.push(`rec:${event.recurringEventId}`);
  const normalized = normalizeDescription(event.summary);
  if (normalized) keys.push(`title:${normalized}`);
  return keys;
}

// ── End-of-day reminder ───────────────────────────────────────────────────────

export interface ReminderCheck {
  /** Toggl enabled *and* holding a token. */
  ready: boolean;
  /** End of the working range, "HH:MM". */
  dayEnd: string;
  now: Date;
  /** Day the reminder last fired, "YYYY-MM-DD", or null. */
  lastFiredDay: string | null;
}

/**
 * Whether the "fill your timesheet" nudge is due.
 *
 * Fires from the end of the working range until midnight, once per day, and only
 * on working days: a timesheet reminder on a Sunday is noise. Firing late (the
 * app was closed at 14:00 and opened at 17:00) is deliberate — the day is still
 * unfilled, which is the whole point of the reminder.
 */
export function shouldRemind({ ready, dayEnd, now, lastFiredDay }: ReminderCheck): boolean {
  if (!ready) return false;

  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (lastFiredDay === today) return false;

  const weekday = now.getDay();
  if (weekday === 0 || weekday === 6) return false;

  return now.getHours() * 60 + now.getMinutes() >= parseClock(dayEnd);
}

/** Every row involved in an overlap — the planner refuses to submit while any exist.
 *  All pairs are compared, not just neighbours, so a long row swallowing shorter
 *  ones highlights every row the user has to fix. */
export function overlappingIds(rows: { id: string; startMin: number; endMin: number }[]): Set<string> {
  const clashing = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (a.startMin < b.endMin && b.startMin < a.endMin) {
        clashing.add(a.id);
        clashing.add(b.id);
      }
    }
  }
  return clashing;
}
