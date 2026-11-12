// ── Changes awaiting GitHub ───────────────────────────────────────────────────
// The list shows what GitHub last said (`state.currentDashboard`), and nothing
// edits that snapshot. A change ZuGit just made on GitHub is kept apart, here,
// until GitHub shows it: its row draws it over GitHub's data, marked as
// waiting (`trackGitHubChange`, api.ts).
//
// GitHub is read sparingly for it — each read is a whole refresh, and counts
// against the token's hourly limit: once after the change, as before, and once
// more only if that read does not show it. Never more than MAX_READS.
//
// It ends by itself: when GitHub's data on it moves, or already says what the
// row draws — or when its reads are spent without a sign of it, and then the
// row is GitHub's again and the status says so. A snapshot asked for before
// the change neither ends it nor counts: that one never saw it.
//
// Only what GitHub answered to the change is drawn over. What follows from it
// (the PR's review state, what the viewer may do next) is GitHub's to say.

import type { PullRequestSummary, ReviewActor } from "./shared/pr-model";

/**
 * `activity` is a change with nothing of its own to draw (a review published
 * from the diff, a conversation resolved): it only has GitHub read again until
 * the PR shows that something happened.
 */
export type PendingKind = "auto-merge" | "rebase" | "review-request" | "activity";

export type PendingPatch = (pr: PullRequestSummary) => PullRequestSummary;

export interface PendingChange {
  /** `repo/id` of the PR it was made on. */
  pr: string;
  kind: PendingKind;
  /** Tells two changes of a kind on a PR apart: the reviewer asked. */
  subject: string;
  /** What was done, for the row's tooltip and for the status if GitHub never shows it. */
  label: string;
  /** The PR with what GitHub answered drawn over it; none when the outcome is GitHub's to tell. */
  patch?: PendingPatch;
  /** GitHub's data on it when it was made (see `trace`). */
  before: string;
  /** When it was made, and when GitHub is first read for it (ms since the epoch). */
  at: number;
  readAt: number;
  /** Snapshots asked for after it that did not show it. */
  reads: number;
  /** When to give it up whatever happens: for when no read lands at all. */
  expiresAt: number;
  /** Nothing to say if GitHub never shows it: a read was all it asked for. */
  quiet: boolean;
}

/** GitHub is read once for a change and, if that read does not show it, once more. */
export const MAX_READS = 2;
/** How long after a read that did not show it the second one follows. */
export const RETRY_MS = 6_000;
/** With no read landing at all (GitHub out of reach), a change is given up after this long. */
export const PENDING_TTL_MS = 60_000;

export const prKey = (pr: Pick<PullRequestSummary, "repo" | "id">): string => `${pr.repo}/${pr.id}`;

const logins = (list: ReviewActor[]): string => list.map((a) => a.login.toLowerCase()).sort().join(",");

const reviewers = (pr: PullRequestSummary): string =>
  [pr.pendingReviewers, pr.currentApprovers, pr.staleApprovers, pr.blockingReviewers, pr.commentedReviewers].map(logins).join("|");

/**
 * What a change of `kind` is about on a PR, as one string: a difference from
 * when the change was made is GitHub's news about it. A rebase shows as a new
 * head, whatever GitHub makes of the merge state meanwhile.
 */
function trace(kind: PendingKind, pr: PullRequestSummary): string {
  switch (kind) {
    case "auto-merge": return pr.autoMergeMethod ?? "";
    case "rebase": return pr.headSha;
    case "review-request": return reviewers(pr);
    case "activity": return `${pr.updatedAtIso} ${reviewers(pr)} ${pr.unresolvedThreads}`;
  }
}

export interface PendingOptions {
  label: string;
  subject?: string;
  patch?: PendingPatch;
  quiet?: boolean;
  /** GitHub needs a moment for it (a rebase): the first read waits this long, so one is enough. */
  readIn?: number;
}

/** A change just made on `pr` (as GitHub last gave it), at `now`. */
export function pendingChange(pr: PullRequestSummary, kind: PendingKind, options: PendingOptions, now: number): PendingChange {
  return {
    pr: prKey(pr),
    kind,
    subject: (options.subject ?? "").toLowerCase(),
    label: options.label,
    patch: options.patch,
    before: trace(kind, pr),
    at: now,
    readAt: now + (options.readIn ?? 0),
    reads: 0,
    expiresAt: now + PENDING_TTL_MS,
    quiet: options.quiet ?? false,
  };
}

