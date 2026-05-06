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
    // Legacy/fallback field. New fallback writes are only produced when they can
    // be protected by the platform (currently DPAPI on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    github_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    jira_token: Option<String>,
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
    stored_in_vault: bool,
) -> Result<Option<String>, String> {
    if stored_in_vault {
        return Ok(None);
    }

    if token.is_empty() {
        return Ok(None);
    }

    token_fallback_value(token)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "Could not store the {label} token in the system credential store, and this platform has no encrypted file fallback."
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

    // If legacy tokens were in the file, migrate them to the keychain.
    if persisted
        .github_token
        .as_deref()
        .is_some_and(|t| !t.is_empty())
    {
        set_secret("githubToken", &github_token);
    }
    if persisted
        .jira_token
        .as_deref()
        .is_some_and(|t| !t.is_empty())
    {
        set_secret("jiraToken", &jira_token);
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
    let github_in_keychain = set_secret("githubToken", &normalized.github_token);
    let jira_in_keychain = set_secret("jiraToken", &normalized.jira_token);
    let github_token_fallback =
        validate_token_persistence("GitHub", &normalized.github_token, github_in_keychain)?;
    let jira_token_fallback =
        validate_token_persistence("Jira", &normalized.jira_token, jira_in_keychain)?;

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
        github_token: github_token_fallback,
        jira_token: jira_token_fallback,
    };

    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;

    let used_vault = github_in_keychain && jira_in_keychain;
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
