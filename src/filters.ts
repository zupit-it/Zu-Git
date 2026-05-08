import type { DashboardSnapshot } from "./shared/rpc";
import type { PullRequestSummary } from "./shared/pr-model";
import { matchesSearch, PRIORITY_RANK } from "./utils";
import { state } from "./state";

export { PRIORITY_RANK };

// ── Available repos ───────────────────────────────────────────────────────────

export function getAvailableRepos(snapshot: DashboardSnapshot): string[] {
  const configuredRepos = snapshot.repoSyncs.map((repoSync) => repoSync.repo);
  if (configuredRepos.length > 0) {
    return configuredRepos;
  }
  return Array.from(new Set(snapshot.prs.map((pr) => pr.repo))).sort((a, b) =>
    a.localeCompare(b),
  );
}

// ── Sorting ───────────────────────────────────────────────────────────────────

export function applyListSort(prs: PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort((a, b) => {
    const ra = PRIORITY_RANK[a.jiraPriority] ?? 4;
    const rb = PRIORITY_RANK[b.jiraPriority] ?? 4;
    return ra - rb;
  });
}

// ── Filtering ─────────────────────────────────────────────────────────────────

export function applyListFilters(snapshot: DashboardSnapshot): PullRequestSummary[] {
  return applyListSort(snapshot.prs.filter((pr) => {
    if (!matchesSearch(pr, state.listSearchQuery)) return false;
    if (!state.showDraft && pr.isDraft) return false;
    if (state.hiddenRepos.includes(pr.repo)) return false;

    if (state.onlyMyPullRequests) {
      const viewerLogin = snapshot.viewerLogin?.toLowerCase();
      if (!viewerLogin || pr.author.toLowerCase() !== viewerLogin) return false;
    }

    if (state.showInternalOnly || state.showTeamOnly || state.showCollaboratorOnly) {
      const matchesType =
        (state.showInternalOnly  && pr.authorType === "internal") ||
        (state.showTeamOnly      && pr.authorType === "team") ||
        (state.showCollaboratorOnly && pr.authorType === "collaborator");
      if (!matchesType) return false;
    }

    if (state.filteredReviewer) {
      const login = state.filteredReviewer.toLowerCase();
      const isReviewer = [
        ...pr.pendingReviewers, ...pr.currentApprovers,
        ...pr.blockingReviewers, ...pr.staleApprovers, ...pr.commentedReviewers,
      ].some(a => a.login.toLowerCase() === login);
      if (!isReviewer) return false;
    }

    if (!state.onlyMyPendingReviews) return true;

    const viewerLogin = snapshot.viewerLogin?.toLowerCase();
    if (!viewerLogin) return false;

    const isPendingReviewer = pr.pendingReviewers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    const alreadyApproved = pr.currentApprovers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    return isPendingReviewer && !alreadyApproved;
  }));
}

// ── Notification counters ─────────────────────────────────────────────────────

export function countPendingReviewsForViewer(snapshot: DashboardSnapshot): number {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) return 0;

  return snapshot.prs.filter((pr) => {
    if (pr.isDraft) return false;
    const isPendingReviewer = pr.pendingReviewers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    const alreadyApproved = pr.currentApprovers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    return isPendingReviewer && !alreadyApproved;
  }).length;
}

export function countMyChangesRequested(snapshot: DashboardSnapshot): number {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) return 0;

  return snapshot.prs.filter(
    (pr) =>
      !pr.isDraft &&
      pr.author.toLowerCase() === viewerLogin &&
      pr.reviewState === "changes-requested" &&
      pr.blockingReviewers.length > 0,
  ).length;
}

export function getMyPendingReviewIds(snapshot: DashboardSnapshot): Set<string> {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) return new Set();

  return new Set(
    snapshot.prs
      .filter(
        (pr) =>
          !pr.isDraft &&
          pr.pendingReviewers.some((a) => a.login.toLowerCase() === viewerLogin) &&
          !pr.currentApprovers.some((a) => a.login.toLowerCase() === viewerLogin),
      )
      .map((pr) => `${pr.repo}#${pr.id}`),
  );
}

export function getMyChangesRequestedIds(snapshot: DashboardSnapshot): Set<string> {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) return new Set<string>();

  return new Set(
    snapshot.prs
      .filter(
        (pr) =>
          !pr.isDraft &&
          pr.author.toLowerCase() === viewerLogin &&
          pr.reviewState === "changes-requested" &&
          pr.blockingReviewers.length > 0,
      )
      .map((pr) => `${pr.repo}#${pr.id}`),
  );
}
