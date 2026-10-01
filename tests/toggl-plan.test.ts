// Run with `npm test` (Node ≥ 23 runs TypeScript directly).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidatesFor,
  eventKeys,
  normalizeDescription,
  planStories,
  type Assignment,
  type FillStory,
  type PlannerActivity,
  type PlannerIssue,
} from "../src/toggl-plan.ts";

const DAY = "2026-10-01";
const at = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return new Date(2026, 9, 1, h, m).toISOString();
};
const min = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
};
const range = { from: min("08:00"), to: min("14:00") };

function issue(key: string, stage: PlannerIssue["stage"], statusChangedAt?: string): PlannerIssue {
  return { key, summary: key, status: stage, stage, statusChangedAt };
}

function minutesPerStory(plan: Assignment[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of plan) {
    const key = row.chosen?.key ?? "-";
    totals[key] = (totals[key] ?? 0) + row.to - row.from;
  }
  return totals;
}

test("two stories with no evidence share the day in contiguous blocks, not halves of every gap", () => {
  const issues = [issue("PENT-1", "in-progress"), issue("PENT-2", "in-progress")];
  // Three gaps around two meetings.
  const gaps = [
    { from: min("08:15"), to: min("10:00") },
    { from: min("10:30"), to: min("12:00") },
    { from: min("12:30"), to: min("14:00") },
  ];
  const plan = planStories(gaps, candidatesFor(issues, range, DAY, 15), [], DAY, 15);

  const totals = minutesPerStory(plan);
  // Roughly even: hour-long blocks trump an exact split, so the shares may
  // differ by up to a block.
  assert.ok(Math.abs(totals["PENT-1"] - totals["PENT-2"]) <= 90, JSON.stringify(totals));
  // The old planner produced six rows (each gap halved); blocks now follow
  // each other: at most one switch of story.
  const switches = plan.filter((row, i) => i > 0 && row.chosen?.key !== plan[i - 1].chosen?.key).length;
  assert.equal(switches, 1, JSON.stringify(plan.map((r) => [r.from, r.to, r.chosen?.key])));
  assert.ok(plan.every((row) => row.basis === "status"));
});

test("activity decides who owns the time, over a story merely left in progress", () => {
  const issues = [
    issue("PENT-STALE", "in-progress"),
    issue("PENT-A", "touched"),
    issue("PENT-B", "touched"),
  ];
  const activity: PlannerActivity[] = [
    { key: "PENT-A", at: at("09:20"), source: "commit", kind: "end", detail: "fix" },
    { key: "PENT-A", at: at("09:55"), source: "commit", kind: "end", detail: "more" },
    ...["11:00", "11:20", "11:40", "12:00", "12:20"].map((clock) => ({
      key: "PENT-B",
      at: at(clock),
      source: "ai-session",
      kind: "during",
      detail: "Claude Code",
    })),
  ];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15);

  const owner = (clock: string) => plan.find((row) => row.from <= min(clock) && row.to > min(clock))?.chosen?.key;
  assert.equal(owner("09:00"), "PENT-A");
  assert.equal(owner("11:30"), "PENT-B");
  const morning = plan.find((row) => row.chosen?.key === "PENT-A");
  assert.equal(morning?.basis, "activity");
  assert.match(morning?.reason ?? "", /2 commits/);
  assert.match(plan.find((row) => row.chosen?.key === "PENT-B")?.reason ?? "", /Claude Code/);
});

test("a quick fix on a story in merge request gets its slot", () => {
  const issues = [issue("PENT-WIP", "in-progress"), issue("PENT-MR", "merge-request")];
  const activity: PlannerActivity[] = [
    { key: "PENT-MR", at: at("10:45"), source: "commit", kind: "end", detail: "review fix" },
  ];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15);

  const fix = plan.find((row) => row.chosen?.key === "PENT-MR");
  assert.ok(fix, "the merge-request story must appear");
  assert.ok(fix.from < min("10:45") && fix.to >= min("10:45"), JSON.stringify(fix));
  assert.ok(minutesPerStory(plan)["PENT-WIP"] > minutesPerStory(plan)["PENT-MR"]);
});

test("a move to Developed claims the work before it", () => {
  const issues = [issue("PENT-WIP", "in-progress"), issue("PENT-DONE", "touched")];
  const activity: PlannerActivity[] = [
    { key: "PENT-DONE", at: at("12:00"), source: "jira", kind: "end", detail: "→ Developed" },
  ];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15);
  const owner = (clock: string) => plan.find((row) => row.from <= min(clock) && row.to > min(clock))?.chosen?.key;
  assert.equal(owner("11:30"), "PENT-DONE");
  assert.equal(owner("13:30"), "PENT-WIP");
});

