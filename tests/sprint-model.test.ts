import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FLAG,
  STANDUP_GROUPS,
  groupLabel,
  parseClock,
  summarizeChanges,
  assignCategory,
  attachmentForMedia,
  formatBytes,
  isPreviewable,
  sniffImageType,
  buildStandup,
  columnIndexOf,
  hiddenKeys,
  matchesQuery,
  nextCategoryColor,
  peopleOf,
  previousStandup,
  prSignal,
  sprintClock,
  sprintPace,
  standupLabel,
  transitionsInto,
  workingDaysBetween,
  type BoardColumn,
  type ChangeEvent,
  type JiraPerson,
  type SprintCategory,
  type SprintIssue,
} from "../src/sprint-model.ts";
import type { PullRequestSummary } from "../src/shared/pr-model.ts";

const columns: BoardColumn[] = [
  { name: "To Do", statusIds: ["1"], category: "new" },
  { name: "In Progress", statusIds: ["3"], category: "indeterminate" },
  { name: "Review", statusIds: ["5", "6"], category: "indeterminate" },
  { name: "Done", statusIds: ["4"], category: "done" },
];

const sara: JiraPerson = { accountId: "sara", displayName: "Sara Conti", avatarUrl: null };
const luca: JiraPerson = { accountId: "luca", displayName: "Luca Moretti", avatarUrl: null };
const me: JiraPerson = { accountId: "me", displayName: "Zeno Bianchi", avatarUrl: null };

function issue(key: string, statusId: string, overrides: Partial<SprintIssue> = {}): SprintIssue {
  const column = columns.find((c) => c.statusIds.includes(statusId));
  return {
    key,
    summary: `Story ${key}`,
    statusId,
    statusName: column?.name ?? "?",
    statusCategory: column?.category ?? "indeterminate",
    issueType: "Story",
    assignee: null,
    points: null,
    priority: null,
    flagged: false,
    epic: null,
    fixVersions: [],
    labels: [],
    subtasksTotal: 0,
    subtasksDone: 0,
    updated: null,
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    id: 1,
    repo: "org/web",
    title: "PR",
    url: "",
    isDraft: false,
    createdAtIso: "2026-10-08T08:00:00Z",
    authorType: "internal",
    matchStrategy: "title-board",
    jiraKey: "PENT-1",
    jiraSummary: "",
    jiraPriority: "Medium",
    jiraRelease: "",
    jiraReleases: [],
    jiraStatus: "",
    author: "sara",
    assignee: "",
    currentReviewer: "",
    pendingReviewers: [],
    currentApprovers: [],
    staleApprovers: [],
    blockingReviewers: [],
    commentedReviewers: [],
    reviewState: "needs-review",
    hasStaleApproval: false,
    updatedAt: "",
    updatedAtIso: "2026-10-08T08:00:00Z",
    pipelineState: "success",
    hasFailedPipeline: false,
    additions: 1,
    deletions: 1,
    autoMergeMethod: null,
    unresolvedThreads: 0,
    mergeStatus: "clean",
    nodeId: "",
    headRef: "",
    headSha: "",
    baseRef: "",
    body: "",
    ...overrides,
  };
}

test("a status the board does not map falls back to a column of its category", () => {
  assert.equal(columnIndexOf({ statusId: "6", statusCategory: "indeterminate" }, columns), 2);
  assert.equal(columnIndexOf({ statusId: "99", statusCategory: "done" }, columns), 3);
  assert.equal(columnIndexOf({ statusId: "98", statusCategory: "indeterminate" }, columns), 1);
});

test("working days skip weekends, both ends included", () => {
  // Monday 5 → Friday 16 October 2026: two working weeks.
  assert.equal(workingDaysBetween(new Date(2026, 9, 5), new Date(2026, 9, 16)), 10);
  assert.equal(workingDaysBetween(new Date(2026, 9, 10), new Date(2026, 9, 11)), 0, "a weekend has none");
});

test("sprint clock counts today as half a day gone", () => {
  const sprint = { id: 1, name: "S", state: "active", startDate: "2026-10-05T07:00:00Z", endDate: "2026-10-16T16:00:00Z", goal: null };
  const clock = sprintClock(sprint, new Date(2026, 9, 8, 11)); // Thursday, day 4
  assert.ok(clock);
  assert.equal(clock.day, 4);
  assert.equal(clock.totalDays, 10);
  assert.equal(clock.elapsed, 0.35);
  assert.equal(clock.remainingDays, 7);
});

