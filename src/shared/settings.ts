export interface AppSettings {
  githubToken: string;
  githubApiBaseUrl: string;
  githubRepos: string[];
  autoRefreshMinutes: number;
  internalAuthorMarker: string;
  teamMemberGithubUsers: string[];
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraRepoBoards: Record<string, string>;
  notificationsEnabled: boolean;
  colorBlindMode: boolean;
  jiraMergeTransition: string;
  reactionScoreEnabled: boolean;
  scoreRuleReviewsEnabled: boolean;
  scoreRuleChangesRequestedEnabled: boolean;
  scoreRuleCiEnabled: boolean;
  scoreRuleBehindEnabled: boolean;
  mergeQueueEnabled: boolean;
  togglEnabled: boolean;
  togglToken: string;
  /** Empty = use the account's default workspace. */
  togglWorkspaceId: string;
  /** Local "HH:MM" bounds of the working day the planner fills. */
  togglDayStart: string;
  togglDayEnd: string;
  /** Rounding granularity, in minutes, for generated entries. */
  togglSlotMinutes: number;
  /** How far back the project/tag mapping is learned from (max 90 — Toggl's limit). */
  togglHistoryDays: number;
  googleCalendarEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  /** Empty = the account's primary calendar. */
  googleCalendarId: string;
  /** Shows the "Stale branches" tab. */
  staleBranchesEnabled: boolean;
  /** Days without a push after which a branch with no open PR counts as stale. */
  staleBranchDays: number;
  /** Branch name prefixes never reported as stale (release trains, long-lived lines…). */
  staleBranchIgnoredPrefixes: string[];
}

export interface ListFilterPreferences {
  onlyMyPendingReviews: boolean;
  onlyMyPullRequests: boolean;
  includeInternal: boolean;
  includeTeam: boolean;
  includeCollaborator: boolean;
  groupByRelease: boolean;
  showDraft: boolean;
  hiddenRepos: string[];
}

export interface SettingsFormValues {
  githubToken: string;
  githubApiBaseUrl: string;
  githubRepos: string;
  autoRefreshMinutes: string;
  internalAuthorMarker: string;
  teamMemberGithubUsers: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  jiraToken: string;
  jiraRepoBoards: string;
  notificationsEnabled: string;   // "on" | ""
  colorBlindMode: string;         // "on" | ""
  jiraMergeTransition: string;
  reactionScoreEnabled: string;          // "on" | ""
  scoreRuleReviewsEnabled: string;       // "on" | ""
  scoreRuleChangesRequestedEnabled: string; // "on" | ""
  scoreRuleCiEnabled: string;            // "on" | ""
  scoreRuleBehindEnabled: string;        // "on" | ""
  mergeQueueEnabled: string;              // "on" | ""
  togglEnabled: string;                   // "on" | ""
  togglToken: string;
  togglWorkspaceId: string;
  togglDayStart: string;                  // "HH:MM"
  togglDayEnd: string;                    // "HH:MM"
  togglSlotMinutes: string;
  togglHistoryDays: string;
  googleCalendarEnabled: string;          // "on" | ""
  googleClientId: string;
  googleClientSecret: string;
  googleCalendarId: string;
  staleBranchesEnabled: string;          // "on" | ""
  staleBranchDays: string;
  staleBranchIgnoredPrefixes: string;
}

export const defaultSettings: AppSettings = {
  githubToken: "",
  githubApiBaseUrl: "https://api.github.com",
  githubRepos: [],
  autoRefreshMinutes: 5,
  internalAuthorMarker: "-zupit",
  teamMemberGithubUsers: [],
  jiraBaseUrl: "",
  jiraEmail: "",
  jiraToken: "",
  jiraRepoBoards: {},
  notificationsEnabled: true,
  colorBlindMode: false,
  jiraMergeTransition: "MERGE REQUEST",
  reactionScoreEnabled: true,
  scoreRuleReviewsEnabled: true,
  scoreRuleChangesRequestedEnabled: true,
  scoreRuleCiEnabled: true,
  scoreRuleBehindEnabled: false,
  mergeQueueEnabled: false,
  togglEnabled: false,
  togglToken: "",
  togglWorkspaceId: "",
  togglDayStart: "08:00",
  togglDayEnd: "14:00",
  togglSlotMinutes: 15,
  togglHistoryDays: 60,
  googleCalendarEnabled: false,
  googleClientId: "",
  googleClientSecret: "",
  googleCalendarId: "",
  staleBranchesEnabled: false,
  staleBranchDays: 15,
  // Release branches are long-lived by convention, not by protection rule.
  staleBranchIgnoredPrefixes: ["release"],
};

