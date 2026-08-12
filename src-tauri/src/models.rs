use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Settings ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub github_token: String,
    pub github_api_base_url: String,
    pub github_repos: Vec<String>,
    pub auto_refresh_minutes: u32,
    pub internal_author_marker: String,
    pub team_member_github_users: Vec<String>,
    pub jira_base_url: String,
    pub jira_email: String,
    pub jira_token: String,
    pub jira_repo_boards: HashMap<String, String>,
    pub notifications_enabled: bool,
    pub color_blind_mode: bool,
    pub jira_merge_transition: String,
    pub reaction_score_enabled: bool,
    pub score_rule_reviews_enabled: bool,
    pub score_rule_changes_requested_enabled: bool,
    pub score_rule_ci_enabled: bool,
    pub score_rule_behind_enabled: bool,
    pub merge_queue_enabled: bool,
    pub toggl_enabled: bool,
    pub toggl_token: String,
    /// Empty = use the account's default workspace.
    pub toggl_workspace_id: String,
    /// Local "HH:MM" bounds of the working day the planner fills.
    pub toggl_day_start: String,
    pub toggl_day_end: String,
    /// Rounding granularity, in minutes, for generated entries.
    pub toggl_slot_minutes: u32,
    /// How far back the project/tag mapping is learned from.
    pub toggl_history_days: u32,
    pub google_calendar_enabled: bool,
    pub google_client_id: String,
    pub google_client_secret: String,
    /// Calendar to read; empty means the account's primary one.
    pub google_calendar_id: String,
    /// Shows the "Stale branches" tab.
    pub stale_branches_enabled: bool,
    /// Days without a push after which a branch with no open PR counts as stale.
    pub stale_branch_days: u32,
    /// Branch name prefixes never reported as stale (release trains, long-lived lines…).
    pub stale_branch_ignored_prefixes: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            github_token: String::new(),
            github_api_base_url: "https://api.github.com".to_string(),
            github_repos: vec![],
            auto_refresh_minutes: 5,
            internal_author_marker: "-zupit".to_string(),
            team_member_github_users: vec![],
            jira_base_url: String::new(),
            jira_email: String::new(),
            jira_token: String::new(),
            jira_repo_boards: HashMap::new(),
            notifications_enabled: true,
            color_blind_mode: false,
            jira_merge_transition: "Merge Request".to_string(),
            reaction_score_enabled: true,
            score_rule_reviews_enabled: true,
            score_rule_changes_requested_enabled: true,
            score_rule_ci_enabled: true,
            score_rule_behind_enabled: false,
            merge_queue_enabled: false,
            toggl_enabled: false,
            toggl_token: String::new(),
            toggl_workspace_id: String::new(),
            toggl_day_start: "08:00".to_string(),
            toggl_day_end: "14:00".to_string(),
            toggl_slot_minutes: 15,
            toggl_history_days: 60,
            google_calendar_enabled: false,
            google_client_id: String::new(),
            google_client_secret: String::new(),
            google_calendar_id: String::new(),
            stale_branches_enabled: false,
            stale_branch_days: 15,
            stale_branch_ignored_prefixes: vec!["release".to_string()],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub text: String,
    pub done: bool,
}

