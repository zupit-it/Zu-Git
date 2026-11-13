// ── Changes awaiting GitHub ───────────────────────────────────────────────────
// The list shows what GitHub last said (`state.currentDashboard`), and nothing
// edits that snapshot. A change ZuGit just made on GitHub is kept apart, here,
// until GitHub shows it: its row draws it over GitHub's data, marked as
// waiting (`trackGitHubChange`, api.ts).
//
// GitHub is asked sparingly for it, since every request counts against the
// token's hourly limit: that PR alone is read (one point, where a refresh of
// the list costs three per repository), once after the change and once more
// only if that answer does not show it. Never more than MAX_READS — and a
// refresh that lands meanwhile counts as one of them.
//
// It ends by itself: when GitHub's data on it moves, or already says what the
// row draws — or when its reads are spent without a sign of it, and then the
// row is GitHub's again and the status says so. An answer asked for before
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
  /** When it was made (ms since the epoch). */
  at: number;
  /** When its PR is next read for it; Infinity when ZuGit has no read of its own left to ask. */
  readAt: number;
  /** GitHub's answers asked for after it that did not show it. */
  reads: number;
  /** When the last answer it was checked against was asked for: an answer counts once. */
  seenAt: number;
  /** When to give it up whatever happens: for when no read lands at all. */
  expiresAt: number;
  /** Nothing to say if GitHub never shows it: a read was all it asked for. */
  quiet: boolean;
}

/** GitHub is asked once for a change and, if that answer does not show it, once more. */
export const MAX_READS = 2;
/** How long after an answer that did not show it the second read follows. */
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
    seenAt: 0,
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

/** What GitHub last said of a PR — nothing when it is not in the list — and when that was asked for. */
export type GitHubSays = (pr: string) => { pr: PullRequestSummary | undefined; askedAt: number };

/**
 * Sorts `changes` against what GitHub last said of their PRs. An answer asked
 * for after a change, and not checked yet, is news about it: a change it shows
 * — or whose PR left the list — is dropped; one it does not show has used one
 * of its reads, comes back as `expired` once they are spent, and is otherwise
 * due its last read RETRY_MS from `now`. With no news a change keeps `waiting`
 * until its time is over.
 */
export function reconcilePending(
  changes: PendingChange[], github: GitHubSays, now: number,
): { waiting: PendingChange[]; expired: PendingChange[] } {
  const waiting: PendingChange[] = [];
  const expired: PendingChange[] = [];
  for (const change of changes) {
    const { pr, askedAt } = github(change.pr);
    const news = askedAt >= change.at && askedAt > change.seenAt;
    if (news && (!pr || shows(change, pr))) continue;
    const reads = change.reads + (news ? 1 : 0);
    if (reads >= MAX_READS || now >= change.expiresAt) expired.push(change);
    else waiting.push(news ? { ...change, reads, seenAt: askedAt, readAt: now + RETRY_MS } : change);
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

/** How long before a PR is next read for a change still waiting; null when no read is due. */
export function nextPendingRead(changes: PendingChange[], now: number): number | null {
  const due = changes.map((change) => change.readAt).filter(Number.isFinite);
  return due.length ? Math.max(0, Math.min(...due) - now) : null;
}

/** The PRs to read now, each once whatever the changes waiting on it. */
export function duePendingPrs(changes: PendingChange[], now: number): string[] {
  return [...new Set(changes.filter((change) => change.readAt <= now).map((change) => change.pr))];
}

/**
 * A PR's read failed (GitHub out of reach): ZuGit does not ask again on its
 * own for the changes on it. The next refresh, by the timer or by hand, takes over.
 */
export function withoutOwnRead(changes: PendingChange[], pr: string): PendingChange[] {
  return changes.map((change) => (change.pr === pr ? { ...change, readAt: Number.POSITIVE_INFINITY } : change));
}

/**
 * `prs` with GitHub's newer answer for one PR in place of the one they had:
 * replaced, or taken out when it is no longer open (`null`).
 */
export function withAnswer(prs: PullRequestSummary[], key: string, pr: PullRequestSummary | null): PullRequestSummary[] {
  return pr ? prs.map((p) => (prKey(p) === key ? pr : p)) : prs.filter((p) => prKey(p) !== key);
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