test("sprint clock: a weekend counts the week whole, a finished sprint all of it", () => {
  const sprint = { id: 1, name: "S", state: "active", startDate: "2026-10-05T07:00:00Z", endDate: "2026-10-09T16:00:00Z", goal: null };
  const friday = sprintClock(sprint, new Date(2026, 9, 9, 11));
  assert.deepEqual([friday?.day, friday?.elapsed, friday?.ended], [5, 0.9, false], "the last day in progress counts half");
  const sunday = sprintClock(sprint, new Date(2026, 9, 11, 19));
  assert.deepEqual([sunday?.day, sunday?.totalDays, sunday?.elapsed, sunday?.remainingDays, sunday?.ended], [5, 5, 1, 0, true]);
  const long = { ...sprint, endDate: "2026-10-16T16:00:00Z" };
  const weekend = sprintClock(long, new Date(2026, 9, 10, 12));
  assert.deepEqual([weekend?.day, weekend?.elapsed, weekend?.remainingDays], [5, 0.5, 5], "Saturday: five working days behind, five ahead");
  const before = sprintClock(long, new Date(2026, 9, 2, 12));
  assert.deepEqual([before?.elapsed, before?.remainingDays], [0, 10]);
});

test("pace: points closed per day so far and per day still needed", () => {
  const issues = [
    issue("PENT-1", "4", { points: 5 }),
    issue("PENT-2", "3", { points: 8 }),
    issue("PENT-3", "1", { points: 3 }),
  ];
  const pace = sprintPace(issues, columns, { day: 3, totalDays: 10, elapsed: 0.25, remainingDays: 8 });
  assert.equal(pace.done, 5);
  assert.equal(pace.total, 16);
  assert.equal(pace.perDay, 2);
  assert.equal(pace.needed, 11 / 8);
});

test("the standup looks back to the previous working day, at the team's time", () => {
  const monday = new Date(2026, 9, 12, 10, 0);
  const since = previousStandup(monday);
  assert.equal(since.getDay(), 5, "on Monday it is Friday");
  assert.equal(since.getHours(), 8, "8:00 unless set otherwise");
  assert.equal(since.getMinutes(), 0);
  assert.equal(standupLabel(since, monday), "venerdì 8:00");
  const tuesday = new Date(2026, 9, 13, 7, 50);
  assert.equal(standupLabel(previousStandup(tuesday, { hour: 9, minute: 30 }), tuesday), "ieri 9:30");
});

test("standup times are typed loosely", () => {
  assert.deepEqual(parseClock("8"), { hour: 8, minute: 0 });
  assert.deepEqual(parseClock("8:15"), { hour: 8, minute: 15 });
  assert.deepEqual(parseClock("08.15"), { hour: 8, minute: 15 });
  assert.deepEqual(parseClock("930"), { hour: 9, minute: 30 });
  assert.deepEqual(parseClock("0815"), { hour: 8, minute: 15 });
  assert.equal(parseClock("25:00"), null);
  assert.equal(parseClock("8:75"), null);
  assert.equal(parseClock("domani"), null);
});

test("changes per story: net moves, the most telling first, with their history", () => {
  const issues = [
    issue("PENT-1", "4"),
    issue("PENT-2", "3"),
    issue("PENT-3", "3", { flagged: true }),
    issue("PENT-4", "5", { assignee: sara, points: 5 }),
  ];
  const at = (h: number) => `2026-10-09T${String(h).padStart(2, "0")}:00:00.000+0200`;
  const ev = (key: string, hour: number, field: ChangeEvent["field"], from: string | null, to: string | null, fromString: string | null, toString: string | null): ChangeEvent => ({
    key, at: at(hour), author: "Luca", field, from, to, fromString, toString,
  });
  const changes = summarizeChanges(
    [
      ev("PENT-1", 10, "status", "3", "4", "In Progress", "Done"),
      ev("PENT-1", 9, "status", "1", "3", "To Do", "In Progress"),
      ev("PENT-2", 10, "status", "3", "5", "In Progress", "Review"),
      ev("PENT-2", 11, "status", "5", "3", "Review", "In Progress"),
      ev("PENT-3", 12, "flag", null, null, null, "Impediment"),
      ev("PENT-3", 12, "status", "1", "3", "To Do", "In Progress"),
      ev("PENT-4", 13, "assignee", "luca", "sara", "Luca Moretti", "Sara Conti"),
      ev("PENT-4", 14, "points", null, null, "3", "5"),
    ],
    issues,
    columns,
    42,
    new Set(),
  );
  assert.equal(changes.get("PENT-1")?.kind, "closed", "out of order events are sorted: To Do → Done is a close");
  assert.equal(changes.get("PENT-1")?.lines.length, 2);
  assert.ok(!changes.has("PENT-2"), "there and back again is no news");
  assert.deepEqual(changes.get("PENT-3")?.kinds.map((k) => k.kind), ["moved", "flagged"], "a flag is news after the move");
  assert.equal(changes.get("PENT-3")?.kinds[0].short, "da To Do");
  const four = changes.get("PENT-4");
  assert.deepEqual(four?.kinds.map((k) => [k.kind, k.text]), [["assigned", "Luca Moretti → Sara Conti"], ["estimated", "3 → 5 pt"]]);
  assert.match(four?.lines[1] ?? "", /Luca: stima 3 → 5$/);
});

