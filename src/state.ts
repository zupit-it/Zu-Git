import type { DashboardSnapshot, StaleBranchesResult } from "./shared/rpc";
import { defaultListFilterPreferences, defaultSettings } from "./shared/settings";

export interface CommitSummary {
  sha: string;
  message: string;
  committedAt: string;
}

export interface BranchStats {
  additions: number;
  deletions: number;
  files: number;
  commits: CommitSummary[];
}

export interface DraftPrInfo {
  repo: string;
  branch: string;
  baseBranch: string;
  suggestedTitle: string;
  stats?: BranchStats | null;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export type AppView = "status" | "list" | "settings" | "stale";

export const state = {
  // ── Dashboard ──────────────────────────────────────────────────────────────
  currentDashboard: null as DashboardSnapshot | null,
  currentView: "list" as AppView,
  lastSyncedAt: null as string | null,
  lastSyncSource: "mock" as "live" | "mock",
  lastMyChangesRequestedIds: new Set<string>(),
  lastMyPendingReviewIds: null as Set<string> | null, // null = first load, skip notification

  // ── List filters ───────────────────────────────────────────────────────────
  listSearchQuery: "",
  onlyMyPendingReviews: defaultListFilterPreferences.onlyMyPendingReviews,
  onlyMyPullRequests: defaultListFilterPreferences.onlyMyPullRequests,
  showInternalOnly: defaultListFilterPreferences.includeInternal,
  showTeamOnly: defaultListFilterPreferences.includeTeam,
  showCollaboratorOnly: defaultListFilterPreferences.includeCollaborator,
  groupByRelease: defaultListFilterPreferences.groupByRelease,
  showDraft: defaultListFilterPreferences.showDraft,
  hiddenRepos: [...defaultListFilterPreferences.hiddenRepos] as string[],
  filteredReviewer: null as string | null,

  // ── Settings-derived ───────────────────────────────────────────────────────
  currentAutoRefreshMinutes: defaultSettings.autoRefreshMinutes,
  currentInternalMarker: defaultSettings.internalAuthorMarker,
  currentCollaborators: [] as string[],
  notificationsEnabled: defaultSettings.notificationsEnabled,
  reactionScoreEnabled: defaultSettings.reactionScoreEnabled,
  scoreRuleReviewsEnabled: defaultSettings.scoreRuleReviewsEnabled,
  scoreRuleChangesRequestedEnabled: defaultSettings.scoreRuleChangesRequestedEnabled,
  scoreRuleCiEnabled: defaultSettings.scoreRuleCiEnabled,
  scoreRuleBehindEnabled: defaultSettings.scoreRuleBehindEnabled,
  mergeQueueEnabled: defaultSettings.mergeQueueEnabled,
  togglEnabled: defaultSettings.togglEnabled,
  /** Enabled *and* holding a token — the panel cannot do anything without one. */
  togglReady: false,
  /** Day whose end-of-range reminder already fired, as YYYY-MM-DD. */
  togglReminderShownFor: null as string | null,
  togglDayStart: defaultSettings.togglDayStart,
  togglDayEnd: defaultSettings.togglDayEnd,
  togglSlotMinutes: defaultSettings.togglSlotMinutes,

  // ── Stale branches ────────────────────────────────────────────────────────
  staleBranchesEnabled: defaultSettings.staleBranchesEnabled,
  staleBranchDays: defaultSettings.staleBranchDays,
  /** Last scan result — kept so re-opening the tab doesn't re-scan every repo. */
  staleBranches: null as StaleBranchesResult | null,
  staleLoading: false,
  staleError: null as string | null,
  /** Non-error message shown in place of the list (e.g. no repository selected). */
  staleNotice: null as string | null,
  /** Repositories the cached scan covered; null = every configured one. */
  staleScannedRepos: null as string[] | null,
  staleOnlyMine: false,
  staleGroupByAuthor: false,
  /** Internal-only by default: outside contributors' branches are rarely ours to chase. */
  staleShowInternal: true,
  staleShowCollaborator: false,

  // ── Merge queue ────────────────────────────────────────────────────────────
  // "repo/id" of PRs at the head of their queue, auto-merge-enabled, and conflicting.
  // Rebuilt from scratch on every processMergeQueue() call — read-only, for rendering.
  queueBlockedPrKeys: new Set<string>(),
  // "repo/id" of PRs with a rebase already triggered and not yet confirmed settled.
  // Cleared once the PR is no longer reported as "behind" — see processMergeQueue.
  queueRebaseTriggeredFor: new Set<string>(),
  // "repo/id" → updatedAtIso at last conflict notification, so the queue-blocked
  // native notification fires once per PR state, not on every auto-refresh tick.
  queueConflictNotifiedFor: new Map<string, string>(),

  // ── Settings form ──────────────────────────────────────────────────────────
  settingsDirty: false,
  settingsSaving: false,

  // ── Refresh ────────────────────────────────────────────────────────────────
  refreshInProgress: false,
  refreshRequestId: 0,

  // ── Timers ─────────────────────────────────────────────────────────────────
  autoRefreshIntervalId: null as number | null,
  syncLabelIntervalId: null as number | null,

  // ── Draft / new PR ─────────────────────────────────────────────────────────
  draftPrInfo: null as DraftPrInfo | null,
  draftReviewers: [] as string[],
  draftBody: "",
  draftBaseBranch: "",
  draftAsDraft: false,
  draftJiraKey: null as string | null,
  draftChecklist: [] as ChecklistItem[],
  draftChecklistLoading: false,
  // promote-mode fields (non-null when promoting an existing draft PR)
  draftPrNumber: null as number | null,
  draftPrNodeId: null as string | null,
};
