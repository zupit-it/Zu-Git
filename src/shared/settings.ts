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
  };
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
  };
}

export function settingsReadyForGithub(settings: AppSettings) {
  return settings.githubToken.length > 0 && settings.githubRepos.length > 0;
}

export function settingsReadyForJira(settings: AppSettings) {
  return (
    settings.jiraBaseUrl.length > 0 &&
    settings.jiraEmail.length > 0 &&
    settings.jiraToken.length > 0
  );
}
