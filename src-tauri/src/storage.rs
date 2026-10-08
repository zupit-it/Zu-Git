use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::models::{normalize_settings, AppSettings, ListFilterPreferences, SettingsFormValues};
use crate::secret_store::{
    decrypt_token_from_file, encrypt_token_for_file, get_secret, set_secret,
};

/// Bundle identifier from `tauri.conf.json` — Tauri names the data directory after it.
const APP_IDENTIFIER: &str = "dev.giorgio.zugit";

/// The app data directory, as resolved by the running Tauri app.
pub fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// The same directory without a running Tauri app — `zugit --mcp` reads the
/// settings and caches the desktop app wrote. Tauri resolves it the same way:
/// the platform data dir joined with the bundle identifier.
pub fn standalone_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| "Could not locate the application data directory.".to_string())
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("settings.json"))
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
    #[serde(default = "default_true")]
    toggl_activity_signals: bool,
    #[serde(default)]
    toggl_fill_gaps: bool,
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
    #[serde(default = "default_release_branch_prefix")]
    release_branch_prefix: String,
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

fn default_release_branch_prefix() -> String {
    "release".to_string()
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
    Ok(load_settings_from(&data_dir(app)?))
}

/// Settings stored under `dir`, tokens included (read from the keychain).
pub fn load_settings_from(dir: &Path) -> AppSettings {
    let path = dir.join("settings.json");

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
        toggl_activity_signals: if persisted.toggl_activity_signals { "on".to_string() } else { String::new() },
        toggl_fill_gaps: if persisted.toggl_fill_gaps { "on".to_string() } else { String::new() },
        google_calendar_enabled: if persisted.google_calendar_enabled { "on".to_string() } else { String::new() },
        google_client_id: persisted.google_client_id,
        google_client_secret,
        google_calendar_id: persisted.google_calendar_id,
        stale_branches_enabled: if persisted.stale_branches_enabled { "on".to_string() } else { String::new() },
        stale_branch_days: persisted.stale_branch_days.to_string(),
        stale_branch_ignored_prefixes: persisted.stale_branch_ignored_prefixes.join("\n"),
        release_branch_prefix: persisted.release_branch_prefix,
    };

    normalize_settings(&form)
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
        toggl_activity_signals: normalized.toggl_activity_signals,
        toggl_fill_gaps: normalized.toggl_fill_gaps,
        google_calendar_enabled: normalized.google_calendar_enabled,
        google_client_id: normalized.google_client_id.clone(),
        google_calendar_id: normalized.google_calendar_id.clone(),
        stale_branches_enabled: normalized.stale_branches_enabled,
        stale_branch_days: normalized.stale_branch_days,
        stale_branch_ignored_prefixes: normalized.stale_branch_ignored_prefixes.clone(),
        release_branch_prefix: normalized.release_branch_prefix.clone(),
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

// ── Release notes overrides ───────────────────────────────────────────────────

fn release_notes_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("release-notes.json"))
}

/// Manual "always include" / "always exclude" decisions, keyed by release name
/// and then by Jira key. They outlive a refresh so a release can be curated
/// across several sessions; a missing or corrupt file just means "no overrides".
type ReleaseNoteOverrides = std::collections::HashMap<String, std::collections::HashMap<String, String>>;

