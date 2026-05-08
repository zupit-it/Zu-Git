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
            jira_merge_transition: "MERGE REQUEST".to_string(),
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
    pub notifications_enabled: String, // "on" | ""
    pub color_blind_mode: String,      // "on" | ""
    pub jira_merge_transition: String,
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
    pub jira_release: String,
    pub jira_release_date: Option<String>,
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
    pub pipeline_state: PipelineState,
    pub has_failed_pipeline: bool,
    pub additions: u32,
    pub deletions: u32,
    pub auto_merge_method: Option<String>,
    pub unresolved_threads: u32,
    pub merge_status: String,
    pub node_id: String,
    pub head_ref: String,
    pub base_ref: String,
    pub body: String,
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub name: String,
    pub configured: bool,
    pub ok: bool,
    pub detail: String,
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
            if t.is_empty() { "MERGE REQUEST".to_string() } else { t }
        },
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
            pipeline_state: PipelineState::Success,
            has_failed_pipeline: false,
            additions: 312,
            deletions: 47,
            auto_merge_method: Some("SQUASH".to_string()),
            unresolved_threads: 2,
            merge_status: "behind".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
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
            pipeline_state: PipelineState::Success,
            has_failed_pipeline: false,
            additions: 58,
            deletions: 120,
            auto_merge_method: None,
            unresolved_threads: 0,
            merge_status: "clean".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
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
            pipeline_state: PipelineState::Pending,
            has_failed_pipeline: false,
            additions: 5,
            deletions: 3,
            auto_merge_method: None,
            unresolved_threads: 0,
            merge_status: "unknown".to_string(),
            node_id: String::new(),
            head_ref: String::new(),
            base_ref: String::new(),
            body: String::new(),
        },
    ]
}
