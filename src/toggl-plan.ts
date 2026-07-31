/**
 * Day-planning maths for the Toggl autofill: which parts of the working range
 * are free, and which Jira story each free slot belongs to.
 *
 * Pure functions with no DOM or Tauri dependency — everything here is expressed
 * in minutes from midnight of the planned day, so an overnight range simply runs
 * past 1440 instead of needing a second date.
 */

export type IssueStage = "in-progress" | "merge-request" | "other";

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

export interface Assignment {
  from: number;
  to: number;
  chosen: Candidate | null;
  /** Keys plausible for this slot — filled only when the pick was a toss-up. */
  candidateKeys: string[];
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
 * it actually happened. Transitions from earlier days cover the whole range.
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
      const changedMin = issue.statusChangedAt
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

      // A transition that happened today is the strongest evidence there is: the
      // story you moved to merge request at 11:00 is what the morning went into,
      // even if another story has been in progress for days.
      const rank = changedToday ? (inProgress ? 0 : 1) : inProgress ? 2 : 3;
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

/**
 * The story to fall back on for a slot no activity window covers.
 *
 * Happens whenever the day's stories all stopped being "active" before the range
 * ends — the common case being a single story moved to merge request this
 * morning, which would otherwise leave the whole afternoon blank. Continuity is
 * the best guess available: the story worked on most recently before the slot,
 * or failing that the next one picked up after it.
 */
function nearestCandidate(candidates: Candidate[], from: number, to: number): Candidate | null {
  const before = candidates
    .filter((candidate) => candidate.toMin <= from)
    .sort((a, b) => b.toMin - a.toMin || a.rank - b.rank);
  if (before.length > 0) return before[0];

  const after = candidates
    .filter((candidate) => candidate.fromMin >= to)
    .sort((a, b) => a.fromMin - b.fromMin || a.rank - b.rank);
  return after[0] ?? null;
}

/** Splits the free gaps at every activity-window boundary, picks the best candidate
 *  for each piece, then merges neighbours that ended up on the same story. */
export function assignSlots(gaps: Interval[], candidates: Candidate[]): Assignment[] {
  const assignments: Assignment[] = [];

  for (const gap of gaps) {
    const points = new Set<number>([gap.from, gap.to]);
    for (const candidate of candidates) {
      if (candidate.fromMin > gap.from && candidate.fromMin < gap.to) points.add(candidate.fromMin);
      if (candidate.toMin > gap.from && candidate.toMin < gap.to) points.add(candidate.toMin);
    }
    const bounds = [...points].sort((a, b) => a - b);

    for (let i = 0; i < bounds.length - 1; i += 1) {
      const from = bounds[i];
      const to = bounds[i + 1];
      const covering = candidates.filter((c) => c.fromMin <= from && c.toMin >= to);
      const bestRank = covering.length > 0 ? Math.min(...covering.map((c) => c.rank)) : null;
      const best = bestRank === null ? [] : covering.filter((c) => c.rank === bestRank);

      assignments.push({
        from,
        to,
        chosen: best[0] ?? nearestCandidate(candidates, from, to),
        // Only a genuine toss-up is worth asking about: several stories with the
        // same plausibility covering the same slot.
        candidateKeys: best.length > 1 ? best.map((c) => c.key) : [],
      });
    }
  }

  const merged: Assignment[] = [];
  for (const assignment of assignments) {
    const last = merged[merged.length - 1];
    const sameStory = last?.chosen?.key === assignment.chosen?.key;
    const contiguous = last?.to === assignment.from;
    const settled = (last?.candidateKeys.length ?? 0) === 0 && assignment.candidateKeys.length === 0;
    if (last && sameStory && contiguous && settled) {
      last.to = assignment.to;
    } else {
      merged.push({ ...assignment });
    }
  }
  return merged;
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

/** Mirrors the Rust-side normalisation, so a calendar event can be matched
 *  against the recurring rules learned from Toggl history. */
export function normalizeDescription(description: string): string {
  return description
    .replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, " ")
    .split("")
    .map((c) => (/[a-zA-Z\s]/.test(c) ? c.toLowerCase() : " "))
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Splits `[from, to)` into `parts` chunks aligned to the slot grid, dropping the
 *  chunks that would come out empty when the range is too short to go round. */
export function splitRange(from: number, to: number, parts: number, slot: number): Interval[] {
  const total = to - from;
  if (parts < 2 || total <= 0) return [{ from, to }];

  const bounds: Interval[] = [];
  let cursor = from;
  for (let i = 1; i <= parts; i += 1) {
    const edge = i === parts ? to : from + floorTo((total * i) / parts, slot);
    if (edge > cursor) {
      bounds.push({ from: cursor, to: edge });
      cursor = edge;
    }
  }
  return bounds;
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