export const defaultListFilterPreferences: ListFilterPreferences = {
  onlyMyPendingReviews: false,
  onlyMyPullRequests: false,
  includeInternal: true,
  includeTeam: true,
  includeCollaborator: true,
  groupByRelease: false,
  showDraft: true,
  hiddenRepos: [],
};

function splitMultilineList(value: string | undefined) {
  return (value ?? "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRepoBoards(value: string | undefined) {
  const mapping: Record<string, string> = {};

  for (const entry of splitMultilineList(value)) {
    const parts = entry.includes("->")
      ? entry.split("->")
      : entry.includes("=")
        ? entry.split("=")
        : entry.split(":");

    if (parts.length < 2) continue;

    const repo = parts[0]?.trim();
    const board = parts.slice(1).join(":").trim().toUpperCase();

    if (repo && board) {
      mapping[repo] = board;
    }
  }

  return mapping;
}

export function serializeSettingsForm(settings: AppSettings): SettingsFormValues {
  return {
    githubToken: settings.githubToken,
    githubApiBaseUrl: settings.githubApiBaseUrl,
    githubRepos: settings.githubRepos.join("\n"),
    autoRefreshMinutes: String(settings.autoRefreshMinutes),
    internalAuthorMarker: settings.internalAuthorMarker,
    teamMemberGithubUsers: settings.teamMemberGithubUsers.join("\n"),
    jiraBaseUrl: settings.jiraBaseUrl,
    jiraEmail: settings.jiraEmail,
    jiraToken: settings.jiraToken,
    jiraRepoBoards: Object.entries(settings.jiraRepoBoards)
      .map(([repo, board]) => `${repo} = ${board}`)
      .join("\n"),
    notificationsEnabled: settings.notificationsEnabled ? "on" : "",
    colorBlindMode: settings.colorBlindMode ? "on" : "",
    jiraMergeTransition: settings.jiraMergeTransition,
    reactionScoreEnabled: settings.reactionScoreEnabled ? "on" : "",
    scoreRuleReviewsEnabled: settings.scoreRuleReviewsEnabled ? "on" : "",
    scoreRuleChangesRequestedEnabled: settings.scoreRuleChangesRequestedEnabled ? "on" : "",
    scoreRuleCiEnabled: settings.scoreRuleCiEnabled ? "on" : "",
    scoreRuleBehindEnabled: settings.scoreRuleBehindEnabled ? "on" : "",
    mergeQueueEnabled: settings.mergeQueueEnabled ? "on" : "",
    togglEnabled: settings.togglEnabled ? "on" : "",
    togglToken: settings.togglToken,
    togglWorkspaceId: settings.togglWorkspaceId,
    togglDayStart: settings.togglDayStart,
    togglDayEnd: settings.togglDayEnd,
    togglSlotMinutes: String(settings.togglSlotMinutes),
    togglHistoryDays: String(settings.togglHistoryDays),
    googleCalendarEnabled: settings.googleCalendarEnabled ? "on" : "",
    googleClientId: settings.googleClientId,
    googleClientSecret: settings.googleClientSecret,
    googleCalendarId: settings.googleCalendarId,
    staleBranchesEnabled: settings.staleBranchesEnabled ? "on" : "",
    staleBranchDays: String(settings.staleBranchDays),
    staleBranchIgnoredPrefixes: settings.staleBranchIgnoredPrefixes.join("\n"),
  };
}

/** Accepts "8:00", "08:00" or "08:00:00"; anything else falls back to `fallback`. */
function normalizeClock(value: string | undefined, fallback: string) {
  const [rawHour, rawMinute] = (value ?? "").trim().split(":");
  const hour = Number.parseInt(rawHour ?? "", 10);
  const minute = Number.parseInt(rawMinute ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function boundedInt(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function normalizeSettings(
  values: Partial<SettingsFormValues>,
): AppSettings {
  const autoRefreshMinutes = Number.parseInt(values.autoRefreshMinutes?.trim() ?? "", 10);

  return {
    githubToken: values.githubToken?.trim() ?? "",
    githubApiBaseUrl: values.githubApiBaseUrl?.trim() || defaultSettings.githubApiBaseUrl,
    githubRepos: splitMultilineList(values.githubRepos),
    autoRefreshMinutes:
      Number.isFinite(autoRefreshMinutes) && autoRefreshMinutes > 0
        ? autoRefreshMinutes
        : defaultSettings.autoRefreshMinutes,
    internalAuthorMarker: values.internalAuthorMarker?.trim() || defaultSettings.internalAuthorMarker,
    teamMemberGithubUsers: splitMultilineList(values.teamMemberGithubUsers),
    jiraBaseUrl: values.jiraBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    jiraEmail: values.jiraEmail?.trim() ?? "",
    jiraToken: values.jiraToken?.trim() ?? "",
    jiraRepoBoards: parseRepoBoards(values.jiraRepoBoards),
    notificationsEnabled: values.notificationsEnabled === "on",
    colorBlindMode: values.colorBlindMode === "on",
    jiraMergeTransition: values.jiraMergeTransition?.trim() || "MERGE REQUEST",
    reactionScoreEnabled: values.reactionScoreEnabled === "on",
    scoreRuleReviewsEnabled: values.scoreRuleReviewsEnabled === "on",
    scoreRuleChangesRequestedEnabled: values.scoreRuleChangesRequestedEnabled === "on",
    scoreRuleCiEnabled: values.scoreRuleCiEnabled === "on",
    scoreRuleBehindEnabled: values.scoreRuleBehindEnabled === "on",
    mergeQueueEnabled: values.mergeQueueEnabled === "on",
    togglEnabled: values.togglEnabled === "on",
    togglToken: values.togglToken?.trim() ?? "",
    togglWorkspaceId: values.togglWorkspaceId?.trim() ?? "",
    togglDayStart: normalizeClock(values.togglDayStart, defaultSettings.togglDayStart),
    togglDayEnd: normalizeClock(values.togglDayEnd, defaultSettings.togglDayEnd),
    togglSlotMinutes: boundedInt(values.togglSlotMinutes, 5, 120, defaultSettings.togglSlotMinutes),
    // Capped at 90: the Toggl time-entries endpoint refuses wider windows.
    togglHistoryDays: boundedInt(values.togglHistoryDays, 7, 90, defaultSettings.togglHistoryDays),
    googleCalendarEnabled: values.googleCalendarEnabled === "on",
    googleClientId: values.googleClientId?.trim() ?? "",
    googleClientSecret: values.googleClientSecret?.trim() ?? "",
    googleCalendarId: values.googleCalendarId?.trim() ?? "",
    staleBranchesEnabled: values.staleBranchesEnabled === "on",
    // Below a week the list fills with branches that are simply in progress.
    staleBranchDays: boundedInt(
      values.staleBranchDays, 7, 365, defaultSettings.staleBranchDays,
    ),
    staleBranchIgnoredPrefixes: splitMultilineList(values.staleBranchIgnoredPrefixes),
  };
}

export function settingsReadyForGithub(settings: AppSettings) {
  return settings.githubToken.length > 0 && settings.githubRepos.length > 0;
}

export function settingsReadyForToggl(settings: AppSettings) {
  return settings.togglEnabled && settings.togglToken.length > 0;
}

export function settingsReadyForJira(settings: AppSettings) {
  return (
    settings.jiraBaseUrl.length > 0 &&
    settings.jiraEmail.length > 0 &&
    settings.jiraToken.length > 0
  );
}