// Form values as sent/received from the frontend (all strings, camelCase JSON)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFormValues {
    pub github_token: String,
    pub github_api_base_url: String,
    pub github_repos: String,
    pub auto_refresh_minutes: String,
    pub internal_author_marker: String,
    pub team_member_github_users: String,
    pub jira_base_url: String,
    pub jira_email: String,
    pub jira_token: String,
    pub jira_repo_boards: String,
    pub notifications_enabled: String,  // "on" | ""
    pub color_blind_mode: String,       // "on" | ""
    pub jira_merge_transition: String,
    pub reaction_score_enabled: String,                   // "on" | ""
    pub score_rule_reviews_enabled: String,               // "on" | ""
    pub score_rule_changes_requested_enabled: String,     // "on" | ""
    pub score_rule_ci_enabled: String,                    // "on" | ""
    pub score_rule_behind_enabled: String,                // "on" | ""
    pub merge_queue_enabled: String,                      // "on" | ""
    pub toggl_enabled: String,                            // "on" | ""
    pub toggl_token: String,
    pub toggl_workspace_id: String,
    pub toggl_day_start: String,                          // "HH:MM"
    pub toggl_day_end: String,                            // "HH:MM"
    pub toggl_slot_minutes: String,
    pub toggl_history_days: String,
    pub google_calendar_enabled: String,                  // "on" | ""
    pub google_client_id: String,
    pub google_client_secret: String,
    pub google_calendar_id: String,
    pub stale_branches_enabled: String,                  // "on" | ""
    pub stale_branch_days: String,
    pub stale_branch_ignored_prefixes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilterPreferences {
    pub only_my_pending_reviews: bool,
    pub only_my_pull_requests: bool,
    pub include_internal: bool,
    pub include_team: bool,
    pub include_collaborator: bool,
    pub group_by_release: bool,
    pub show_draft: bool,
    pub hidden_repos: Vec<String>,
}

impl Default for ListFilterPreferences {
    fn default() -> Self {
        Self {
            only_my_pending_reviews: false,
            only_my_pull_requests: false,
            include_internal: true,
            include_team: true,
            include_collaborator: true,
            group_by_release: false,
            show_draft: true,
            hidden_repos: vec![],
        }
    }
}