/** `changes` with `change` in: it takes the place of an earlier one of its kind on the same PR and subject. */
export function withPending(changes: PendingChange[], change: PendingChange): PendingChange[] {
  return [
    ...changes.filter((c) => !(c.pr === change.pr && c.kind === change.kind && c.subject === change.subject)),
    change,
  ];
}

/** GitHub's data on the change has moved since it was made, or already says what the row draws. */
function shows(change: PendingChange, pr: PullRequestSummary): boolean {
  const now = trace(change.kind, pr);
  if (now !== change.before) return true;
  return !!change.patch && trace(change.kind, change.patch(pr)) === now;
}

/**
 * Sorts `changes` against the PRs of a snapshot asked for at `askedAt`: those
 * it shows — or whose PR left the list — are dropped; those it does not show
 * have used one of their reads, and come back as `expired` once they are spent
 * (or their time is over); the rest keep `waiting`. A snapshot asked for before
 * a change says nothing about it. Call it once per snapshot: it counts reads.
 */
export function reconcilePending(
  changes: PendingChange[], prs: PullRequestSummary[], askedAt: number, now: number,
): { waiting: PendingChange[]; expired: PendingChange[] } {
  const byKey = new Map(prs.map((pr) => [prKey(pr), pr]));
  const waiting: PendingChange[] = [];
  const expired: PendingChange[] = [];
  for (const change of changes) {
    const read = askedAt >= change.at;
    const pr = byKey.get(change.pr);
    if (read && (!pr || shows(change, pr))) continue;
    const reads = change.reads + (read ? 1 : 0);
    if (reads >= MAX_READS || now >= change.expiresAt) expired.push(change);
    else waiting.push(read ? { ...change, reads } : change);
  }
  return { waiting, expired };
}

/** The PR as its row draws it: GitHub's, with the changes still waiting drawn over. */
export function shownPr(changes: PendingChange[], pr: PullRequestSummary): PullRequestSummary {
  const key = prKey(pr);
  return changes.reduce((shown, change) => (change.pr === key && change.patch ? change.patch(shown) : shown), pr);
}

/** The change of `kind` (and `subject`) still waiting on a PR, if any. */
export function waitingOn(
  changes: PendingChange[], pr: Pick<PullRequestSummary, "repo" | "id">, kind: PendingKind, subject?: string,
): PendingChange | undefined {
  const key = prKey(pr);
  return changes.find((c) => c.pr === key && c.kind === kind && (subject === undefined || c.subject === subject.toLowerCase()));
}

/**
 * How long before GitHub is read for the changes still waiting; null when none
 * waits. One not read yet is read at its time; one a read did not show, once
 * more RETRY_MS after that read (this is asked right after a read landed).
 * One read serves every change waiting: they are not read one by one.
 */
export function nextPendingRead(changes: PendingChange[], now: number): number | null {
  let next: number | null = null;
  for (const change of changes) {
    const wait = change.reads === 0 ? Math.max(0, change.readAt - now) : RETRY_MS;
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}

/** What the status says of changes GitHub never showed; nothing for the quiet ones. */
export function givenUpMessage(expired: PendingChange[]): string {
  const said = expired.filter((c) => !c.quiet).map((c) => `${c.label} on ${c.pr.replace(/\/(\d+)$/, "#$1")}`);
  if (said.length === 0) return "";
  return `GitHub does not show it yet: ${said.join("; ")}. The list is what GitHub says — refresh in a moment.`;
}

// ── What a change draws ───────────────────────────────────────────────────────

/** Auto-merge as GitHub answered: on with `method`, or off. */
export function autoMergeIs(method: string | null): PendingPatch {
  return (pr) => ({ ...pr, autoMergeMethod: method });
}

/**
 * `login` was asked for a review, for the first time or again: they await one,
 * whatever they said before — as GitHub's Reviewers list shows them. A current
 * approval is not asked again from ZuGit, and is left alone.
 */
export function reviewAskedOf(login: string, avatarUrl?: string): PendingPatch {
  const is = (a: ReviewActor) => a.login.toLowerCase() === login.toLowerCase();
  return (pr) => {
    if (pr.pendingReviewers.some(is)) return pr;
    const known = [...pr.blockingReviewers, ...pr.staleApprovers, ...pr.commentedReviewers].find(is);
    return {
      ...pr,
      blockingReviewers: pr.blockingReviewers.filter((a) => !is(a)),
      staleApprovers: pr.staleApprovers.filter((a) => !is(a)),
      commentedReviewers: pr.commentedReviewers.filter((a) => !is(a)),
      pendingReviewers: [...pr.pendingReviewers, known ?? { login, avatarUrl }],
    };
  };
}