fn load_all_release_note_overrides(app: &tauri::AppHandle) -> ReleaseNoteOverrides {
    release_notes_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

pub fn load_release_note_overrides(
    app: &tauri::AppHandle,
    release_name: &str,
) -> std::collections::HashMap<String, String> {
    load_all_release_note_overrides(app)
        .remove(release_name)
        .unwrap_or_default()
}

/// Sets (`Some("include" | "exclude")`) or clears (`None`) one issue's override
/// and returns the release's resulting map.
pub fn set_release_note_override(
    app: &tauri::AppHandle,
    release_name: &str,
    issue_key: &str,
    mode: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut all = load_all_release_note_overrides(app);
    let entry = all.entry(release_name.to_string()).or_default();
    match mode {
        Some(mode) => {
            entry.insert(issue_key.to_string(), mode);
        }
        None => {
            entry.remove(issue_key);
        }
    }
    let current = entry.clone();
    all.retain(|_, keys| !keys.is_empty());

    ensure_data_dir(app)?;
    let path = release_notes_path(app)?;
    let json = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(current)
}

// ── Toggl learned rules ───────────────────────────────────────────────────────

fn read_json<T: serde::de::DeserializeOwned + Default>(path: PathBuf) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Mapping rules learned from Toggl history. A missing or corrupt file simply
/// means "nothing learned yet" — the planner then asks the user for the project.
pub fn load_toggl_rules(dir: &Path) -> crate::toggl::LearnedRules {
    read_json(dir.join("toggl-rules.json"))
}

pub fn save_toggl_rules(dir: &Path, rules: &crate::toggl::LearnedRules) -> Result<(), String> {
    write_json(dir.join("toggl-rules.json"), rules)
}

/// What was booked for calendar events in the planner — see [`crate::toggl::EventMemory`].
pub fn load_event_memory(dir: &Path) -> crate::toggl::EventMemory {
    read_json(dir.join("toggl-event-memory.json"))
}

pub fn save_event_memory(dir: &Path, memory: &crate::toggl::EventMemory) -> Result<(), String> {
    write_json(dir.join("toggl-event-memory.json"), memory)
}

// ── Toggl proposals (written by `zugit --mcp`) ────────────────────────────────

fn proposals_dir(dir: &Path) -> PathBuf {
    dir.join("toggl-proposals")
}

/// Only plain dates become file names — nothing an MCP client sends can climb
/// out of the proposals folder.
fn proposal_path(dir: &Path, date: &str) -> Result<PathBuf, String> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| format!("Invalid date '{date}', expected YYYY-MM-DD."))?;
    Ok(proposals_dir(dir).join(format!("{date}.json")))
}

pub fn save_toggl_proposal(dir: &Path, proposal: &crate::toggl_day::TogglProposal) -> Result<(), String> {
    write_json(proposal_path(dir, &proposal.date)?, proposal)
}

