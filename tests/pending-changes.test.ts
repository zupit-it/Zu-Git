import { test } from "node:test";
import assert from "node:assert/strict";

import { mockPullRequests, type PullRequestSummary } from "../src/shared/pr-model.ts";
import {
  MAX_READS, PENDING_TTL_MS, RETRY_MS, autoMergeIs, duePendingPrs, givenUpMessage, nextPendingRead, pendingChange,
  prKey, reconcilePending, reviewAskedOf, shownPr, waitingOn, withAnswer, withPending, withoutOwnRead,
  type GitHubSays, type PendingChange,
} from "../src/pending-changes.ts";

/** A PR as GitHub gives it: auto-merge off, behind its base, nobody asked yet. */
function github(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    ...mockPullRequests[0],
    repo: "org/app", id: 12, autoMergeMethod: null, headSha: "aaa", mergeStatus: "behind",
    pendingReviewers: [], currentApprovers: [], staleApprovers: [], blockingReviewers: [], commentedReviewers: [],
    reviewState: "needs-review", updatedAtIso: "2026-11-12T10:00:00Z", unresolvedThreads: 0,
    ...over,
  };
}

/** What GitHub last said, all of it asked for at `askedAt`. */
function says(prs: PullRequestSummary[], askedAt: number): GitHubSays {
  return (key) => ({ pr: prs.find((pr) => prKey(pr) === key), askedAt });
}

const T0 = 1_000_000;
const autoMergeOn = (pr: PullRequestSummary, at = T0): PendingChange =>
  pendingChange(pr, "auto-merge", { label: "Auto-merge on", patch: autoMergeIs("SQUASH") }, at);

test("a change shows on its row, over what GitHub says, until GitHub shows it", () => {
  const pr = github();
  const changes = [autoMergeOn(pr)];

  assert.equal(shownPr(changes, pr).autoMergeMethod, "SQUASH");
  assert.equal(pr.autoMergeMethod, null, "GitHub's PR is not edited");
  assert.equal(waitingOn(changes, pr, "auto-merge")?.label, "Auto-merge on");
  // Another PR's row is its own.
  assert.equal(shownPr(changes, github({ id: 13 })).autoMergeMethod, null);

  // GitHub's answer after the change shows it: nothing waits, nothing is given up.
  assert.deepEqual(reconcilePending(changes, says([github({ autoMergeMethod: "SQUASH" })], T0 + 100), T0 + 900), { waiting: [], expired: [] });
});

test("GitHub is asked once for a change, once more if that answer does not show it, and never again", () => {
  assert.equal(MAX_READS, 2);
  const pr = github();
  const made = [autoMergeOn(pr)];
  // Its PR is read at once.
  assert.deepEqual(duePendingPrs(made, T0), ["org/app/12"]);

  // That answer does not show it (GitHub a moment behind): it waits, with one read left, a while later.
  const first = reconcilePending(made, says([pr], T0 + 50), T0 + 800);
  assert.equal(first.waiting[0].reads, 1);
  assert.deepEqual(duePendingPrs(first.waiting, T0 + 800), []);
  assert.equal(nextPendingRead(first.waiting, T0 + 800), RETRY_MS);
  // The same answer, looked at again, is not a second read.
  assert.equal(reconcilePending(first.waiting, says([pr], T0 + 50), T0 + 900).waiting[0].reads, 1);

  // The second answer shows it: done, in two reads.
  const due = T0 + 800 + RETRY_MS;
  assert.deepEqual(duePendingPrs(first.waiting, due), ["org/app/12"]);
  assert.deepEqual(reconcilePending(first.waiting, says([github({ autoMergeMethod: "SQUASH" })], due), due + 700), { waiting: [], expired: [] });

  // Or it does not: given up and said, the row is GitHub's again, and no read is due any more.
  const second = reconcilePending(first.waiting, says([pr], due), due + 700);
  assert.deepEqual(second.waiting, []);
  assert.equal(givenUpMessage(second.expired), "GitHub does not show it yet: Auto-merge on on org/app#12. The list is what GitHub says — refresh in a moment.");
  assert.equal(nextPendingRead(second.waiting, due + 700), null);
});

test("an answer asked for before the change says nothing about it, and uses none of its reads", () => {
  const changes = [autoMergeOn(github())];
  // A refresh already on its way, which happens to differ: it never saw the change.
  const stale = reconcilePending(changes, says([github({ autoMergeMethod: "MERGE" })], T0 - 800), T0 + 200);
  assert.equal(stale.waiting.length, 1);
  assert.equal(stale.waiting[0].reads, 0);
  // Nor does a PR missing from it mean the PR is gone.
  assert.equal(reconcilePending(changes, says([], T0 - 800), T0 + 200).waiting.length, 1);
});