test("standup: one line per story, closed apart, filed stories left out", () => {
  const issues = [
    issue("PENT-1", "4", { points: 3 }),
    issue("PENT-2", "5"),
    issue("PENT-3", "1"),
    issue("PENT-4", "3", { flagged: true }),
    issue("PENT-9", "4"),
  ];
  const event = (key: string, field: ChangeEvent["field"], from: string | null, to: string | null, toString: string | null = null): ChangeEvent => ({
    key, at: "2026-10-09T10:00:00.000+0200", author: "Sara", field, from, to, fromString: null, toString,
  });
  const standup = buildStandup({
    events: [
      event("PENT-1", "status", "1", "3"),
      event("PENT-1", "status", "3", "4"),
      event("PENT-2", "status", "3", "5"),
      event("PENT-3", "status", "3", "1"),
      event("PENT-3", "sprint", "", "41,42"),
      event("PENT-4", "flag", null, null, "Impediment"),
      event("PENT-9", "status", "3", "4"),
    ],
    issues,
    columns,
    sprintId: 42,
    hidden: new Set(["PENT-9"]),
    prs: [],
    now: new Date("2026-10-09T12:00:00Z"),
  });
  assert.deepEqual(standup.closed.map((i) => i.key), ["PENT-1"], "a story moved twice is closed once; a filed one is not news");
  assert.deepEqual(standup.moved.map((i) => i.text), ["In Progress → Review"]);
  assert.deepEqual(standup.movedBack.map((i) => i.key), ["PENT-3"]);
  assert.deepEqual(standup.added.map((i) => i.key), ["PENT-3"]);
  assert.deepEqual(standup.flagged.map((i) => i.key), ["PENT-4"]);
});

test("standup: GitHub state of the stories' PRs", () => {
  const issues = [issue("PENT-1", "3"), issue("PENT-2", "5"), issue("PENT-3", "5")];
  const standup = buildStandup({
    events: [],
    issues,
    columns,
    sprintId: 1,
    hidden: new Set(),
    prs: [
      pr({ jiraKey: "PENT-1", hasFailedPipeline: true, pipelineState: "failure" }),
      pr({ jiraKey: "PENT-2", reviewState: "changes-requested", blockingReviewers: [{ login: "luca" }] }),
      pr({ jiraKey: "PENT-3", createdAtIso: "2026-10-05T08:00:00Z" }),
    ],
    now: new Date("2026-10-09T12:00:00Z"),
  });
  assert.deepEqual(standup.ci.map((i) => i.key), ["PENT-1"]);
  assert.equal(standup.changes[0].text, "web #1 · luca");
  assert.deepEqual(standup.waiting.map((i) => i.key), ["PENT-3"]);
});

test("PR signal: worst first, approved only when every open PR is", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  assert.equal(prSignal([], now), null);
  assert.equal(prSignal([pr({ reviewState: "approved" }), pr({ pipelineState: "failure" })], now), "ci");
  assert.equal(prSignal([pr({ reviewState: "approved" }), pr({ reviewState: "changes-requested" })], now), "changes");
  assert.equal(prSignal([pr({ reviewState: "approved" })], now), "approved");
  assert.equal(prSignal([pr({ reviewState: "needs-review", createdAtIso: "2026-10-09T08:00:00Z" })], now), "review");
  assert.equal(prSignal([pr({ reviewState: "needs-review", createdAtIso: "2026-10-01T08:00:00Z" })], now), "waiting");
  assert.equal(prSignal([pr({ isDraft: true })], now), "draft");
});

test("people: me first, then by name, unassigned last", () => {
  const rows = peopleOf(
    [issue("A-1", "1", { assignee: sara }), issue("A-2", "1"), issue("A-3", "1", { assignee: me }), issue("A-4", "1", { assignee: luca })],
    me,
  );
  assert.deepEqual(rows.map((r) => r.id), ["me", "luca", "sara", ""]);
});

test("search matches key, title, person, epic and labels", () => {
  const story = issue("PENT-12", "1", { summary: "Login page", assignee: sara, epic: "Onboarding", labels: ["frontend"] });
  assert.ok(matchesQuery(story, "pent-12"));
  assert.ok(matchesQuery(story, "login"));
  assert.ok(matchesQuery(story, "sara"));
  assert.ok(matchesQuery(story, "onboard"));
  assert.ok(matchesQuery(story, "frontend"));
  assert.ok(!matchesQuery(story, "backend"));
});

