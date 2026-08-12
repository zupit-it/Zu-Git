use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::models::{normalize_settings, AppSettings, ListFilterPreferences, SettingsFormValues};
use crate::secret_store::{
    decrypt_token_from_file, encrypt_token_for_file, get_secret, set_secret,
};

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn filters_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("list-filters.json"))
}

fn ensure_data_dir(app: &tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

// Persisted subset of settings (no tokens – those live in the keychain).
#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedSettings {
    #[serde(default = "default_api_base_url")]
    github_api_base_url: String,
    #[serde(default)]
    github_repos: Vec<String>,
    #[serde(default = "default_refresh_minutes")]
    auto_refresh_minutes: u32,
    #[serde(default = "default_author_marker")]
    internal_author_marker: String,
    #[serde(default, alias = "collaboratorGithubUsers")]
    team_member_github_users: Vec<String>,
    #[serde(default)]
    jira_base_url: String,
    #[serde(default)]
    jira_email: String,
    #[serde(default)]
    jira_repo_boards: std::collections::HashMap<String, String>,
    #[serde(default = "default_notifications_enabled")]
    notifications_enabled: bool,
    #[serde(default)]
    color_blind_mode: bool,
    #[serde(default = "default_merge_transition")]
    jira_merge_transition: String,
    #[serde(default = "default_reaction_score_enabled")]
    reaction_score_enabled: bool,
    #[serde(default = "default_true")]
    score_rule_reviews_enabled: bool,
    #[serde(default = "default_true")]
    score_rule_changes_requested_enabled: bool,
    #[serde(default = "default_true")]
    score_rule_ci_enabled: bool,
    #[serde(default)]
    score_rule_behind_enabled: bool,
    #[serde(default)]
    merge_queue_enabled: bool,
    #[serde(default)]
    toggl_enabled: bool,
    #[serde(default)]
    toggl_workspace_id: String,
    #[serde(default = "default_day_start")]
    toggl_day_start: String,
    #[serde(default = "default_day_end")]
    toggl_day_end: String,
    #[serde(default = "default_slot_minutes")]
    toggl_slot_minutes: u32,
    #[serde(default = "default_history_days")]
    toggl_history_days: u32,
    #[serde(default)]
    google_calendar_enabled: bool,
    #[serde(default)]
    google_client_id: String,
    #[serde(default)]
    google_calendar_id: String,
    // The aliases are the keys written while the feature was called "orphan
    // branches" — without them the rename would silently reset the setting.
    #[serde(default, alias = "orphanBranchesEnabled")]
    stale_branches_enabled: bool,
    #[serde(default = "default_stale_branch_days", alias = "orphanBranchStaleDays")]
    stale_branch_days: u32,
    #[serde(
        default = "default_stale_ignored_prefixes",
        alias = "orphanIgnoredBranchPrefixes"
    )]
    stale_branch_ignored_prefixes: Vec<String>,
    // Legacy/fallback field. New fallback writes are only produced when they can
    // be protected by the platform (currently DPAPI on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    github_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    jira_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    toggl_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    google_client_secret: Option<String>,
}

fn default_api_base_url() -> String {
    "https://api.github.com".to_string()
}
fn default_refresh_minutes() -> u32 {
    5
}
fn default_author_marker() -> String {
    "-zupit".to_string()
}
fn default_notifications_enabled() -> bool {
    true
}
fn default_reaction_score_enabled() -> bool {
    true
}
fn default_true() -> bool {
    true
}
fn default_merge_transition() -> String {
    "Merge Request".to_string()
}
fn default_day_start() -> String {
    "08:00".to_string()
}
fn default_day_end() -> String {
    "14:00".to_string()
}
fn default_slot_minutes() -> u32 {
    15
}
fn default_history_days() -> u32 {
    60
}
fn default_stale_branch_days() -> u32 {
    15
}
/// Release branches are long-lived by convention, not by protection rule, so they
/// are the one prefix worth excluding out of the box.
fn default_stale_ignored_prefixes() -> Vec<String> {
    vec!["release".to_string()]
}