pub fn load_toggl_proposal(dir: &Path, date: &str) -> Option<crate::toggl_day::TogglProposal> {
    let content = std::fs::read_to_string(proposal_path(dir, date).ok()?).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn delete_toggl_proposal(dir: &Path, date: &str) -> Result<(), String> {
    match std::fs::remove_file(proposal_path(dir, date)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Deletes proposals for days more than `keep_days` before `today`: the planner
/// cannot go back that far, so they could only ever nag.
pub fn prune_toggl_proposals(dir: &Path, today: chrono::NaiveDate, keep_days: i64) {
    let Ok(entries) = std::fs::read_dir(proposals_dir(dir)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(date) = name.strip_suffix(".json") else { continue };
        let Ok(day) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") else { continue };
        if (today - day).num_days() > keep_days {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Every pending proposal, as (date, created at).
pub fn list_toggl_proposals(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(proposals_dir(dir)) else {
        return vec![];
    };
    let mut found: Vec<(String, String)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let date = name.strip_suffix(".json")?.to_string();
            let proposal = load_toggl_proposal(dir, &date)?;
            Some((date, proposal.created_at))
        })
        .collect();
    found.sort();
    found
}

// ── AI review proposals (written by `zugit --mcp`) ───────────────────────────

fn ai_reviews_dir(dir: &Path) -> PathBuf {
    dir.join("ai-reviews")
}

/// One file per PR and agent: proposing again replaces that agent's review.
/// The name is built from checked parts only, so nothing a client sends can
/// climb out of the folder; the file's content says which PR it is about.
fn ai_review_path(dir: &Path, repo: &str, number: u64, source: &str) -> Result<PathBuf, String> {
    if !crate::pr_review::valid_repo(repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let safe = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '.') { c } else { '_' })
            .collect()
    };
    let source = safe(source);
    let source = if source.is_empty() { "agent".to_string() } else { source };
    Ok(ai_reviews_dir(dir).join(format!("{}~{}~{}.json", safe(&repo.replace('/', "~")), number, source)))
}

pub fn save_ai_review(dir: &Path, review: &crate::pr_review::AiReview) -> Result<(), String> {
    write_json(ai_review_path(dir, &review.repo, review.number, &review.source)?, review)
}

pub fn delete_ai_review(dir: &Path, repo: &str, number: u64, source: &str) -> Result<(), String> {
    match std::fs::remove_file(ai_review_path(dir, repo, number, source)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// Every stored proposal, newest first.
pub fn load_ai_reviews(dir: &Path) -> Vec<crate::pr_review::AiReview> {
    let Ok(entries) = std::fs::read_dir(ai_reviews_dir(dir)) else {
        return vec![];
    };
    let mut reviews: Vec<crate::pr_review::AiReview> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| serde_json::from_str(&std::fs::read_to_string(entry.path()).ok()?).ok())
        .collect();
    reviews.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    reviews
}

pub fn load_ai_reviews_for(dir: &Path, repo: &str, number: u64) -> Vec<crate::pr_review::AiReview> {
    load_ai_reviews(dir)
        .into_iter()
        .filter(|review| review.repo == repo && review.number == number)
        .collect()
}

/// Drops proposals older than `keep_days`: by then the PR has moved on.
pub fn prune_ai_reviews(dir: &Path, now: chrono::DateTime<chrono::Utc>, keep_days: i64) {
    for review in load_ai_reviews(dir) {
        let Ok(created) = chrono::DateTime::parse_from_rfc3339(&review.created_at) else { continue };
        if (now - created.with_timezone(&chrono::Utc)).num_days() > keep_days {
            let _ = delete_ai_review(dir, &review.repo, review.number, &review.source);
        }
    }
}

// ── The user's own PR comments ───────────────────────────────────────────────

/// One file per PR. `valid_repo` lets through letters, digits, '-', '_' and '.'
/// only, so the name cannot leave the folder.
fn user_review_path(dir: &Path, repo: &str, number: u64) -> Result<PathBuf, String> {
    if !crate::pr_review::valid_repo(repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    Ok(dir.join("pr-comments").join(format!("{}~{}.json", repo.replace('/', "~"), number)))
}

/// The user's comments on a PR; none yet when there is no file. A file that
/// does not parse is an error, not an empty list: saving must never write over
/// comments it could not read.
pub fn load_user_review(dir: &Path, repo: &str, number: u64) -> Result<crate::pr_review::UserReview, String> {
    let path = user_review_path(dir, repo, number)?;
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Your comments on {repo}#{number} could not be read ({e}): {}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(crate::pr_review::UserReview::new(repo, number))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// One change to a user's comments at a time, across PRs: each reads the file,
/// changes it and writes it back, so two at once would lose one of them.
static USER_REVIEWS: parking_lot::Mutex<()> = parking_lot::const_mutex(());

/// Reads the user's comments, changes them and writes them back with no other
/// change in between: a comment kept while a publish is out is not written over.
pub fn update_user_review(
    dir: &Path,
    repo: &str,
    number: u64,
    change: impl FnOnce(&mut crate::pr_review::UserReview) -> Result<(), String>,
) -> Result<crate::pr_review::UserReview, String> {
    let _one_at_a_time = USER_REVIEWS.lock();
    let mut mine = load_user_review(dir, repo, number)?;
    change(&mut mine)?;
    save_user_review(dir, &mine)?;
    Ok(mine)
}

/// Written beside the old file and renamed over it, so a crash mid-write
/// leaves the previous comments rather than half a file. Nothing written, no file.
fn save_user_review(dir: &Path, review: &crate::pr_review::UserReview) -> Result<(), String> {
    let path = user_review_path(dir, &review.repo, review.number)?;
    if review.is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        };
    }
    let draft = path.with_extension("json.tmp");
    write_json(draft.clone(), review)?;
    std::fs::rename(&draft, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposal(date: &str) -> crate::toggl_day::TogglProposal {
        crate::toggl_day::TogglProposal {
            date: date.into(),
            created_at: "2026-10-01T10:00:00Z".into(),
            source: "test".into(),
            note: None,
            entries: vec![],
        }
    }

    #[test]
    fn proposals_older_than_the_planner_reach_are_pruned() {
        let dir = std::env::temp_dir().join(format!("zugit-proposals-{}", std::process::id()));
        for date in ["2026-09-20", "2026-09-24", "2026-09-30", "2026-10-01"] {
            save_toggl_proposal(&dir, &proposal(date)).unwrap();
        }
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
        prune_toggl_proposals(&dir, today, 7);

        let left: Vec<String> = list_toggl_proposals(&dir).into_iter().map(|(date, _)| date).collect();
        assert_eq!(left, vec!["2026-09-24", "2026-09-30", "2026-10-01"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proposal_dates_cannot_escape_the_folder() {
        assert!(proposal_path(Path::new("/tmp"), "../settings").is_err());
    }

    fn ai_review(repo: &str, number: u64, source: &str) -> crate::pr_review::AiReview {
        crate::pr_review::AiReview {
            repo: repo.into(),
            number,
            head_sha: "abc".into(),
            source: source.into(),
            created_at: "2026-10-01T10:00:00Z".into(),
            summary: None,
            order: vec![],
            comments: vec![],
        }
    }

    #[test]
    fn ai_reviews_are_one_per_pr_and_agent() {
        let dir = std::env::temp_dir().join(format!("zugit-ai-reviews-{}", std::process::id()));
        save_ai_review(&dir, &ai_review("org/app", 7, "claude-code")).unwrap();
        save_ai_review(&dir, &ai_review("org/app", 7, "claude-code")).unwrap();
        save_ai_review(&dir, &ai_review("org/app", 7, "codex/mcp client")).unwrap();
        save_ai_review(&dir, &ai_review("org/app", 8, "claude-code")).unwrap();
        assert_eq!(load_ai_reviews_for(&dir, "org/app", 7).len(), 2);
        delete_ai_review(&dir, "org/app", 7, "codex/mcp client").unwrap();
        assert_eq!(load_ai_reviews_for(&dir, "org/app", 7).len(), 1);
        assert!(ai_review_path(&dir, "../x", 1, "a").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn user_comments_round_trip_and_a_corrupt_file_is_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("zugit-user-reviews-{}", std::process::id()));
        let mut mine = load_user_review(&dir, "org/app", 7).unwrap();
        assert!(mine.comments.is_empty());
        let comment = crate::pr_review::NewComment {
            path: "a.ts".into(),
            line: 3,
            end_line: None,
            side: crate::pr_review::Side::New,
            head_sha: "abc1234".into(),
            diff_hunk: None,
            body: "check this".into(),
        };
        mine.add(comment, "2026-10-08T10:00:00Z").unwrap();
        save_user_review(&dir, &mine).unwrap();
        assert_eq!(load_user_review(&dir, "org/app", 7).unwrap().comments[0].body, "check this");

        let path = user_review_path(&dir, "org/app", 7).unwrap();
        std::fs::write(&path, "{ half a fi").unwrap();
        assert!(load_user_review(&dir, "org/app", 7).is_err());

        save_user_review(&dir, &crate::pr_review::UserReview::new("org/app", 7)).unwrap();
        assert!(!path.exists());
        assert!(load_user_review(&dir, "../x", 1).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_comment_added_while_a_review_goes_out_stays() {
        let dir = std::env::temp_dir().join(format!("zugit-user-reviews-publish-{}", std::process::id()));
        let comment = |line: u32, body: &str| crate::pr_review::NewComment {
            path: "a.ts".into(),
            line,
            end_line: None,
            side: crate::pr_review::Side::New,
            head_sha: "abc1234".into(),
            diff_hunk: None,
            body: body.into(),
        };
        update_user_review(&dir, "org/app", 7, |m| m.add(comment(3, "sent"), "t1")).unwrap();
        // The publish reads the comments, then talks to GitHub for a while…
        let sent = load_user_review(&dir, "org/app", 7).unwrap();
        // …during which one more is written.
        update_user_review(&dir, "org/app", 7, |m| m.add(comment(9, "written meanwhile"), "t2")).unwrap();
        let ids: Vec<String> = sent.comments.iter().map(|c| c.id.clone()).collect();
        let now = update_user_review(&dir, "org/app", 7, |m| {
            m.published(&ids, &sent, true);
            Ok(())
        })
        .unwrap();
        assert_eq!(now.comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(), vec!["written meanwhile"]);
        assert_eq!(load_user_review(&dir, "org/app", 7).unwrap().comments.len(), 1);

        // A change that fails writes nothing, and a file that does not parse is left alone.
        assert!(update_user_review(&dir, "org/app", 7, |m| m.edit("u9", "x")).is_err());
        assert_eq!(load_user_review(&dir, "org/app", 7).unwrap().comments.len(), 1);
        let path = user_review_path(&dir, "org/app", 7).unwrap();
        std::fs::write(&path, "{ half a fi").unwrap();
        assert!(update_user_review(&dir, "org/app", 7, |m| m.add(comment(1, "y"), "t3")).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ half a fi");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
