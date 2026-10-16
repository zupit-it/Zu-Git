/**
 * Sprint board maths: which column a story sits in, what the totals are, what
 * changed since the last standup. Pure functions with no DOM or Tauri
 * dependency, so they can be tested on their own.
 */

import type { PullRequestSummary } from "./shared/pr-model";

// ── Types (mirror `sprint.rs`) ────────────────────────────────────────────────

export interface JiraPerson {
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface BoardRef {
  id: number;
  name: string;
  projectKey: string;
  boardType: string;
}

export interface SprintRef {
  id: number;
  name: string;
  state: string;
  startDate: string | null;
  /** When it was actually started; `startDate` is the one typed in. */
  activatedDate?: string | null;
  endDate: string | null;
  goal: string | null;
}

export type ColumnCategory = "new" | "indeterminate" | "done";

export interface BoardColumn {
  name: string;
  statusIds: string[];
  category: ColumnCategory;
}

export interface SprintIssue {
  key: string;
  summary: string;
  statusId: string;
  statusName: string;
  statusCategory: string;
  issueType: string;
  assignee: JiraPerson | null;
  points: number | null;
  priority: string | null;
  flagged: boolean;
  epic: string | null;
  fixVersions: string[];
  labels: string[];
  subtasksTotal: number;
  subtasksDone: number;
  updated: string | null;
}

export interface SprintPermissions {
  transition: boolean;
  assign: boolean;
  edit: boolean;
  comment: boolean;
}

export interface SprintBoard {
  boards: BoardRef[];
  board: BoardRef | null;
  sprints: SprintRef[];
  sprint: SprintRef | null;
  columns: BoardColumn[];
  issues: SprintIssue[];
  me: JiraPerson | null;
  permissions: SprintPermissions;
  pointsField: string | null;
  siteUrl: string;
  notice: string | null;
}

export interface TransitionOption {
  id: string;
  name: string;
  toStatusId: string;
  toStatusName: string;
  toCategory: string;
  needsInput: boolean;
}

export interface IssueComment {
  id: string;
  author: JiraPerson | null;
  created: string | null;
  body: unknown;
}

export interface SubtaskRef {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: string;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  created: string | null;
  author: string | null;
}

export interface IssueDetail {
  key: string;
  summary: string;
  issueType: string;
  reporter: JiraPerson | null;
  created: string | null;
  description: unknown;
  subtasks: SubtaskRef[];
  comments: IssueComment[];
  commentTotal: number;
  attachments: AttachmentRef[];
  /** Media node id (description and comments) → attachment id. */
  media: Record<string, string>;
}

export interface ChangeEvent {
  key: string;
  at: string;
  author: string | null;
  field: "status" | "sprint" | "flag" | "assignee" | "points";
  from: string | null;
  to: string | null;
  fromString: string | null;
  toString: string | null;
}

export interface SprintCategory {
  id: string;
  name: string;
  color: string;
  keys: string[];
}

// ── Columns and totals ────────────────────────────────────────────────────────

/** Index of the column holding the story. A status the board does not map
 *  falls back to the first column of the same category, so nothing vanishes. */
export function columnIndexOf(issue: Pick<SprintIssue, "statusId" | "statusCategory">, columns: BoardColumn[]): number {
  const exact = columns.findIndex((column) => column.statusIds.includes(issue.statusId));
  if (exact >= 0) return exact;
  const category = issue.statusCategory === "done" || issue.statusCategory === "new" ? issue.statusCategory : "indeterminate";
  const sameCategory = columns.findIndex((column) => column.category === category);
  return sameCategory >= 0 ? sameCategory : 0;
}

export function isDone(issue: SprintIssue, columns: BoardColumn[]): boolean {
  const column = columns[columnIndexOf(issue, columns)];
  return column ? column.category === "done" : issue.statusCategory === "done";
}

export function hiddenKeys(categories: SprintCategory[]): Set<string> {
  return new Set(categories.flatMap((category) => category.keys));
}

export function categoryOf(key: string, categories: SprintCategory[]): SprintCategory | null {
  return categories.find((category) => category.keys.includes(key)) ?? null;
}

export function sumPoints(issues: SprintIssue[]): number {
  return issues.reduce((total, issue) => total + (issue.points ?? 0), 0);
}

export function formatPoints(points: number): string {
  return points.toLocaleString("it-IT", { maximumFractionDigits: 1 });
}

// ── Sprint calendar ───────────────────────────────────────────────────────────

function isWorkingDay(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Working days from `from` to `to`, both included (by calendar date). */
export function workingDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const cursor = startOfDay(from);
  const end = startOfDay(to);
  while (cursor <= end) {
    if (isWorkingDay(cursor)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export interface SprintClock {
  /** Working day of the sprint today is (1-based), clamped to the sprint. */
  day: number;
  totalDays: number;
  /** Share of the sprint's working days already behind us: a working day in
   *  progress counts half, a weekend adds nothing, past the end it is all. */
  elapsed: number;
  remainingDays: number;
  /** The sprint's end date has passed. */
  ended: boolean;
}

export function sprintClock(sprint: SprintRef | null, now: Date): SprintClock | null {
  if (!sprint?.startDate || !sprint.endDate) return null;
  const start = new Date(sprint.startDate);
  const end = new Date(sprint.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const totalDays = Math.max(1, workingDaysBetween(start, end));
  const ended = now > end;
  if (now < start) return { day: 1, totalDays, elapsed: 0, remainingDays: totalDays, ended };
  const today = ended ? end : now;
  const day = Math.min(totalDays, Math.max(1, workingDaysBetween(start, today)));
  // On a working day in progress, today counts half. On a weekend the days
  // counted are all behind us, and once the sprint is over every day is.
  const inProgress = !ended && isWorkingDay(now);
  const elapsed = Math.min(1, Math.max(0, (inProgress ? day - 0.5 : day) / totalDays));
  const remainingDays = Math.max(0, totalDays - day + (inProgress ? 1 : 0));
  return { day, totalDays, elapsed, remainingDays, ended };
}

export interface Pace {
  done: number;
  total: number;
  remaining: number;
  /** Points closed per working day so far. */
  perDay: number;
  /** Points per remaining working day needed to close the sprint. */
  needed: number | null;
}

export function sprintPace(issues: SprintIssue[], columns: BoardColumn[], clock: SprintClock | null): Pace {
  const total = sumPoints(issues);
  const done = sumPoints(issues.filter((issue) => isDone(issue, columns)));
  const remaining = Math.max(0, total - done);
  // Working days already spent, today counting half; at least one, so a first
  // morning does not divide by zero.
  const daysBehind = clock ? Math.max(1, clock.elapsed * clock.totalDays) : 1;
  return {
    done,
    total,
    remaining,
    perDay: done / daysBehind,
    needed: clock && clock.remainingDays > 0 ? remaining / clock.remainingDays : null,
  };
}

// ── Standup ───────────────────────────────────────────────────────────────────

/** When the standup is, unless the user set another time. */
export const DEFAULT_STANDUP_TIME = "08:00";

export interface Clock {
  hour: number;
  minute: number;
}

/** "8", "8:15", "08.15", "815", "0815" → 8:15; null when it is not a time of day. */
export function parseClock(text: string): Clock | null {
  const match = text.trim().match(/^(\d{1,2})(?:[:.]?(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export function formatClock(clock: Clock): string {
  return `${clock.hour}:${String(clock.minute).padStart(2, "0")}`;
}

const DEFAULT_CLOCK: Clock = { hour: 8, minute: 0 };

/** The previous working day's standup: what today's standup talks about.
 *  On a Monday that is Friday. */
export function previousStandup(now: Date, clock: Clock = DEFAULT_CLOCK): Date {
  const cursor = startOfDay(now);
  do {
    cursor.setDate(cursor.getDate() - 1);
  } while (!isWorkingDay(cursor));
  cursor.setHours(clock.hour, clock.minute, 0, 0);
  return cursor;
}

const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

export function standupLabel(since: Date, now: Date): string {
  const yesterday = startOfDay(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const time = formatClock({ hour: since.getHours(), minute: since.getMinutes() });
  const day = startOfDay(since).getTime() === yesterday.getTime() ? "ieri" : WEEKDAYS[since.getDay()];
  return `${day} ${time}`;
}

// ── What changed, story by story ──────────────────────────────────────────────

export type ChangeKind = "closed" | "movedBack" | "moved" | "flagged" | "added" | "assigned" | "estimated";

/**
 * Jira's flag, shown as information. Jira calls it an impediment, but teams
 * use it their own way — "deployed on test" is common — so it never marks a
 * story as blocked. Its name can be set per board ("In test").
 */
export interface FlagMeaning {
  label: string;
}

export const DEFAULT_FLAG: FlagMeaning = { label: "Flag" };

export function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** "con flag" for the plain flag, the team's own name ("in test") otherwise. */
export function flagShort(flag: FlagMeaning): string {
  return flag.label === DEFAULT_FLAG.label ? "con flag" : lowerFirst(flag.label);
}

/** Most telling first: the first one is the card's badge. */
const CHANGE_ORDER: ChangeKind[] = ["closed", "movedBack", "moved", "flagged", "added", "assigned", "estimated"];

export interface StoryChange {
  /** The change that matters most, for the card's badge. */
  kind: ChangeKind;
  /** Every net change: `text` for the standup lists, `short` for the card. */
  kinds: { kind: ChangeKind; text: string; short: string }[];
  /** The history behind it, oldest first: "ven 16:45 · Anna Parisi: Merge Request → Developed". */
  lines: string[];
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${WEEKDAYS_SHORT[at.getDay()]} ${formatClock({ hour: at.getHours(), minute: at.getMinutes() })}`;
}

function describeEvent(event: ChangeEvent, flag: FlagMeaning): string {
  switch (event.field) {
    case "status":
      return `${event.fromString ?? "?"} → ${event.toString ?? "?"}`;
    case "sprint":
      return `aggiunta a ${event.toString ?? "sprint"}`;
    case "assignee":
      return event.toString ? `assegnata a ${event.toString}` : "non più assegnata";
    case "points":
      return `stima ${event.fromString ?? "—"} → ${event.toString ?? "—"}`;
    case "flag":
      if (flag.label === DEFAULT_FLAG.label) return event.toString ? "flag messo" : "flag tolto";
      return event.toString ? `flag «${flag.label}»` : `tolto il flag «${flag.label}»`;
  }
}

/**
 * A story added once the sprint was under way, as Jira's sprint report counts
 * scope changes. Stories planned in, or carried over from the sprint closed
 * to start this one, were there from the start.
 */
function addedToSprint(event: ChangeEvent, sprint: SprintStart): boolean {
  const id = String(sprint.id);
  const ids = (value: string | null) => (value ?? "").split(",").map((part) => part.trim());
  if (!ids(event.to).includes(id) || ids(event.from).includes(id)) return false;
  const started = Date.parse(sprint.activatedDate ?? sprint.startDate ?? "");
  return Number.isNaN(started) || Date.parse(event.at) > started;
}

export type SprintStart = Pick<SprintRef, "id" | "startDate" | "activatedDate">;

/**
 * Net changes per story since the standup: from where a story was then to
 * where it is now, so a move there and back is no news. Stories filed in a
 * category are left out, like everywhere on the board.
 */
export function summarizeChanges(
  events: ChangeEvent[],
  issues: SprintIssue[],
  columns: BoardColumn[],
  sprint: SprintStart,
  hidden: Set<string>,
  flag: FlagMeaning = DEFAULT_FLAG,
): Map<string, StoryChange> {
  const byKey = new Map<string, ChangeEvent[]>();
  const visible = new Set(issues.filter((issue) => !hidden.has(issue.key)).map((issue) => issue.key));
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    if (!visible.has(event.key)) continue;
    const list = byKey.get(event.key) ?? [];
    list.push(event);
    byKey.set(event.key, list);
  }
  const columnOf = (statusId: string | null) =>
    statusId === null ? -1 : columns.findIndex((column) => column.statusIds.includes(statusId));
  const flaggedNow = new Set(issues.filter((issue) => issue.flagged).map((issue) => issue.key));

  const result = new Map<string, StoryChange>();
  for (const [key, list] of byKey) {
    const kinds: StoryChange["kinds"] = [];
    const of = (field: ChangeEvent["field"]) => list.filter((event) => event.field === field);

    const status = of("status");
    if (status.length) {
      const first = status[0];
      const last = status[status.length - 1];
      const from = columnOf(first.from);
      const to = columnOf(last.to);
      const fromName = from >= 0 ? columns[from].name : first.fromString ?? "?";
      const toName = to >= 0 ? columns[to].name : last.toString ?? "?";
      const wasDone = from >= 0 && columns[from].category === "done";
      if (to >= 0 && columns[to].category === "done" && !wasDone) {
        kinds.push({ kind: "closed", text: last.author ? `da ${last.author}` : `${fromName} → ${toName}`, short: "chiusa" });
      } else if (from >= 0 && to >= 0 && to < from) {
        kinds.push({ kind: "movedBack", text: `${fromName} → ${toName}`, short: `tornata da ${fromName}` });
      } else if (from !== to) {
        kinds.push({ kind: "moved", text: `${fromName} → ${toName}`, short: `da ${fromName}` });
      }
    }

    const added = of("sprint").find((event) => addedToSprint(event, sprint));
    if (added) kinds.push({ kind: "added", text: added.author ? `da ${added.author}` : "", short: "nuova nello sprint" });

    const flags = of("flag");
    if (flags.length && flags[flags.length - 1].toString && flaggedNow.has(key)) {
      const author = flags[flags.length - 1].author;
      kinds.push({ kind: "flagged", text: author ? `da ${author}` : flag.label, short: flagShort(flag) });
    }

    const assignee = of("assignee");
    if (assignee.length) {
      const first = assignee[0];
      const last = assignee[assignee.length - 1];
      if (first.from !== last.to) {
        const text = !last.to
          ? `non più assegnata (era ${first.fromString ?? "?"})`
          : first.from
            ? `${first.fromString ?? "?"} → ${last.toString ?? "?"}`
            : `presa da ${last.toString ?? "?"}`;
        const short = !last.to ? "senza assegnatario" : first.from ? `prima: ${first.fromString ?? "?"}` : "presa in carico";
        kinds.push({ kind: "assigned", text, short });
      }
    }

    const points = of("points");
    if (points.length) {
      const before = points[0].fromString ?? "—";
      const after = points[points.length - 1].toString ?? "—";
      if (before !== after) kinds.push({ kind: "estimated", text: `${before} → ${after} pt`, short: `stima ${before} → ${after}` });
    }

    if (kinds.length === 0) continue;
    kinds.sort((a, b) => CHANGE_ORDER.indexOf(a.kind) - CHANGE_ORDER.indexOf(b.kind));
    result.set(key, {
      kind: kinds[0].kind,
      kinds,
      lines: list.map((event) => `${when(event.at)} · ${event.author ?? "?"}: ${describeEvent(event, flag)}`),
    });
  }
  return result;
}

// ── Standup summary ───────────────────────────────────────────────────────────

export interface StandupItem {
  key: string;
  text: string;
}

export interface Standup {
  closed: StandupItem[];
  movedBack: StandupItem[];
  moved: StandupItem[];
  added: StandupItem[];
  flagged: StandupItem[];
  assigned: StandupItem[];
  estimated: StandupItem[];
  ci: StandupItem[];
  changes: StandupItem[];
  waiting: StandupItem[];
}

/** "changed": what happened since the standup (Jira's history).
 *  "attention": what is stuck right now (the PRs' state). */
export type StandupSection = "changed" | "attention";

export interface StandupGroup {
  id: keyof Standup;
  section: StandupSection;
  label: (n: number) => string;
  tone: "ok" | "accent" | "warn" | "fail" | "neutral" | "info";
}

export const STANDUP_GROUPS: StandupGroup[] = [
  { id: "closed", section: "changed", label: (n) => (n === 1 ? "chiusa" : "chiuse"), tone: "ok" },
  { id: "moved", section: "changed", label: (n) => (n === 1 ? "avanzata" : "avanzate"), tone: "accent" },
  { id: "movedBack", section: "changed", label: (n) => (n === 1 ? "tornata indietro" : "tornate indietro"), tone: "warn" },
  { id: "added", section: "changed", label: (n) => (n === 1 ? "entrata nello sprint" : "entrate nello sprint"), tone: "neutral" },
  { id: "flagged", section: "changed", label: () => "con flag", tone: "info" },
  { id: "assigned", section: "changed", label: (n) => (n === 1 ? "riassegnata" : "riassegnate"), tone: "neutral" },
  { id: "estimated", section: "changed", label: (n) => (n === 1 ? "stima cambiata" : "stime cambiate"), tone: "neutral" },
  { id: "ci", section: "attention", label: () => "CI rossa", tone: "fail" },
  { id: "changes", section: "attention", label: () => "modifiche richieste", tone: "warn" },
  { id: "waiting", section: "attention", label: () => "review in attesa", tone: "warn" },
];

/** The group's words, with the flag under its board's name. */
export function groupLabel(group: StandupGroup, count: number, flag: FlagMeaning): string {
  return group.id === "flagged" ? flagShort(flag) : group.label(count);
}

/** A review is "waiting" once it has sat this long without an answer. */
export const REVIEW_WAIT_HOURS = 48;

export interface StandupInput {
  events: ChangeEvent[];
  issues: SprintIssue[];
  columns: BoardColumn[];
  sprint: SprintStart;
  hidden: Set<string>;
  prs: PullRequestSummary[];
  now: Date;
  flag?: FlagMeaning;
}

export function buildStandup(input: StandupInput): Standup {
  const { hidden, now } = input;
  const standup: Standup = {
    closed: [], flagged: [], movedBack: [], moved: [], added: [], assigned: [], estimated: [],
    ci: [], changes: [], waiting: [],
  };
  const changes = summarizeChanges(input.events, input.issues, input.columns, input.sprint, hidden, input.flag);
  for (const [key, change] of changes) {
    for (const item of change.kinds) standup[item.kind].push({ key, text: item.text });
  }

  // GitHub: the state of the PRs right now.
  const visible = input.issues.filter((issue) => !hidden.has(issue.key)).map((issue) => issue.key);
  const byKey = prsByStory(input.prs);
  for (const key of visible) {
    for (const pr of byKey.get(key) ?? []) {
      const label = `${repoName(pr.repo)} #${pr.id}`;
      if (pr.hasFailedPipeline || pr.pipelineState === "failure") {
        standup.ci.push({ key, text: label });
      } else if (pr.reviewState === "changes-requested") {
        const who = pr.blockingReviewers.map((actor) => actor.login).join(", ");
        standup.changes.push({ key, text: who ? `${label} · ${who}` : label });
      } else if (!pr.isDraft && pr.reviewState === "needs-review" && hoursSince(pr.createdAtIso, now) >= REVIEW_WAIT_HOURS) {
        standup.waiting.push({ key, text: `${label} · da ${Math.floor(hoursSince(pr.createdAtIso, now) / 24)} g` });
      }
    }
  }
  return standup;
}

export function standupSectionCount(standup: Standup, section: StandupSection): number {
  return STANDUP_GROUPS.filter((group) => group.section === section).reduce((total, group) => total + standup[group.id].length, 0);
}

export function standupCount(standup: Standup): number {
  return STANDUP_GROUPS.reduce((total, group) => total + standup[group.id].length, 0);
}

function hoursSince(iso: string, now: Date): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : (now.getTime() - at) / 3_600_000;
}

function repoName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

// ── Pull request signal ───────────────────────────────────────────────────────

export type PrSignal = "ci" | "changes" | "waiting" | "approved" | "review" | "draft";

export function prsByStory(prs: PullRequestSummary[]): Map<string, PullRequestSummary[]> {
  const map = new Map<string, PullRequestSummary[]>();
  for (const pr of prs) {
    if (!pr.jiraKey) continue;
    const list = map.get(pr.jiraKey) ?? [];
    list.push(pr);
    map.set(pr.jiraKey, list);
  }
  return map;
}

/** The one thing worth a dot on the card, worst first. */
export function prSignal(prs: PullRequestSummary[], now: Date): PrSignal | null {
  if (prs.length === 0) return null;
  if (prs.some((pr) => pr.hasFailedPipeline || pr.pipelineState === "failure")) return "ci";
  if (prs.some((pr) => pr.reviewState === "changes-requested")) return "changes";
  const open = prs.filter((pr) => !pr.isDraft);
  if (open.length === 0) return "draft";
  if (open.some((pr) => pr.reviewState === "needs-review" && hoursSince(pr.createdAtIso, now) >= REVIEW_WAIT_HOURS)) {
    return "waiting";
  }
  if (open.every((pr) => pr.reviewState === "approved")) return "approved";
  return "review";
}

export const PR_SIGNAL_LABEL: Record<PrSignal, string> = {
  ci: "CI fallita",
  changes: "Modifiche richieste",
  waiting: "Review in attesa da più di 2 giorni",
  approved: "PR approvata",
  review: "PR in review",
  draft: "PR in bozza",
};

// ── People ────────────────────────────────────────────────────────────────────

export interface PersonRow {
  /** Account id, or "" for unassigned stories. */
  id: string;
  person: JiraPerson | null;
}

/** People with stories in the sprint: me first, then by name, unassigned last. */
export function peopleOf(issues: SprintIssue[], me: JiraPerson | null): PersonRow[] {
  const people = new Map<string, JiraPerson>();
  let unassigned = false;
  for (const issue of issues) {
    if (issue.assignee) people.set(issue.assignee.accountId, issue.assignee);
    else unassigned = true;
  }
  const rows: PersonRow[] = [...people.values()]
    .sort((a, b) => {
      if (me && a.accountId === me.accountId) return -1;
      if (me && b.accountId === me.accountId) return 1;
      return a.displayName.localeCompare(b.displayName, "it");
    })
    .map((person) => ({ id: person.accountId, person }));
  if (unassigned) rows.push({ id: "", person: null });
  return rows;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Search ────────────────────────────────────────────────────────────────────

export function matchesQuery(issue: SprintIssue, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [issue.key, issue.summary, issue.assignee?.displayName ?? "", issue.epic ?? "", ...issue.labels]
    .join("\n")
    .toLowerCase()
    .includes(q);
}

// ── Transitions ───────────────────────────────────────────────────────────────

export function transitionsInto(options: TransitionOption[], column: BoardColumn): TransitionOption[] {
  return options.filter((option) => column.statusIds.includes(option.toStatusId));
}

// ── Categories ────────────────────────────────────────────────────────────────

export const CATEGORY_COLORS = ["#0891b2", "#7c3aed", "#d97706", "#db2777", "#059669", "#2563eb", "#64748b"];

export function nextCategoryColor(categories: SprintCategory[]): string {
  const used = new Set(categories.map((category) => category.color));
  return CATEGORY_COLORS.find((color) => !used.has(color)) ?? CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length];
}

/** Moves `keys` into `targetId` (null = back on the board): a story belongs to
 *  one category at most. Returns new category objects, never mutates. */
export function assignCategory(categories: SprintCategory[], keys: string[], targetId: string | null): SprintCategory[] {
  const moving = new Set(keys);
  return categories.map((category) => {
    const kept = category.keys.filter((key) => !moving.has(key));
    if (category.id !== targetId) return { ...category, keys: kept };
    return { ...category, keys: [...kept, ...keys.filter((key, i) => keys.indexOf(key) === i)] };
  });
}

// ── Attachments ───────────────────────────────────────────────────────────────

/** Formats the webview can show in an `<img>`. HEIC, TIFF, PSD… stay files. */
const PREVIEWABLE = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/avif",
  "image/x-icon", "image/vnd.microsoft.icon",
]);

export function isPreviewable(mimeType: string): boolean {
  return PREVIEWABLE.has(mimeType.trim().toLowerCase());
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 })} MB`;
}

/** Image type from the first bytes: a thumbnail may come back in another
 *  format than the file, and the blob it becomes must say the right one. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (starts(0x42, 0x4d)) return "image/bmp";
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

/** The attachment a media node shows: the backend's pairing first, else the
 *  file name the editor recorded, when it names a single attachment. An id
 *  paired with an attachment of another issue comes back with no metadata. */
export function attachmentForMedia(
  attrs: Record<string, unknown>,
  detail: Pick<IssueDetail, "attachments" | "media">,
): AttachmentRef | null {
  const mediaId = typeof attrs.id === "string" ? attrs.id : "";
  const name = typeof attrs.alt === "string" ? attrs.alt.trim() : "";
  const paired = mediaId ? detail.media[mediaId] : undefined;
  if (paired) {
    return (
      detail.attachments.find((att) => att.id === paired) ??
      { id: paired, filename: name || "Allegato", mimeType: "", size: 0, created: null, author: null }
    );
  }
  if (!name) return null;
  const named = detail.attachments.filter((att) => att.filename === name);
  return named.length === 1 ? named[0] : null;
}