fn token_fallback_value(token: &str) -> Option<String> {
    let encrypted = encrypt_token_for_file(token);
    if encrypted.is_empty() {
        None
    } else {
        Some(encrypted)
    }
}

fn validate_token_persistence(
    label: &str,
    token: &str,
    stored: &Result<(), String>,
) -> Result<Option<String>, String> {
    if stored.is_ok() || token.is_empty() {
        return Ok(None);
    }

    let reason = stored
        .as_ref()
        .err()
        .map(String::as_str)
        .unwrap_or("unknown reason");

    token_fallback_value(token).map(Some).ok_or_else(|| {
        format!(
            "Could not store the {label} token in the system credential store ({reason}). \
             This platform has no encrypted file fallback, so nothing was saved."
        )
    })
}

pub async fn load_settings(app: &tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;

    let persisted: PersistedSettings = match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => {
            // Electrobun stored settings under <userData>/stable/ or <userData>/dev/.
            // Try those as a one-time migration source.
            let base = path.parent().unwrap_or(&path);
            let legacy = ["stable", "dev"]
                .iter()
                .map(|sub| base.join(sub).join("settings.json"))
                .find_map(|p| std::fs::read_to_string(&p).ok());

            match legacy {
                Some(content) => serde_json::from_str(&content).unwrap_or_default(),
                None => PersistedSettings::default(),
            }
        }
    };

    // Tokens come from keychain; fall back to legacy plain-file values if present.
    let github_token = {
        let from_keychain = get_secret("githubToken");
        if !from_keychain.is_empty() {
            from_keychain
        } else {
            persisted
                .github_token
                .as_deref()
                .map(decrypt_token_from_file)
                .unwrap_or_default()
        }
    };
    let jira_token = {
        let from_keychain = get_secret("jiraToken");
        if !from_keychain.is_empty() {
            from_keychain
        } else {
            persisted
                .jira_token
                .as_deref()
                .map(decrypt_token_from_file)
                .unwrap_or_default()
        }
    };

    let toggl_token = {
        let from_keychain = get_secret("togglToken");
        if !from_keychain.is_empty() {
            from_keychain
        } else {
            persisted
                .toggl_token
                .as_deref()
                .map(decrypt_token_from_file)
                .unwrap_or_default()
        }
    };

    let google_client_secret = {
        let from_keychain = get_secret("googleClientSecret");
        if !from_keychain.is_empty() {
            from_keychain
        } else {
            persisted
                .google_client_secret
                .as_deref()
                .map(decrypt_token_from_file)
                .unwrap_or_default()
        }
    };

    // If legacy tokens were in the file, migrate them to the keychain.
    if persisted
        .github_token
        .as_deref()
        .is_some_and(|t| !t.is_empty())
    {
        let _ = set_secret("githubToken", &github_token);
    }
    if persisted
        .jira_token
        .as_deref()
        .is_some_and(|t| !t.is_empty())
    {
        let _ = set_secret("jiraToken", &jira_token);
    }

    let form = SettingsFormValues {
        github_token,
        github_api_base_url: persisted.github_api_base_url,
        github_repos: persisted.github_repos.join("\n"),
        auto_refresh_minutes: persisted.auto_refresh_minutes.to_string(),
        internal_author_marker: persisted.internal_author_marker,
        team_member_github_users: persisted.team_member_github_users.join("\n"),
        jira_base_url: persisted.jira_base_url,
        jira_email: persisted.jira_email,
        jira_token,
        jira_repo_boards: persisted
            .jira_repo_boards
            .iter()
            .map(|(repo, board)| format!("{} = {}", repo, board))
            .collect::<Vec<_>>()
            .join("\n"),
        notifications_enabled: if persisted.notifications_enabled {
            "on".to_string()
        } else {
            String::new()
        },
        color_blind_mode: if persisted.color_blind_mode {
            "on".to_string()
        } else {
            String::new()
        },
        jira_merge_transition: persisted.jira_merge_transition,
        reaction_score_enabled: if persisted.reaction_score_enabled { "on".to_string() } else { String::new() },
        score_rule_reviews_enabled: if persisted.score_rule_reviews_enabled { "on".to_string() } else { String::new() },
        score_rule_changes_requested_enabled: if persisted.score_rule_changes_requested_enabled { "on".to_string() } else { String::new() },
        score_rule_ci_enabled: if persisted.score_rule_ci_enabled { "on".to_string() } else { String::new() },
        score_rule_behind_enabled: if persisted.score_rule_behind_enabled { "on".to_string() } else { String::new() },
        merge_queue_enabled: if persisted.merge_queue_enabled { "on".to_string() } else { String::new() },
        toggl_enabled: if persisted.toggl_enabled { "on".to_string() } else { String::new() },
        toggl_token,
        toggl_workspace_id: persisted.toggl_workspace_id,
        toggl_day_start: persisted.toggl_day_start,
        toggl_day_end: persisted.toggl_day_end,
        toggl_slot_minutes: persisted.toggl_slot_minutes.to_string(),
        toggl_history_days: persisted.toggl_history_days.to_string(),
        google_calendar_enabled: if persisted.google_calendar_enabled { "on".to_string() } else { String::new() },
        google_client_id: persisted.google_client_id,
        google_client_secret,
        google_calendar_id: persisted.google_calendar_id,
        stale_branches_enabled: if persisted.stale_branches_enabled { "on".to_string() } else { String::new() },
        stale_branch_days: persisted.stale_branch_days.to_string(),
        stale_branch_ignored_prefixes: persisted.stale_branch_ignored_prefixes.join("\n"),
    };

    Ok(normalize_settings(&form))
}