test("each PR is checked against its own answer, whenever the rest of the list was read", () => {
  const a = github();
  const b = github({ id: 13 });
  const changes = [autoMergeOn(a), autoMergeOn(b, T0 + 10)];
  // Only #12 was read again; the list itself is from before both changes.
  const shown = github({ autoMergeMethod: "SQUASH" });
  const answered: GitHubSays = (key) => (key === "org/app/12" ? { pr: shown, askedAt: T0 + 200 } : { pr: b, askedAt: T0 - 5000 });
  const { waiting, expired } = reconcilePending(changes, answered, T0 + 900);
  assert.deepEqual(expired, []);
  assert.deepEqual(waiting.map((c) => [c.pr, c.reads]), [["org/app/13", 0]]);
});

test("a refresh of the list that lands meanwhile counts as one of the reads", () => {
  // A rebase waits five seconds for its read; the timer's own refresh comes first.
  const changes = [pendingChange(github(), "rebase", { label: "Rebase", readIn: 5000 }, T0)];
  assert.deepEqual(duePendingPrs(changes, T0 + 1000), []);
  assert.equal(nextPendingRead(changes, T0 + 1000), 4000);
  const refreshed = reconcilePending(changes, says([github()], T0 + 1200), T0 + 2000);
  assert.equal(refreshed.waiting[0].reads, 1);
  // So one more read follows, not two.
  assert.equal(nextPendingRead(refreshed.waiting, T0 + 2000), RETRY_MS);
  assert.equal(reconcilePending(refreshed.waiting, says([github()], T0 + 8000), T0 + 8700).expired.length, 1);
});

test("a read that fails is not asked again by ZuGit: the next refresh takes over", () => {
  const pr = github();
  const failed = withoutOwnRead([autoMergeOn(pr), autoMergeOn(github({ id: 13 }))], "org/app/12");
  assert.deepEqual(duePendingPrs(failed, T0 + 60), ["org/app/13"]);
  assert.equal(nextPendingRead(withoutOwnRead(failed, "org/app/13"), T0 + 60), null);
  // The row keeps what was done, as waiting, until GitHub is heard from — here a refresh, showing it.
  assert.equal(shownPr(failed, pr).autoMergeMethod, "SQUASH");
  const refreshed = reconcilePending(failed, says([github({ autoMergeMethod: "SQUASH" }), github({ id: 13 })], T0 + 9000), T0 + 9800);
  assert.deepEqual(refreshed.waiting.map((c) => c.pr), ["org/app/13"]);
});

test("GitHub's news on it ends the wait, even when it is not what was asked", () => {
  // Asked for a review, and they approved before the read.
  const pr = github();
  const changes = [pendingChange(pr, "review-request", { label: "Review asked of anna", subject: "Anna", patch: reviewAskedOf("anna") }, T0)];
  const approved = github({ currentApprovers: [{ login: "anna" }] });
  assert.deepEqual(reconcilePending(changes, says([approved], T0 + 1000), T0 + 2000), { waiting: [], expired: [] });
});

test("GitHub already saying what the row draws ends the wait", () => {
  // On, then off again before GitHub ever showed it on: off is what GitHub says.
  const pr = github();
  let changes = withPending([], autoMergeOn(pr));
  changes = withPending(changes, pendingChange(pr, "auto-merge", { label: "Auto-merge off", patch: autoMergeIs(null) }, T0 + 400));
  assert.equal(changes.length, 1, "the later change takes the earlier one's place");
  assert.deepEqual(reconcilePending(changes, says([pr], T0 + 500), T0 + 900), { waiting: [], expired: [] });
});

test("with no answer at all, time gives a change up — quietly when a read was all it asked for", () => {
  const pr = github();
  const rebase = pendingChange(pr, "rebase", { label: "Rebase" }, T0);
  const activity = pendingChange(pr, "activity", { label: "", quiet: true }, T0);
  assert.equal(rebase.expiresAt, T0 + PENDING_TTL_MS);

  // GitHub out of reach: the list is still the one from before.
  const before = says([pr], T0 - 60_000);
  assert.equal(reconcilePending([rebase, activity], before, T0 + PENDING_TTL_MS - 1).waiting.length, 2);
  const late = reconcilePending([rebase, activity], before, T0 + PENDING_TTL_MS);
  assert.deepEqual(late.waiting, []);
  assert.equal(givenUpMessage(late.expired), "GitHub does not show it yet: Rebase on org/app#12. The list is what GitHub says — refresh in a moment.");
  assert.equal(givenUpMessage([activity]), "");
});