// ── PR model ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewActor {
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewState {
    Approved,
    ApprovedStale,
    NeedsReview,
    ChangesRequested,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Priority {
    Highest,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AuthorType {
    Internal,
    Team,
    Collaborator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MatchStrategy {
    TitleBoard,
    TitleAny,
    FallbackText,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum PipelineState {
    Success,
    Pending,
    Failure,
    ActionRequired,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub id: u64,
    pub repo: String,
    pub title: String,
    pub url: String,
    pub jira_url: Option<String>,
    pub is_draft: bool,
    pub created_at_iso: String,
    pub author_type: AuthorType,
    pub jira_board: Option<String>,
    pub match_strategy: MatchStrategy,
    pub jira_key: String,
    pub jira_summary: String,
    pub jira_priority: Priority,
    /// Primary fix version (most imminent release); derived from `jira_releases`
    /// for backward-compatible single-value reads.
    pub jira_release: String,
    pub jira_release_date: Option<String>,
    /// All fix versions assigned to the issue, primary first. A story can be
    /// planned for several releases at once.
    pub jira_releases: Vec<String>,
    pub jira_status: String,
    pub author: String,
    pub author_avatar_url: Option<String>,
    pub assignee: String,
    pub assignee_avatar_url: Option<String>,
    pub current_reviewer: String,
    pub current_reviewer_avatar_url: Option<String>,
    pub previous_approver: Option<String>,
    pub previous_approver_avatar_url: Option<String>,
    pub pending_reviewers: Vec<ReviewActor>,
    pub current_approvers: Vec<ReviewActor>,
    pub stale_approvers: Vec<ReviewActor>,
    pub blocking_reviewers: Vec<ReviewActor>,
    pub commented_reviewers: Vec<ReviewActor>,
    pub review_state: ReviewState,
    pub has_stale_approval: bool,
    pub updated_at: String,
    pub updated_at_iso: String,
    pub pipeline_state: PipelineState,
    pub has_failed_pipeline: bool,
    pub additions: u32,
    pub deletions: u32,
    pub auto_merge_method: Option<String>,
    pub unresolved_threads: u32,
    pub merge_status: String,
    pub node_id: String,
    pub head_ref: String,
    /// Head commit SHA at fetch time — sent as `expectedHeadOid` when triggering a
    /// rebase, so a concurrent push causes a clean rejection instead of a race.
    pub head_sha: String,
    pub base_ref: String,
    pub body: String,
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/// Machine-readable health of an integration, so the frontend can tell an
/// expired/invalid token (the user must re-authenticate) apart from a transient
/// outage or a missing configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrationState {
    /// Not enough settings to attempt a live call yet.
    NotConfigured,
    /// Configured, but a refresh hasn't completed yet.
    Pending,
    /// Live data loaded successfully.
    Ok,
    /// Token expired, revoked or invalid (HTTP 401) — needs re-authentication.
    AuthExpired,
    /// Reachable and authenticated, but some sub-requests failed (e.g. one repo).
    Degraded,
    /// Could not reach the service or it returned a non-auth error.
    Unreachable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub name: String,
    pub configured: bool,
    pub ok: bool,
    pub state: IntegrationState,
    pub detail: String,
}

/// Classified outcome of an integration HTTP call. Lets callers distinguish an
/// authentication failure (expired/invalid token) from any other error while
/// still degrading gracefully via `From<ApiError> for String`.
#[derive(Debug, Clone)]
pub enum ApiError {
    /// HTTP 401 — the token is expired, revoked or otherwise invalid.
    Auth(String),
    /// Any other failure: network error, 5xx, parse error, non-401 status, etc.
    Other(String),
}

impl ApiError {
    pub fn is_auth(&self) -> bool {
        matches!(self, ApiError::Auth(_))
    }

    /// Builds an error from an HTTP status code, classifying 401 as an auth failure.
    ///
    /// Note: 403 is intentionally *not* treated as auth, since GitHub also uses it
    /// for rate limiting and Jira for permission errors — both produce false
    /// "re-authenticate" prompts. Only 401 reliably means "bad credentials".
    pub fn from_status(status: u16, message: String) -> Self {
        if status == 401 {
            ApiError::Auth(message)
        } else {
            ApiError::Other(message)
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Auth(m) | ApiError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> String {
        e.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSyncStatus {
    pub repo: String,
    pub ok: bool,
    pub pr_count: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStoreStatus {
    /// "keychain" | "credential-manager" | "secret-service" | "fallback-file"
    pub provider: String,
    /// Human-readable description of the provider.
    pub provider_detail: String,
    /// Whether the probe passed (i.e. the system store is actually usable).
    pub provider_ok: bool,
    pub github_token_present: bool,
    pub jira_token_present: bool,
    /// None = never saved in this session; Some(true) = vault used; Some(false) = file fallback used.
    pub last_save_used_vault: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub prs: Vec<PullRequestSummary>,
    pub viewer_login: Option<String>,
    pub warnings: Vec<String>,
    pub source: String,
    pub refreshed_at: String,
    pub integrations: Vec<IntegrationStatus>,
    pub repo_syncs: Vec<RepoSyncStatus>,
    pub token_store: TokenStoreStatus,
    /// Avatar URLs for all configured collaborators (login → url).
    /// Populated during live refresh; empty for mock data.
    pub reviewer_avatars: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreInfo {
    pub provider: String,
    pub detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardBootstrap {
    pub settings: SettingsFormValues,
    pub list_filters: ListFilterPreferences,
    pub secret_store: SecretStoreInfo,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsResult {
    pub settings: SettingsFormValues,
    pub dashboard: DashboardSnapshot,
}

// ── Settings helpers ──────────────────────────────────────────────────────────

fn split_multiline_list(value: &str) -> Vec<String> {
    value
        .split(['\n', ',', '\r'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_repo_boards(value: &str) -> HashMap<String, String> {
    let mut mapping = HashMap::new();
    for entry in split_multiline_list(value) {
        let parts: Vec<&str> = if entry.contains("->") {
            entry.splitn(2, "->").collect()
        } else if entry.contains('=') {
            entry.splitn(2, '=').collect()
        } else {
            entry.splitn(2, ':').collect()
        };
        if parts.len() == 2 {
            let repo = parts[0].trim().to_string();
            let board = parts[1].trim().to_uppercase();
            if !repo.is_empty() && !board.is_empty() {
                mapping.insert(repo, board);
            }
        }
    }
    mapping
}

pub fn normalize_settings(values: &SettingsFormValues) -> AppSettings {
    let auto_refresh = values
        .auto_refresh_minutes
        .trim()
        .parse::<u32>()
        .unwrap_or(0);

    AppSettings {
        github_token: values.github_token.trim().to_string(),
        github_api_base_url: {
            let url = values.github_api_base_url.trim().to_string();
            if url.is_empty() {
                "https://api.github.com".to_string()
            } else {
                url
            }
        },
        github_repos: split_multiline_list(&values.github_repos),
        auto_refresh_minutes: if auto_refresh > 0 { auto_refresh } else { 5 },
        internal_author_marker: {
            let m = values.internal_author_marker.trim().to_string();
            if m.is_empty() {
                "-zupit".to_string()
            } else {
                m
            }
        },
        team_member_github_users: split_multiline_list(&values.team_member_github_users),
        jira_base_url: values
            .jira_base_url
            .trim()
            .trim_end_matches('/')
            .to_string(),
        jira_email: values.jira_email.trim().to_string(),
        jira_token: values.jira_token.trim().to_string(),
        jira_repo_boards: parse_repo_boards(&values.jira_repo_boards),
        notifications_enabled: values.notifications_enabled.trim() == "on",
        color_blind_mode: values.color_blind_mode.trim() == "on",
        jira_merge_transition: {
            let t = values.jira_merge_transition.trim().to_string();
            if t.is_empty() { "Merge Request".to_string() } else { t }
        },
        reaction_score_enabled: values.reaction_score_enabled.trim() == "on",
        score_rule_reviews_enabled: values.score_rule_reviews_enabled.trim() == "on",
        score_rule_changes_requested_enabled: values.score_rule_changes_requested_enabled.trim() == "on",
        score_rule_ci_enabled: values.score_rule_ci_enabled.trim() == "on",
        score_rule_behind_enabled: values.score_rule_behind_enabled.trim() == "on",
        merge_queue_enabled: values.merge_queue_enabled.trim() == "on",
        toggl_enabled: values.toggl_enabled.trim() == "on",
        toggl_token: values.toggl_token.trim().to_string(),
        toggl_workspace_id: values.toggl_workspace_id.trim().to_string(),
        toggl_day_start: normalize_clock(&values.toggl_day_start, "08:00"),
        toggl_day_end: normalize_clock(&values.toggl_day_end, "14:00"),
        toggl_slot_minutes: match values.toggl_slot_minutes.trim().parse::<u32>() {
            Ok(minutes) if (5..=120).contains(&minutes) => minutes,
            _ => 15,
        },
        // Capped at 90: the Toggl time-entries endpoint refuses wider windows.
        toggl_history_days: match values.toggl_history_days.trim().parse::<u32>() {
            Ok(days) if (7..=90).contains(&days) => days,
            _ => 60,
        },
        google_calendar_enabled: values.google_calendar_enabled.trim() == "on",
        google_client_id: values.google_client_id.trim().to_string(),
        google_client_secret: values.google_client_secret.trim().to_string(),
        google_calendar_id: values.google_calendar_id.trim().to_string(),
        stale_branches_enabled: values.stale_branches_enabled.trim() == "on",
        // Below a week the list fills with branches that are simply in progress.
        stale_branch_days: match values.stale_branch_days.trim().parse::<u32>() {
            Ok(days) if (7..=365).contains(&days) => days,
            _ => 15,
        },
        stale_branch_ignored_prefixes: split_multiline_list(
            &values.stale_branch_ignored_prefixes,
        ),
    }
}

/// Accepts "8:00", "08:00" or "08:00:00" and returns a canonical "HH:MM";
/// anything unparseable falls back to `fallback`.
fn normalize_clock(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    let mut parts = trimmed.split(':');
    let hour = parts.next().and_then(|h| h.trim().parse::<u32>().ok());
    let minute = parts.next().and_then(|m| m.trim().parse::<u32>().ok());
    match (hour, minute) {
        (Some(h), Some(m)) if h < 24 && m < 60 => format!("{h:02}:{m:02}"),
        _ => fallback.to_string(),
    }
}

pub fn serialize_settings_form(settings: &AppSettings) -> SettingsFormValues {
    SettingsFormValues {
        github_token: settings.github_token.clone(),
        github_api_base_url: settings.github_api_base_url.clone(),
        github_repos: settings.github_repos.join("\n"),
        auto_refresh_minutes: settings.auto_refresh_minutes.to_string(),
        internal_author_marker: settings.internal_author_marker.clone(),
        team_member_github_users: settings.team_member_github_users.join("\n"),
        jira_base_url: settings.jira_base_url.clone(),
        jira_email: settings.jira_email.clone(),
        jira_token: settings.jira_token.clone(),
        jira_repo_boards: settings
            .jira_repo_boards
            .iter()
            .map(|(repo, board)| format!("{} = {}", repo, board))
            .collect::<Vec<_>>()
            .join("\n"),
        notifications_enabled: if settings.notifications_enabled {
            "on".to_string()
        } else {
            String::new()
        },
        color_blind_mode: if settings.color_blind_mode {
            "on".to_string()
        } else {
            String::new()
        },
        jira_merge_transition: settings.jira_merge_transition.clone(),
        reaction_score_enabled: if settings.reaction_score_enabled { "on".to_string() } else { String::new() },
        score_rule_reviews_enabled: if settings.score_rule_reviews_enabled { "on".to_string() } else { String::new() },
        score_rule_changes_requested_enabled: if settings.score_rule_changes_requested_enabled { "on".to_string() } else { String::new() },
        score_rule_ci_enabled: if settings.score_rule_ci_enabled { "on".to_string() } else { String::new() },
        score_rule_behind_enabled: if settings.score_rule_behind_enabled { "on".to_string() } else { String::new() },
        merge_queue_enabled: if settings.merge_queue_enabled { "on".to_string() } else { String::new() },
        toggl_enabled: if settings.toggl_enabled { "on".to_string() } else { String::new() },
        toggl_token: settings.toggl_token.clone(),
        toggl_workspace_id: settings.toggl_workspace_id.clone(),
        toggl_day_start: settings.toggl_day_start.clone(),
        toggl_day_end: settings.toggl_day_end.clone(),
        toggl_slot_minutes: settings.toggl_slot_minutes.to_string(),
        toggl_history_days: settings.toggl_history_days.to_string(),
        google_calendar_enabled: if settings.google_calendar_enabled { "on".to_string() } else { String::new() },
        google_client_id: settings.google_client_id.clone(),
        google_client_secret: settings.google_client_secret.clone(),
        google_calendar_id: settings.google_calendar_id.clone(),
        stale_branches_enabled: if settings.stale_branches_enabled { "on".to_string() } else { String::new() },
        stale_branch_days: settings.stale_branch_days.to_string(),
        stale_branch_ignored_prefixes: settings.stale_branch_ignored_prefixes.join("\n"),
    }
}

pub fn settings_ready_for_github(settings: &AppSettings) -> bool {
    !settings.github_token.is_empty() && !settings.github_repos.is_empty()
}

pub fn settings_ready_for_jira(settings: &AppSettings) -> bool {
    !settings.jira_base_url.is_empty()
        && !settings.jira_email.is_empty()
        && !settings.jira_token.is_empty()
}

// ── Stale branches ───────────────────────────────────────────────────────────

/// A remote branch with no open pull request whose last commit is older than the
/// configured staleness threshold — i.e. a branch someone opened and forgot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleBranch {
    pub repo: String,
    pub branch: String,
    /// Web URL of the branch (not the API one) — what the row links to.
    pub url: String,
    pub last_commit_at: String,
    pub last_commit_message: String,
    pub last_commit_sha: String,
    /// GitHub login of the last committer; empty when the commit has no linked account.
    pub author_login: String,
    /// Raw git author name — the only thing available when `author_login` is empty.
    pub author_name: String,
    pub author_avatar_url: String,
    pub age_days: u32,
    /// True when the last commit is the viewer's — what the "Only mine" filter uses.
    pub is_mine: bool,
    /// Two-way split for this view: `Internal` covers both the author marker and
    /// the explicit team list, `Collaborator` is everyone else (including commits
    /// with no linked GitHub account). Never `Team`.
    pub author_type: AuthorType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleBranchesResult {
    pub branches: Vec<StaleBranch>,
    pub viewer_login: String,
    /// Repos that could not be scanned, one message each — the rest still render.
    pub warnings: Vec<String>,
    /// Threshold actually applied, so the view can label itself.
    pub stale_days: u32,
}

// ── Draft PR info ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub message: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStats {
    pub additions: u32,
    pub deletions: u32,
    pub files: u32,
    pub commits: Vec<CommitSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftPrInfo {
    pub repo: String,
    pub branch: String,
    pub base_branch: String,
    pub suggested_title: String,
    pub stats: Option<BranchStats>,
}

// ── Release diff ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDiffItem {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub issue_type: String,
    /// All fix versions assigned to the issue (empty when unscheduled).
    pub fix_versions: Vec<String>,
    pub pr_url: Option<String>,
    pub pr_number: Option<u64>,
    pub branch: String,
    pub author: String,
    pub initials: String,
    pub avatar_color: String,
    pub avatar_url: Option<String>,
    pub is_preview: bool,
    /// Typed sync divergence flag: "no-pr" | "no-jira" | None
    pub flag: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDiffResult {
    pub done: Vec<ReleaseDiffItem>,
    pub missing: Vec<ReleaseDiffItem>,
    pub extra: Vec<ReleaseDiffItem>,
    pub available_versions: Vec<String>,
    pub synced_at: String,
    pub repo: String,
    pub since_tag: String,
}

// ── Mock data ─────────────────────────────────────────────────────────────────

pub fn mock_pull_requests() -> Vec<PullRequestSummary> {
    vec![
        PullRequestSummary {
            id: 1842,
            repo: "payments/api".to_string(),
            title: "Support partial refunds in settlement flow".to_string(),
            url: "https://github.com/payments/api/pull/1842".to_string(),
            jira_url: Some("https://jira.example.com/browse/PAY-184".to_string()),
            is_draft: false,
            created_at_iso: "2026-04-01T10:00:00.000Z".to_string(),
            author_type: AuthorType::Internal,
            jira_board: Some("PAY".to_string()),
            match_strategy: MatchStrategy::TitleBoard,
            jira_key: "PAY-184".to_string(),
            jira_summary: "Enable partial refund orchestration for card settlements".to_string(),
            jira_priority: Priority::Highest,
            jira_release: "2026.05".to_string(),
            jira_release_date: Some("May 15, 2026".to_string()),
            jira_releases: vec!["2026.05".to_string(), "2026.06".to_string()],
            jira_status: "Ready for release".to_string(),
            author: "marta".to_string(),
            author_avatar_url: None,
            assignee: "luca".to_string(),
            assignee_avatar_url: None,
            current_reviewer: "chiara".to_string(),
            current_reviewer_avatar_url: None,
            previous_approver: Some("luca".to_string()),
            previous_approver_avatar_url: None,
            pending_reviewers: vec![ReviewActor {
                login: "chiara".to_string(),
                avatar_url: None,
            }],
            current_approvers: vec![],
            stale_approvers: vec![ReviewActor {
                login: "luca".to_string(),
                avatar_url: None,
            }],
            blocking_reviewers: vec![],
            commented_reviewers: vec![],
            review_state: ReviewState::ApprovedStale,
            has_stale_approval: true,
            updated_at: "14 min ago".to_string(),
            updated_at_iso: "2026-05-17T07:46:00Z".to_string(),
            pipeline_state: PipelineState::Success,
            has_failed_pipeline: false,
            additions: 312,
            deletions: 47,
            auto_merge_method: Some("SQUASH".to_string()),
            unresolved_threads: 2,
            merge_status: "behind".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
            head_sha: String::new(),
            base_ref: String::new(),
            body: String::new(),
        },
        PullRequestSummary {
            id: 918,
            repo: "mobile/backoffice".to_string(),
            title: "Improve deployment status polling".to_string(),
            url: "https://github.com/mobile/backoffice/pull/918".to_string(),
            jira_url: Some("https://jira.example.com/browse/OPS-77".to_string()),
            is_draft: false,
            created_at_iso: "2026-04-10T09:30:00.000Z".to_string(),
            author_type: AuthorType::Internal,
            jira_board: Some("OPS".to_string()),
            match_strategy: MatchStrategy::TitleBoard,
            jira_key: "OPS-77".to_string(),
            jira_summary: "Reduce noisy polling and expose final rollout state".to_string(),
            jira_priority: Priority::High,
            jira_release: "2026.04-hotfix".to_string(),
            jira_release_date: Some("Apr 25, 2026".to_string()),
            jira_releases: vec!["2026.04-hotfix".to_string()],
            jira_status: "In validation".to_string(),
            author: "sara".to_string(),
            author_avatar_url: None,
            assignee: "federico".to_string(),
            assignee_avatar_url: None,
            current_reviewer: "federico".to_string(),
            current_reviewer_avatar_url: None,
            previous_approver: None,
            previous_approver_avatar_url: None,
            pending_reviewers: vec![],
            current_approvers: vec![ReviewActor {
                login: "federico".to_string(),
                avatar_url: None,
            }],
            stale_approvers: vec![],
            blocking_reviewers: vec![],
            commented_reviewers: vec![],
            review_state: ReviewState::Approved,
            has_stale_approval: false,
            updated_at: "1 h ago".to_string(),
            updated_at_iso: "2026-05-17T06:00:00Z".to_string(),
            pipeline_state: PipelineState::Success,
            has_failed_pipeline: false,
            additions: 58,
            deletions: 120,
            auto_merge_method: None,
            unresolved_threads: 0,
            merge_status: "clean".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
            head_sha: String::new(),
            base_ref: String::new(),
            body: String::new(),
        },
        PullRequestSummary {
            id: 415,
            repo: "checkout/web".to_string(),
            title: "Refactor promo code validation and edge cases".to_string(),
            url: "https://github.com/checkout/web/pull/415".to_string(),
            jira_url: Some("https://jira.example.com/browse/CHK-311".to_string()),
            is_draft: true,
            created_at_iso: "2026-03-20T15:45:00.000Z".to_string(),
            author_type: AuthorType::Collaborator,
            jira_board: Some("CHK".to_string()),
            match_strategy: MatchStrategy::None,
            jira_key: "CHK-311".to_string(),
            jira_summary: "Fix coupon validation failures for mixed carts".to_string(),
            jira_priority: Priority::Medium,
            jira_release: "2026.06".to_string(),
            jira_release_date: Some("Jun 10, 2026".to_string()),
            jira_releases: vec!["2026.06".to_string()],
            jira_status: "In progress".to_string(),
            author: "giulia".to_string(),
            author_avatar_url: None,
            assignee: "davide".to_string(),
            assignee_avatar_url: None,
            current_reviewer: "andrea".to_string(),
            current_reviewer_avatar_url: None,
            previous_approver: None,
            previous_approver_avatar_url: None,
            pending_reviewers: vec![ReviewActor {
                login: "andrea".to_string(),
                avatar_url: None,
            }],
            current_approvers: vec![],
            stale_approvers: vec![],
            blocking_reviewers: vec![],
            commented_reviewers: vec![],
            review_state: ReviewState::NeedsReview,
            has_stale_approval: false,
            updated_at: "8 min ago".to_string(),
            updated_at_iso: "2026-05-17T07:52:00Z".to_string(),
            pipeline_state: PipelineState::Pending,
            has_failed_pipeline: false,
            additions: 5,
            deletions: 3,
            auto_merge_method: None,
            unresolved_threads: 0,
            merge_status: "unknown".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
            head_sha: String::new(),
            base_ref: String::new(),
            body: String::new(),
        },
    ]
}