/// Returns the normalised settings and whether both tokens were persisted to the system vault
/// (`true`) or fell back to the encrypted settings file (`false`).
pub async fn save_settings(
    app: &tauri::AppHandle,
    values: &SettingsFormValues,
) -> Result<(AppSettings, bool), String> {
    let normalized = normalize_settings(values);

    // Persist tokens to the system vault; fall back to an encrypted file only on
    // platforms where `encrypt_token_for_file` can protect the token.
    let github_stored = set_secret("githubToken", &normalized.github_token);
    let jira_stored = set_secret("jiraToken", &normalized.jira_token);
    let toggl_stored = set_secret("togglToken", &normalized.toggl_token);
    let google_stored = set_secret("googleClientSecret", &normalized.google_client_secret);
    let github_token_fallback =
        validate_token_persistence("GitHub", &normalized.github_token, &github_stored)?;
    let jira_token_fallback =
        validate_token_persistence("Jira", &normalized.jira_token, &jira_stored)?;
    let toggl_token_fallback =
        validate_token_persistence("Toggl", &normalized.toggl_token, &toggl_stored)?;
    let google_secret_fallback = validate_token_persistence(
        "Google",
        &normalized.google_client_secret,
        &google_stored,
    )?;

    // Write everything-except-tokens to disk (unless keychain failed, then include them).
    ensure_data_dir(app)?;
    let persisted = PersistedSettings {
        github_api_base_url: normalized.github_api_base_url.clone(),
        github_repos: normalized.github_repos.clone(),
        auto_refresh_minutes: normalized.auto_refresh_minutes,
        internal_author_marker: normalized.internal_author_marker.clone(),
        team_member_github_users: normalized.team_member_github_users.clone(),
        jira_base_url: normalized.jira_base_url.clone(),
        jira_email: normalized.jira_email.clone(),
        jira_repo_boards: normalized.jira_repo_boards.clone(),
        notifications_enabled: normalized.notifications_enabled,
        color_blind_mode: normalized.color_blind_mode,
        jira_merge_transition: normalized.jira_merge_transition.clone(),
        reaction_score_enabled: normalized.reaction_score_enabled,
        score_rule_reviews_enabled: normalized.score_rule_reviews_enabled,
        score_rule_changes_requested_enabled: normalized.score_rule_changes_requested_enabled,
        score_rule_ci_enabled: normalized.score_rule_ci_enabled,
        score_rule_behind_enabled: normalized.score_rule_behind_enabled,
        merge_queue_enabled: normalized.merge_queue_enabled,
        toggl_enabled: normalized.toggl_enabled,
        toggl_workspace_id: normalized.toggl_workspace_id.clone(),
        toggl_day_start: normalized.toggl_day_start.clone(),
        toggl_day_end: normalized.toggl_day_end.clone(),
        toggl_slot_minutes: normalized.toggl_slot_minutes,
        toggl_history_days: normalized.toggl_history_days,
        google_calendar_enabled: normalized.google_calendar_enabled,
        google_client_id: normalized.google_client_id.clone(),
        google_calendar_id: normalized.google_calendar_id.clone(),
        stale_branches_enabled: normalized.stale_branches_enabled,
        stale_branch_days: normalized.stale_branch_days,
        stale_branch_ignored_prefixes: normalized.stale_branch_ignored_prefixes.clone(),
        github_token: github_token_fallback,
        jira_token: jira_token_fallback,
        toggl_token: toggl_token_fallback,
        google_client_secret: google_secret_fallback,
    };

    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;

    let used_vault =
        github_stored.is_ok() && jira_stored.is_ok() && toggl_stored.is_ok() && google_stored.is_ok();
    Ok((normalized, used_vault))
}

