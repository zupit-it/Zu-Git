import type { DashboardSnapshot } from "./shared/rpc";
import type { PullRequestSummary } from "./shared/pr-model";
import { matchesSearch, PRIORITY_RANK } from "./utils";
import { state } from "./state";
import { needsViewer } from "./needs-you";
import { inSelectedRepos } from "./repo-selection";

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

/**
 * The PRs of the repositories picked in the selector: the ones the list, its
 * counts and the review load are about. The others are not loaded at all; one
 * turned off since the last refresh is still in the snapshot, and left out here.
 */
export function selectedPrs(snapshot: DashboardSnapshot): PullRequestSummary[] {
  return inSelectedRepos(snapshot.prs, state.hiddenRepos);
}

// ── Sorting ───────────────────────────────────────────────────────────────────

export function byPriorityRank(a: PullRequestSummary, b: PullRequestSummary): number {
  const ra = PRIORITY_RANK[a.jiraPriority] ?? 4;
  const rb = PRIORITY_RANK[b.jiraPriority] ?? 4;
  return ra - rb;
}

export function applyListSort(prs: PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort(byPriorityRank);
}

// ── Filtering ─────────────────────────────────────────────────────────────────

export function applyListFilters(snapshot: DashboardSnapshot): PullRequestSummary[] {
  return applyListSort(selectedPrs(snapshot).filter((pr) => {
    if (!matchesSearch(pr, state.listSearchQuery)) return false;
    if (!state.showDraft && pr.isDraft) return false;

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

    return !state.onlyMyPendingReviews || needsViewer(pr, snapshot.viewerLogin);
  }));
}

// ── Active filters ────────────────────────────────────────────────────────────

/**
 * Whether a filter narrows what Show lists: a reviewer, the authors or a
 * search. Show itself is which list you look at, Drafts and grouping how it is
 * seen, and the repositories what is loaded at all: none of them counts.
 */
export function filtersOn(): boolean {
  if (state.filteredReviewer || state.listSearchQuery) return true;
  return !(state.showInternalOnly && state.showTeamOnly && state.showCollaboratorOnly);
}

/** Whether every repository is turned off in the selector: nothing is loaded. */
export function noRepoSelected(snapshot: DashboardSnapshot): boolean {
  const repos = getAvailableRepos(snapshot);
  return repos.length > 0 && repos.every((repo) => state.hiddenRepos.includes(repo));
}

/** The PRs the Drafts switch lets through, before any filter: the count on All. */
export function listBase(snapshot: DashboardSnapshot): number {
  return selectedPrs(snapshot).filter((pr) => state.showDraft || !pr.isDraft).length;
}

/** Drafts the filters would let through were drafts shown: told on an empty list. */
export function draftsMatching(snapshot: DashboardSnapshot): number {
  if (state.showDraft) return 0;
  state.showDraft = true;
  try {
    return applyListFilters(snapshot).filter((pr) => pr.isDraft).length;
  } finally {
    state.showDraft = false;
  }
}

// ── Notification counters ─────────────────────────────────────────────────────

export function countNeedsViewer(snapshot: DashboardSnapshot): number {
  return selectedPrs(snapshot).filter((pr) => needsViewer(pr, snapshot.viewerLogin)).length;
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
