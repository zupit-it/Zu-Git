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

// ── Active filters ────────────────────────────────────────────────────────────

/** What the list's filters can be told apart by: each one is removed on its own. */
export type FilterKey = "scope" | "reviewer" | "authors" | "repos" | "search";

export interface ActiveFilter {
  key: FilterKey;
  /** Plain text; the caller escapes it. */
  label: string;
  /** Shown bold after the label, as "Reviewer: anna". */
  value?: string;
}

/**
 * The filters hiding pull requests right now, in the toolbar's order. Drafts
 * and grouping are how the list is seen, not filters: they are never here.
 */
export function activeFilters(snapshot: DashboardSnapshot): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (state.onlyMyPendingReviews) out.push({ key: "scope", label: "To review" });
  else if (state.onlyMyPullRequests) out.push({ key: "scope", label: "Mine" });
  if (state.filteredReviewer) {
    const me = snapshot.viewerLogin?.toLowerCase() === state.filteredReviewer.toLowerCase();
    out.push({ key: "reviewer", label: "Reviewer:", value: me ? "you" : state.filteredReviewer });
  }
  const authors = [
    state.showInternalOnly ? "Internal" : "",
    state.showTeamOnly ? "Team" : "",
    state.showCollaboratorOnly ? "Collaborator" : "",
  ].filter(Boolean);
  if (authors.length < 3) out.push({ key: "authors", label: "Authors:", value: authors.join(", ") });
  const repos = getAvailableRepos(snapshot);
  const shownRepos = repos.filter((repo) => !state.hiddenRepos.includes(repo)).length;
  if (shownRepos < repos.length) out.push({ key: "repos", label: "Repos:", value: `${shownRepos} of ${repos.length}` });
  if (state.listSearchQuery) out.push({ key: "search", label: "Search:", value: `“${state.listSearchQuery}”` });
  return out;
}

/** Turns one filter off, and only that one: drafts and grouping never move. */
export function clearFilter(key: FilterKey) {
  switch (key) {
    case "scope":
      state.onlyMyPendingReviews = false;
      state.onlyMyPullRequests = false;
      break;
    case "reviewer":
      state.filteredReviewer = null;
      break;
    case "authors":
      state.showInternalOnly = true;
      state.showTeamOnly = true;
      state.showCollaboratorOnly = true;
      break;
    case "repos":
      state.hiddenRepos = [];
      break;
    case "search":
      state.listSearchQuery = "";
      break;
  }
}

/** The PRs the Drafts switch lets through, before any filter: what "N of M" counts from. */
export function listBase(snapshot: DashboardSnapshot): number {
  return snapshot.prs.filter((pr) => state.showDraft || !pr.isDraft).length;
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