pub async fn load_list_filter_preferences(
    app: &tauri::AppHandle,
) -> Result<ListFilterPreferences, String> {
    let path = filters_path(app)?;
    let content_opt = std::fs::read_to_string(&path).ok().or_else(|| {
        let base = path.parent().unwrap_or(&path);
        ["stable", "dev"]
            .iter()
            .find_map(|sub| std::fs::read_to_string(base.join(sub).join("list-filters.json")).ok())
    });
    match content_opt {
        Some(content) => {
            let partial: serde_json::Value = serde_json::from_str(&content)
                .unwrap_or(serde_json::Value::Object(Default::default()));
            let defaults = ListFilterPreferences::default();
            Ok(ListFilterPreferences {
                only_my_pending_reviews: partial
                    .get("onlyMyPendingReviews")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.only_my_pending_reviews),
                only_my_pull_requests: partial
                    .get("onlyMyPullRequests")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.only_my_pull_requests),
                include_internal: partial
                    .get("includeInternal")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.include_internal),
                include_team: partial
                    .get("includeTeam")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.include_team),
                include_collaborator: partial
                    .get("includeCollaborator")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.include_collaborator),
                group_by_release: partial
                    .get("groupByRelease")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.group_by_release),
                show_draft: partial
                    .get("showDraft")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(defaults.show_draft),
                hidden_repos: partial
                    .get("hiddenRepos")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        }
        None => Ok(ListFilterPreferences::default()),
    }
}

pub async fn save_list_filter_preferences(
    app: &tauri::AppHandle,
    prefs: &ListFilterPreferences,
) -> Result<(), String> {
    ensure_data_dir(app)?;
    let path = filters_path(app)?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Toggl learned rules ───────────────────────────────────────────────────────

fn toggl_rules_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("toggl-rules.json"))
}

/// Mapping rules learned from Toggl history. A missing or corrupt file simply
/// means "nothing learned yet" — the planner then asks the user for the project.
pub fn load_toggl_rules(app: &tauri::AppHandle) -> crate::toggl::LearnedRules {
    toggl_rules_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn save_toggl_rules(
    app: &tauri::AppHandle,
    rules: &crate::toggl::LearnedRules,
) -> Result<(), String> {
    ensure_data_dir(app)?;
    let path = toggl_rules_path(app)?;
    let json = serde_json::to_string_pretty(rules).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
