import type { DashboardSnapshot } from "./shared/rpc";
import { defaultListFilterPreferences, defaultSettings } from "./shared/settings";

export interface DraftPrInfo {
  repo: string;
  branch: string;
  baseBranch: string;
  suggestedTitle: string;
}

export const state = {
  // ── Dashboard ──────────────────────────────────────────────────────────────
  currentDashboard: null as DashboardSnapshot | null,
  currentView: "list" as "status" | "list" | "settings",
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
};
