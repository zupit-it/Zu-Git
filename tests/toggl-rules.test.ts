import { test } from "node:test";
import assert from "node:assert/strict";

import { TAG, checkEntry, fixEntry, storyIds, withoutStoryIds, type RuleContext, type RuleEntry } from "../src/toggl-rules.ts";

const CLIENT_PROJECT = 1;
const OTHER_CLIENT_PROJECT = 2;
const ZUPIT_PROJECT = 3;
const PULINET = 4;
const PULINET_TM = 5;

const context: RuleContext = {
  projects: [
    { id: CLIENT_PROJECT, name: "Pentagon - App", clientName: "Pentagon" },
    { id: OTHER_CLIENT_PROJECT, name: "Acme - Portal", clientName: "Acme" },
    { id: ZUPIT_PROJECT, name: "Formazione", clientName: "Zupit" },
    { id: PULINET, name: "Pulinet - Gestionale", clientName: "Pulinet" },
    { id: PULINET_TM, name: "Pulinet - Gestionale T&M", clientName: "Pulinet" },
  ],
  tags: Object.values(TAG),
  projectForPrefix: (prefix) => (prefix === "PENT" ? CLIENT_PROJECT : null),
  summaryOf: (key) => (key === "PENT-12" ? "Login page" : null),
};

const entry = (overrides: Partial<RuleEntry>): RuleEntry => ({
  description: "PENT-12 Login page",
  projectId: CLIENT_PROJECT,
  tags: [],
  billable: true,
  ...overrides,
});
const codes = (value: RuleEntry) => checkEntry(value, context).map((issue) => issue.code);

test("a story entry on its project, billable, without tag, is clean", () => {
  assert.deepEqual(codes(entry({})), []);
});

test("a storyless tag next to a story id is the bot's 'Remove the tag in StoryId entry'", () => {
  const value = entry({ description: "PENT-6416 / PENT-6417 — coordinamento banner", tags: [TAG.AnalisiProgettazione] });
  assert.ok(codes(value).includes("tag-with-story"));
  assert.deepEqual(fixEntry(value, context).entry.tags, []);
});

test("code review, support and pair programming may sit next to a story id", () => {
  assert.deepEqual(codes(entry({ tags: [TAG.CodeReview] })), []);
  assert.deepEqual(codes(entry({ tags: [TAG.PairProgramming] })), []);
  assert.deepEqual(codes(entry({ description: "Pairing col team", tags: [TAG.PairProgramming] })), ["pair-needs-story"]);
});

test("project work needs a story id or a tag, and must be billable", () => {
  assert.deepEqual(codes(entry({ description: "Riunione", billable: false })), ["must-be-billable", "tag-or-story"]);
  assert.deepEqual(codes(entry({ description: "Riunione", tags: [TAG.StandupCheck] })), []);
});

test("Zupit entries are non-billable and untagged", () => {
  const value = entry({ description: "Formazione Rust", projectId: ZUPIT_PROJECT, tags: [TAG.Stime], billable: true });
  assert.deepEqual(codes(value), ["zupit-billable", "zupit-tag"]);
  const { entry: fixed, fixed: count } = fixEntry(value, context);
  assert.equal(count, 2);
  assert.deepEqual({ tags: fixed.tags, billable: fixed.billable }, { tags: [], billable: false });
});

test("missing project stops the checks and is filled from history", () => {
  const issues = checkEntry(entry({ projectId: null, tags: [TAG.Stime] }), context);
  assert.deepEqual(issues.map((issue) => issue.code), ["missing-project"]);
  assert.equal(fixEntry(entry({ projectId: null }), context).entry.projectId, CLIENT_PROJECT);
});

test("a description that is only the key gets the story title", () => {
  assert.ok(codes(entry({ description: "PENT-12:" })).includes("id-only"));
  assert.equal(fixEntry(entry({ description: "PENT-12" }), context).entry.description, "PENT-12 Login page");
});

test("non lo so skips every other check", () => {
  assert.deepEqual(codes(entry({ description: "Boh", tags: [TAG.NonLoSo], billable: false })), []);
});

test("a key booked on another project than usual is advice, not fixed in bulk", () => {
  const value = entry({ projectId: OTHER_CLIENT_PROJECT });
  const issues = checkEntry(value, context);
  assert.deepEqual(issues.map((issue) => [issue.code, issue.severity]), [["project-key", "advice"]]);
  assert.equal(fixEntry(value, context).fixed, 0);
});

test("T&M work for a T&M client moves to the T&M project", () => {
  const value = entry({ description: "PUL-3 spike sincronizzazione", projectId: PULINET });
  assert.deepEqual(codes(value), ["time-material"]);
  assert.equal(fixEntry(value, context).entry.projectId, PULINET_TM);
});

test("several stories in one entry are advice, with a split and a sprint-work fix", () => {
  const value = entry({ description: "PENT-6335 / PENT-6405 / PENT-12 — analisi, piani e avvio storie sprint" });
  const issue = checkEntry(value, context).find((candidate) => candidate.code === "many-stories");
  assert.ok(issue);
  assert.equal(issue.severity, "advice");
  const split = issue.actions.find((action) => action.kind === "split");
  assert.deepEqual(split?.kind === "split" ? split.descriptions : [], [
    "PENT-6335 analisi, piani e avvio storie sprint",
    "PENT-6405 analisi, piani e avvio storie sprint",
    "PENT-12 Login page",
  ]);
  const sprint = issue.actions.find((action) => action.kind === "patch");
  assert.deepEqual(sprint?.kind === "patch" ? sprint.patch : null, {
    description: "Analisi, piani e avvio storie sprint",
    tags: [TAG.AnalisiProgettazione],
  });
});

test("story ids are read the way the bot reads them", () => {
  assert.deepEqual(storyIds("fix UTF-8 in PENT-1, PENT-1 again"), ["UTF-8", "PENT-1"]);
  assert.deepEqual(storyIds("pent-1 lowercase"), []);
  assert.equal(withoutStoryIds("Review PENT-1 / PENT-2 — merge"), "Review — merge");
});
