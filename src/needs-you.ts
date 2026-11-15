import type { PullRequestSummary } from "./shared/pr-model";

/**
 * Whether a PR waits on the viewer, which is what Show → Needs you lists: a
 * review they were asked for and have not given, or a PR of theirs with changes
 * requested, a failed check, or a branch behind its base or in conflict with it.
 * A draft never does. The row's own badges say which.
 */
export function needsViewer(pr: PullRequestSummary, viewerLogin: string | undefined): boolean {
  const viewer = viewerLogin?.toLowerCase();
  if (!viewer || pr.isDraft) return false;
  const is = (actor: { login: string }) => actor.login.toLowerCase() === viewer;
  if (pr.pendingReviewers.some(is) && !pr.currentApprovers.some(is)) return true;
  if (pr.author.toLowerCase() !== viewer) return false;
  return (
    (pr.reviewState === "changes-requested" && pr.blockingReviewers.length > 0) ||
    pr.hasFailedPipeline ||
    pr.mergeStatus === "behind" ||
    pr.mergeStatus === "conflicting"
  );
}