test("a rebase shows as a new head, whatever GitHub makes of the merge state meanwhile", () => {
  const pr = github();
  const changes = [pendingChange(pr, "rebase", { label: "Rebase", readIn: 5000 }, T0)];
  assert.equal(shownPr(changes, pr), pr, "nothing is drawn over: the outcome is GitHub's to tell");
  // Working out mergeability again is not yet the rebase.
  assert.equal(reconcilePending(changes, says([github({ mergeStatus: "unknown" })], T0 + 5000), T0 + 5800).waiting.length, 1);
  assert.deepEqual(reconcilePending(changes, says([github({ headSha: "bbb", mergeStatus: "blocked" })], T0 + 5000), T0 + 5800), { waiting: [], expired: [] });
});

test("a PR that left the list takes its changes with it", () => {
  const changes = [autoMergeOn(github())];
  assert.deepEqual(reconcilePending(changes, says([github({ id: 99 })], T0 + 1000), T0 + 1500), { waiting: [], expired: [] });
});

test("GitHub's newer answer for one PR takes its place in the list, or takes it out", () => {
  const list = [github({ id: 11 }), github(), github({ id: 13 })];
  const newer = github({ autoMergeMethod: "SQUASH" });
  const replaced = withAnswer(list, "org/app/12", newer);
  assert.deepEqual(replaced.map((pr) => [pr.id, pr.autoMergeMethod]), [[11, null], [12, "SQUASH"], [13, null]]);
  assert.equal(list[1].autoMergeMethod, null, "the list GitHub gave is not edited");
  // No longer open: it leaves the list, as a refresh would have it.
  assert.deepEqual(withAnswer(list, "org/app/12", null).map((pr) => pr.id), [11, 13]);
  // Not a PR of the list: nothing to put it in place of.
  assert.deepEqual(withAnswer(list, "org/app/99", github({ id: 99 })).map((pr) => pr.id), [11, 12, 13]);
});

test("asked again, a reviewer awaits a review whatever they said before", () => {
  const pr = github({
    blockingReviewers: [{ login: "Anna", avatarUrl: "a.png" }], staleApprovers: [{ login: "bob" }],
    currentApprovers: [{ login: "carla" }], reviewState: "changes-requested",
  });
  const again = reviewAskedOf("anna")(pr);
  assert.deepEqual(again.blockingReviewers, []);
  assert.deepEqual(again.pendingReviewers, [{ login: "Anna", avatarUrl: "a.png" }]);
  assert.deepEqual(again.staleApprovers, [{ login: "bob" }]);
  assert.deepEqual(again.currentApprovers, [{ login: "carla" }]);
  assert.equal(again.reviewState, "changes-requested", "the PR's state is GitHub's to say");

  // Someone new, with the avatar the dashboard knows them by.
  assert.deepEqual(reviewAskedOf("dan", "d.png")(pr).pendingReviewers, [{ login: "dan", avatarUrl: "d.png" }]);
  // Already awaited: nothing to draw.
  const awaited = github({ pendingReviewers: [{ login: "anna" }] });
  assert.equal(reviewAskedOf("ANNA")(awaited), awaited);
});

test("two reviewers asked on a PR wait apart, each badge finds its own, and one read serves both", () => {
  const pr = github();
  let changes = withPending([], pendingChange(pr, "review-request", { label: "Review asked of anna", subject: "Anna", patch: reviewAskedOf("Anna") }, T0));
  changes = withPending(changes, pendingChange(pr, "review-request", { label: "Review asked of bob", subject: "bob", patch: reviewAskedOf("bob") }, T0 + 100));
  assert.equal(changes.length, 2);
  assert.deepEqual(shownPr(changes, pr).pendingReviewers.map((a) => a.login), ["Anna", "bob"]);
  assert.equal(waitingOn(changes, pr, "review-request", "ANNA")?.label, "Review asked of anna");
  assert.equal(waitingOn(changes, pr, "review-request", "carla"), undefined);
  assert.equal(waitingOn(changes, pr, "rebase"), undefined);

  // One PR to read, not two.
  assert.deepEqual(duePendingPrs(changes, T0 + 100), ["org/app/12"]);
  const listed = github({ pendingReviewers: [{ login: "Anna" }, { login: "bob" }] });
  assert.deepEqual(reconcilePending(changes, says([listed], T0 + 200), T0 + 900), { waiting: [], expired: [] });
});
