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

export interface AppContext {
  settings: AppSettings;
  dashboard: DashboardSnapshot;
}