test("no block shorter than an hour survives inside a long gap", () => {
  const issues = [issue("PENT-1", "in-progress"), issue("PENT-2", "touched")];
  const activity: PlannerActivity[] = [
    { key: "PENT-2", at: at("10:00"), source: "ai-session", kind: "during", detail: "Codex" },
  ];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15);
  assert.ok(plan.every((row) => row.to - row.from >= 60), JSON.stringify(plan.map((r) => [r.from, r.to])));
});

test("alternatives are offered when the pick rests on statuses only", () => {
  const issues = [issue("PENT-1", "in-progress"), issue("PENT-2", "in-progress"), issue("PENT-3", "merge-request")];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), [], DAY, 15);
  for (const row of plan) {
    assert.ok(row.alternatives.length >= 1);
    assert.ok(!row.alternatives.includes(row.chosen?.key ?? ""));
  }
});

test("calendar titles normalise like the Rust side, accents included", () => {
  assert.equal(normalizeDescription("ATTIVITÀ di stima PENT-12 #3"), "attività di stima");
  assert.deepEqual(eventKeys({ recurringEventId: "abc", summary: "Weekly Sync 12/05" }), [
    "rec:abc",
    "title:weekly sync",
  ]);
  assert.deepEqual(eventKeys({ summary: "Retro" }), ["title:retro"]);
});

test("filling shares the unexplained time by remaining estimate, in solid blocks", () => {
  const issues = [
    issue("PENT-A", "touched"),
    issue("PENT-BIG", "sprint"),
    issue("PENT-SPENT", "sprint"),
    issue("PENT-BUG", "sprint"),
  ];
  const activity: PlannerActivity[] = [
    { key: "PENT-A", at: at("09:00"), source: "commit", kind: "end", detail: "a" },
    { key: "PENT-A", at: at("09:50"), source: "commit", kind: "end", detail: "b" },
  ];
  const fill: FillStory[] = [
    { key: "PENT-BIG", points: 8, pointsAssumed: false, bookedMinutes: 360, budgetMinutes: 1440, weight: 1080 },
    { key: "PENT-SPENT", points: 1, pointsAssumed: false, bookedMinutes: 300, budgetMinutes: 180, weight: 0 },
    { key: "PENT-BUG", points: 1, pointsAssumed: true, bookedMinutes: 0, budgetMinutes: 180, weight: 180 },
    { key: "PENT-A", points: 3, pointsAssumed: false, bookedMinutes: 540, budgetMinutes: 540, weight: 0 },
  ];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15, fill);
  const totals = minutesPerStory(plan);

  assert.equal(plan.find((row) => row.from <= min("09:00") && row.to > min("09:00"))?.chosen?.key, "PENT-A");
  assert.equal(totals["PENT-SPENT"], undefined, "a story whose estimate is spent gets no filler");
  assert.ok(totals["PENT-BIG"] > (totals["PENT-BUG"] ?? 0), JSON.stringify(totals));
  assert.ok(plan.every((row) => row.to - row.from >= 60), JSON.stringify(plan.map((r) => [r.from, r.to, r.chosen?.key])));
  const filled = plan.find((row) => row.chosen?.key === "PENT-BIG");
  assert.equal(filled?.basis, "fill");
  assert.match(filled?.reason ?? "", /8 pt · 6h prenotate su 24h/);
});

test("without filling, sprint-only stories never take a slot", () => {
  const issues = [issue("PENT-1", "in-progress"), issue("PENT-SPRINT", "sprint")];
  const plan = planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), [], DAY, 15);
  assert.equal(minutesPerStory(plan)["PENT-SPRINT"], undefined);
});

test("moves made in bulk weigh less than a move on its own", () => {
  const issues = [issue("PENT-WIP", "in-progress"), issue("PENT-BULK", "touched")];
  const bulk: PlannerActivity[] = [
    { key: "PENT-BULK", at: at("12:00"), source: "jira", kind: "end", detail: "→ Developed (in blocco)", weight: 0.2 },
  ];
  const single: PlannerActivity[] = [{ ...bulk[0], weight: 1 }];
  const plan = (activity: PlannerActivity[]) =>
    minutesPerStory(planStories([{ from: min("08:00"), to: min("14:00") }], candidatesFor(issues, range, DAY, 15), activity, DAY, 15));
  assert.ok((plan(bulk)["PENT-BULK"] ?? 0) < (plan(single)["PENT-BULK"] ?? 0));
});