test("transitions into a column are those reaching one of its statuses", () => {
  const options = [
    { id: "1", name: "Start", toStatusId: "3", toStatusName: "In Progress", toCategory: "indeterminate", needsInput: false },
    { id: "2", name: "Review", toStatusId: "5", toStatusName: "Code review", toCategory: "indeterminate", needsInput: false },
    { id: "3", name: "QA", toStatusId: "6", toStatusName: "QA", toCategory: "indeterminate", needsInput: false },
  ];
  assert.deepEqual(transitionsInto(options, columns[2]).map((o) => o.id), ["2", "3"]);
});

test("a story sits in one category at most", () => {
  const categories: SprintCategory[] = [
    { id: "a", name: "Ricorrenti", color: "#0891b2", keys: ["PENT-1", "PENT-2"] },
    { id: "b", name: "Spike", color: "#7c3aed", keys: [] },
  ];
  const moved = assignCategory(categories, ["PENT-2", "PENT-3", "PENT-3"], "b");
  assert.deepEqual(moved[0].keys, ["PENT-1"]);
  assert.deepEqual(moved[1].keys, ["PENT-2", "PENT-3"]);
  assert.deepEqual(categories[0].keys, ["PENT-1", "PENT-2"], "the input is not mutated");
  const back = assignCategory(moved, ["PENT-1"], null);
  assert.deepEqual([...hiddenKeys(back)].sort(), ["PENT-2", "PENT-3"]);
  assert.equal(nextCategoryColor(categories), "#d97706", "the first colour not taken");
});

test("attachments: media pairing, then file name", () => {
  const attachments = [
    { id: "1", filename: "shot.png", mimeType: "image/png", size: 10, created: null, author: null },
    { id: "2", filename: "copy.png", mimeType: "image/png", size: 10, created: null, author: null },
    { id: "3", filename: "copy.png", mimeType: "image/png", size: 10, created: null, author: null },
  ];
  const detail = { attachments, media: { "uuid-a": "2", "uuid-x": "99" } };
  assert.equal(attachmentForMedia({ id: "uuid-a" }, detail)?.id, "2");
  assert.equal(attachmentForMedia({ id: "uuid-b", alt: "shot.png" }, detail)?.id, "1");
  assert.equal(attachmentForMedia({ id: "uuid-c", alt: "copy.png" }, detail), null, "an ambiguous name proves nothing");
  const foreign = attachmentForMedia({ id: "uuid-x", alt: "from-elsewhere.png" }, detail);
  assert.deepEqual([foreign?.id, foreign?.filename, foreign?.mimeType], ["99", "from-elsewhere.png", ""]);
});

test("attachments: what the webview can show, sizes, and the type in the bytes", () => {
  assert.ok(isPreviewable("image/PNG"));
  assert.ok(!isPreviewable("image/heic"));
  assert.ok(!isPreviewable("application/pdf"));
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1572864), "1,5 MB");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
  assert.equal(sniffImageType(new TextEncoder().encode("%PDF-1.7")), null);
});

test("Jira's flag is information under the board's name, never a block", () => {
  const issues = [issue("PENT-7", "5", { flagged: true })];
  const events: ChangeEvent[] = [
    { key: "PENT-7", at: "2026-10-09T10:00:00.000+0200", author: "Luca", field: "status", from: "3", to: "5", fromString: "In Progress", toString: "Review" },
    { key: "PENT-7", at: "2026-10-09T10:05:00.000+0200", author: "Luca", field: "flag", from: null, to: null, fromString: null, toString: "Impediment" },
  ];
  const plain = summarizeChanges(events, issues, columns, 1, new Set());
  assert.deepEqual(plain.get("PENT-7")?.kinds.map((k) => k.short), ["da In Progress", "con flag"]);
  assert.match(plain.get("PENT-7")?.lines[1] ?? "", /flag messo$/);
  const inTest = summarizeChanges(events, issues, columns, 1, new Set(), { label: "In test" });
  assert.deepEqual(inTest.get("PENT-7")?.kinds.map((k) => k.short), ["da In Progress", "in test"]);
  assert.match(inTest.get("PENT-7")?.lines[1] ?? "", /flag «In test»$/);
  const flagged = STANDUP_GROUPS.find((group) => group.id === "flagged");
  assert.ok(flagged);
  assert.equal(flagged.tone, "info", "never an alarm colour");
  assert.equal(groupLabel(flagged, 2, DEFAULT_FLAG), "con flag");
  assert.equal(groupLabel(flagged, 2, { label: "In test" }), "in test");
});
