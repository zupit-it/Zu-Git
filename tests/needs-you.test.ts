import { test } from "node:test";
import assert from "node:assert/strict";
import { needsViewer } from "../src/needs-you.ts";
import { mockPullRequests, type PullRequestSummary } from "../src/shared/pr-model.ts";

// A PR of someone else's, in order, that asks nothing of anyone.
const quiet: PullRequestSummary = {
  ...mockPullRequests[0]!,
  author: "marta",
  isDraft: false,
  pendingReviewers: [],
  currentApprovers: [],
  blockingReviewers: [],
  reviewState: "approved",
  hasFailedPipeline: false,
  mergeStatus: "clean",
};
const pr = (over: Partial<PullRequestSummary>): PullRequestSummary => ({ ...quiet, ...over });
const me = { login: "Giorgio" };

test("a PR that asks nothing of the viewer does not need them", () => {
  assert.equal(needsViewer(quiet, "giorgio"), false);
  assert.equal(needsViewer(pr({ author: "giorgio" }), "giorgio"), false);
});

test("a review asked of the viewer needs them, until they approve", () => {
  assert.equal(needsViewer(pr({ pendingReviewers: [me] }), "giorgio"), true);
  assert.equal(needsViewer(pr({ pendingReviewers: [me], currentApprovers: [me] }), "giorgio"), false);
});

test("the viewer's own PR needs them with changes requested, a failed check, or conflicts", () => {
  const mine = { author: "Giorgio" };
  assert.equal(needsViewer(pr({ ...mine, reviewState: "changes-requested", blockingReviewers: [{ login: "anna" }] }), "giorgio"), true);
  assert.equal(needsViewer(pr({ ...mine, hasFailedPipeline: true }), "giorgio"), true);
  assert.equal(needsViewer(pr({ ...mine, mergeStatus: "conflicting" }), "giorgio"), true);
  assert.equal(needsViewer(pr({ ...mine, mergeStatus: "blocked" }), "giorgio"), false);
});

test("the viewer's own PR only behind its base does not need them, unless something else does", () => {
  const mine = { author: "Giorgio" };
  assert.equal(needsViewer(pr({ ...mine, mergeStatus: "behind" }), "giorgio"), false);
  assert.equal(needsViewer(pr({ ...mine, mergeStatus: "behind", hasFailedPipeline: true }), "giorgio"), true);
});

test("someone else's failed check or stale branch is theirs to fix", () => {
  assert.equal(needsViewer(pr({ hasFailedPipeline: true, mergeStatus: "conflicting" }), "giorgio"), false);
});

test("a draft, or no viewer, never needs anyone", () => {
  assert.equal(needsViewer(pr({ isDraft: true, pendingReviewers: [me] }), "giorgio"), false);
  assert.equal(needsViewer(pr({ pendingReviewers: [me] }), undefined), false);
});
