import type { PullRequestSummary } from "./pr-model";
import type {
  AppSettings,
  ListFilterPreferences,
  SettingsFormValues,
} from "./settings";

export type IntegrationState =
  | "not-configured"
  | "pending"
  | "ok"
  | "auth-expired"
  | "degraded"
  | "unreachable";

export interface IntegrationStatus {
  name: "github" | "jira";
  configured: boolean;
  ok: boolean;
  state: IntegrationState;
  detail: string;
}

export interface RepoSyncStatus {
  repo: string;
  ok: boolean;
  prCount: number;
  detail: string;
}

export interface TokenStoreStatus {
  provider: "keychain" | "credential-manager" | "secret-service" | "fallback-file" | "";
  providerDetail: string;
  providerOk: boolean;
  githubTokenPresent: boolean;
  jiraTokenPresent: boolean;
  /** null = never saved in this session */
  lastSaveUsedVault: boolean | null;
}

export interface DashboardSnapshot {
  prs: PullRequestSummary[];
  viewerLogin?: string;
  warnings: string[];
  source: "mock" | "live";
  refreshedAt: string;
  integrations: IntegrationStatus[];
  repoSyncs: RepoSyncStatus[];
  tokenStore: TokenStoreStatus;
  /** Avatar URLs for configured collaborators: login → url */
  reviewerAvatars: Record<string, string>;
}

export interface DashboardBootstrap {
  settings: SettingsFormValues;
  listFilters: ListFilterPreferences;
  secretStore: {
    provider: "keychain" | "credential-manager" | "secret-service" | "fallback-file";
    detail: string;
  };
}

export interface SaveSettingsResult {
  settings: SettingsFormValues;
  dashboard: DashboardSnapshot;
}

/** A remote branch with no open PR, untouched for longer than the threshold. */
export interface OrphanBranch {
  repo: string;
  branch: string;
  /** Web URL of the branch — where the row links to. */
  url: string;
  lastCommitAt: string;
  lastCommitMessage: string;
  lastCommitSha: string;
  /** Empty when the last commit has no linked GitHub account. */
  authorLogin: string;
  authorName: string;
  authorAvatarUrl: string;
  ageDays: number;
  /** The last commit is the viewer's — what the "Only mine" filter uses. */
  isMine: boolean;
  /**
   * Two-way split for this view: "internal" covers both the author marker and the
   * explicit team list, "collaborator" is everyone else (commits with no linked
   * GitHub account included).
   */
  authorType: "internal" | "collaborator";
}

export interface OrphanBranchesResult {
  branches: OrphanBranch[];
  viewerLogin: string;
  /** Repos that could not be scanned; the rest still render. */
  warnings: string[];
  staleDays: number;
}

export interface AppContext {
  settings: AppSettings;
  dashboard: DashboardSnapshot;
}
