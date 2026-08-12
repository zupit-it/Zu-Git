use crate::models::{
    serialize_settings_form, AppSettings, ChecklistItem, DashboardBootstrap, DashboardSnapshot,
    DraftPrInfo, ListFilterPreferences, ReleaseDiffItem, ReleaseDiffResult, SaveSettingsResult,
    SettingsFormValues, TokenStoreStatus,
};
use serde::Serialize;

// ── Update info ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub body: Option<String>,
}
use crate::{dashboard, secret_store, storage, AppState};

fn build_token_store_status(
    settings: &AppSettings,
    state: &tauri::State<'_, AppState>,
) -> TokenStoreStatus {
    let info = state
        .secret_store_info
        .get_or_init(secret_store::get_secret_store_info);
    let last_save_used_vault = *state.last_save_used_vault.lock();
    let last_save_used_file_fallback = last_save_used_vault == Some(false);
    let provider = if last_save_used_file_fallback {
        "fallback-file".to_string()
    } else {
        info.provider.clone()
    };
    let provider_detail = if last_save_used_file_fallback {
        "The last save used the encrypted file fallback because the system credential store write did not succeed.".to_string()
    } else {
        info.detail.clone()
    };
    let provider_ok = provider != "fallback-file";
    TokenStoreStatus {
        provider,
        provider_detail,
        provider_ok,
        github_token_present: !settings.github_token.is_empty(),
        jira_token_present: !settings.jira_token.is_empty(),
        last_save_used_vault,
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn bootstrap(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DashboardBootstrap, String> {
    let settings = storage::load_settings(&app).await?;
    let list_filters = storage::load_list_filter_preferences(&app).await?;
    // Initialises the OnceLock (runs probe once) and returns a reference.
    let secret_store_ref = state
        .secret_store_info
        .get_or_init(secret_store::get_secret_store_info);
    let secret_store = crate::models::SecretStoreInfo {
        provider: secret_store_ref.provider.clone(),
        detail: secret_store_ref.detail.clone(),
    };

    Ok(DashboardBootstrap {
        settings: serialize_settings_form(&settings),
        list_filters,
        secret_store,
    })
}

// ── Save settings ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    params: SettingsFormValues,
) -> Result<SaveSettingsResult, String> {
    let (settings, used_vault) = storage::save_settings(&app, &params).await?;
    *state.last_save_used_vault.lock() = Some(used_vault);

    // Clear caches after settings change.
    state.jira_cache.lock().clear();

    let mut snap = dashboard::build_dashboard_snapshot(
        &settings,
        &state.jira_cache,
        &state.http_client,
    )
    .await;
    snap.token_store = build_token_store_status(&settings, &state);

    Ok(SaveSettingsResult {
        settings: serialize_settings_form(&settings),
        dashboard: snap,
    })
}

// ── Refresh dashboard ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn refresh_dashboard(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DashboardSnapshot, String> {
    let settings = storage::load_settings(&app).await?;
    let mut snap = dashboard::build_dashboard_snapshot(
        &settings,
        &state.jira_cache,
        &state.http_client,
    )
    .await;
    snap.token_store = build_token_store_status(&settings, &state);
    Ok(snap)
}

// ── Open external URL ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_external(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("Blocked non-http URL: {url}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ── Native notification ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn show_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: Option<String>,
    silent: Option<bool>,
) -> Result<bool, String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app.notification().builder().title(&title);

    if let Some(b) = &body {
        builder = builder.body(b);
    }

    if silent.unwrap_or(false) {
        builder = builder.silent();
    }

    builder.show().map_err(|e| e.to_string())?;
    Ok(true)
}

// ── Save list filters ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_list_filters(
    app: tauri::AppHandle,
    params: ListFilterPreferences,
) -> Result<ListFilterPreferences, String> {
    storage::save_list_filter_preferences(&app, &params).await?;
    Ok(params)
}

// ── Draft PR ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_draft_pr_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    active_repos: Option<Vec<String>>,
) -> Result<Option<DraftPrInfo>, String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_github(&settings) {
        return Ok(None);
    }
    let repos = active_repos.unwrap_or_else(|| settings.github_repos.clone());
    Ok(crate::github::find_viewer_branch(&repos, &settings, &state.http_client).await)
}

#[tauri::command]
pub async fn fetch_branch_stats(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    base: String,
    head: String,
) -> Result<Option<crate::models::BranchStats>, String> {
    let settings = storage::load_settings(&app).await?;
    Ok(crate::github::fetch_compare(&repo, &base, &head, &settings, &state.http_client).await)
}

/// Remote branches with no open PR, untouched for longer than the configured
/// threshold. Not part of the dashboard refresh: scanning every branch of every
/// repo is expensive, so the view asks for it on demand.
#[tauri::command]
pub async fn fetch_stale_branches(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    active_repos: Option<Vec<String>>,
) -> Result<crate::models::StaleBranchesResult, String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_github(&settings) {
        return Err("Configure the GitHub token and at least one repository first.".to_string());
    }
    let repos = active_repos.unwrap_or_else(|| settings.github_repos.clone());
    crate::github::fetch_stale_branches(
        &repos,
        settings.stale_branch_days,
        &settings.stale_branch_ignored_prefixes,
        &settings,
        &state.http_client,
    )
    .await
    .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn create_pull_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    title: String,
    body: String,
    head: String,
    base: String,
    reviewers: Vec<String>,
    draft: bool,
) -> Result<String, String> {
    let settings = storage::load_settings(&app).await?;
    crate::github::create_pull_request(
        &repo, &title, &body, &head, &base, &reviewers, draft, &settings, &state.http_client,
    )
    .await
}

// ── Auto-update ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn invalidate_jira_cache(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.jira_cache.lock().clear();
    Ok(())
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater_builder()
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        body: u.body.clone(),
    }))
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater_builder()
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = update {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

// ── Request review ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fetch_draft_checklist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    jira_key: String,
) -> Result<Vec<ChecklistItem>, String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_jira(&settings) {
        return Ok(vec![]);
    }
    Ok(crate::jira::fetch_checklist(&jira_key, &settings, &state.http_client).await)
}

#[tauri::command]
pub async fn update_jira_checklist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    jira_key: String,
    items: Vec<ChecklistItem>,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_jira(&settings) {
        return Ok(());
    }
    crate::jira::write_checklist(&jira_key, &items, &settings, &state.http_client).await
}

#[tauri::command]
pub async fn complete_jira_story(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    jira_key: String,
    items: Vec<ChecklistItem>,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_jira(&settings) {
        return Ok(());
    }
    crate::jira::complete_jira_story(&jira_key, &items, &settings, &state.http_client).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn promote_draft_pr(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    pr_number: u64,
    node_id: String,
    title: String,
    body: String,
    reviewers: Vec<String>,
) -> Result<String, String> {
    let settings = storage::load_settings(&app).await?;
    crate::github::promote_draft_pr(
        &repo,
        pr_number,
        &node_id,
        &title,
        &body,
        &reviewers,
        &settings,
        &state.http_client,
    )
    .await
}

#[tauri::command]
pub async fn rebase_pull_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    pr_number: u64,
    node_id: String,
    head_sha: String,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    crate::github::rebase_pull_request(&node_id, &head_sha, &settings, &state.http_client)
        .await
        .map_err(|e| format!("{repo}#{pr_number}: {e}"))
}

#[tauri::command]
pub async fn request_review(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    pr_number: u64,
    login: String,
) -> Result<bool, String> {
    let settings = storage::load_settings(&app).await?;
    crate::github::request_review(&repo, pr_number, &login, &settings, &state.http_client).await?;
    Ok(true)
}

// ── Release diff helpers ──────────────────────────────────────────────────────

const AVATAR_PALETTE: &[&str] = &[
    "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#60a5fa",
    "#f97316", "#e879f9", "#2dd4bf", "#facc15", "#94a3b8",
];

fn avatar_color_for(login: &str) -> &'static str {
    let hash = login
        .bytes()
        .fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize));
    AVATAR_PALETTE[hash % AVATAR_PALETTE.len()]
}

fn author_initials(login: &str) -> String {
    login
        .split('-')
        .take(2)
        .filter_map(|p| p.chars().next())
        .map(|c| c.to_uppercase().next().unwrap_or(c))
        .collect()
}

// ── Release diff ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn fetch_release_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    release_name: String,
    project_key: Option<String>,
    repos: Option<Vec<String>>,
) -> Result<ReleaseDiffResult, String> {
    let settings = storage::load_settings(&app).await?;

    if !crate::models::settings_ready_for_github(&settings) {
        return Err("GitHub not configured".into());
    }
    if !crate::models::settings_ready_for_jira(&settings) {
        return Err("Jira not configured".into());
    }

    // Always fetch fresh Jira data — issue fields (e.g. fixVersions) may have changed since last call.
    state.jira_cache.lock().clear();

    let release_repos = repos
        .filter(|repos| !repos.is_empty())
        .unwrap_or_else(|| settings.github_repos.clone());

    // RT1 — one batched GitHub GraphQL query for tag-bounded merged PRs.
    let (merged_prs, since_tag) = crate::github::fetch_merged_prs_since_last_release(
        &release_repos,
        &settings,
        &state.http_client,
    )
    .await;

    // Collect unique Jira keys found in merged PRs (flattened across all keys per PR).
    let merged_keys: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        merged_prs
            .iter()
            .flat_map(|pr| pr.jira_keys.iter())
            .filter(|k| seen.insert(k.as_str()))
            .cloned()
            .collect()
    };

    // Build a map: jira_key → MergedPrRecord. Each key in a PR maps to that PR;
    // if the same key appears in two PRs the later one wins (acceptable edge case).
    let merged_map: std::collections::HashMap<String, &crate::github::MergedPrRecord> = merged_prs
        .iter()
        .flat_map(|pr| pr.jira_keys.iter().map(move |k| (k.clone(), pr)))
        .collect();

    // RT2 — Jira: planned issues for this release + all merged keys in one JQL call.
    let jira_issues = crate::jira::fetch_release_issues(
        &release_name,
        &merged_keys,
        &settings,
        &state.http_client,
    )
    .await?;

    // Derive a project key from the first Jira key found (e.g. "PENT-123" → "PENT")
    // only when the UI cannot provide the project from the release group.
    let derived_project_key = jira_issues
        .iter()
        .find_map(|i| i.key.split_once('-').map(|(p, _)| p.to_string()))
        .or_else(|| {
            merged_keys
                .iter()
                .find_map(|k| k.split_once('-').map(|(p, _)| p.to_string()))
        });
    let project_key = project_key
        .filter(|k| !k.trim().is_empty())
        .or(derived_project_key);

    // RT3 — Jira: all unreleased versions for the move dropdown, sorted by
    // release date ascending (undated ones go last). The current release is
    // always prepended so Extra stories can be moved back into it.
    let available_versions = if let Some(pk) = project_key {
        let mut versions = crate::jira::fetch_project_versions(&pk, &settings, &state.http_client).await;
        if versions.first().map(|v| v.as_str()) != Some(release_name.as_str()) {
            versions.insert(0, release_name.clone());
        }
        versions
    } else {
        vec![release_name.clone()]
    };

    // ── Build diff ────────────────────────────────────────────────────────────

    // Statuses that mean the story is complete even without a detectable PR.
    // (Verified = QA confirmed, Closed/Released/Done = obvious terminal states.)
    let terminal_statuses: &[&str] = &["verified", "closed", "released", "done"];
    let is_terminal = |status: &str| terminal_statuses.contains(&status.to_lowercase().as_str());

    // Set of unreleased version names — used to filter out Extra stories that
    // already belong to a past release (they are historical noise for this diff).
    let available_set: std::collections::HashSet<&str> =
        available_versions.iter().map(|v| v.as_str()).collect();

    // Separate planned (release_name is one of the issue's fixVersions) from all
    // fetched issues. A story can carry several fixVersions at once.
    let planned_keys: std::collections::HashSet<String> = jira_issues
        .iter()
        .filter(|i| i.has_release(&release_name))
        .map(|i| i.key.clone())
        .collect();

    // Map all jira issues by key.
    let jira_map: std::collections::HashMap<String, &crate::jira::JiraIssueSummary> =
        jira_issues.iter().map(|i| (i.key.clone(), i)).collect();

    let make_item = |issue: &crate::jira::JiraIssueSummary, merged: Option<&crate::github::MergedPrRecord>, flag: Option<String>| {
        let author = merged.map(|m| m.author.as_str()).unwrap_or("").to_string();
        let initials = author_initials(&author);
        let avatar_color = avatar_color_for(&author).to_string();
        let avatar_url = merged.and_then(|m| m.author_avatar_url.clone());
        ReleaseDiffItem {
            key: issue.key.clone(),
            summary: issue.summary.clone(),
            status: issue.status.clone(),
            issue_type: issue.issue_type.clone(),
            fix_versions: issue.release_names(),
            pr_url: merged.map(|m| m.url.clone()),
            pr_number: merged.map(|m| m.number),
            branch: merged.map(|m| m.head_ref.clone()).unwrap_or_default(),
            author,
            initials,
            avatar_color,
            avatar_url,
            // Flagged: merged on main but Jira status is not terminal and not
            // "developed" — git is ahead of Jira (covers Rejected and similar).
            is_preview: merged.is_some()
                && !is_terminal(&issue.status)
                && issue.status.to_lowercase() != "developed",
            flag,
        }
    };

    let mut done: Vec<ReleaseDiffItem> = vec![];
    let mut missing: Vec<ReleaseDiffItem> = vec![];
    let mut extra: Vec<ReleaseDiffItem> = vec![];

    // Planned issues → done or missing.
    // A story is Done if a merged PR was found OR if it already has a terminal
    // status (e.g. Verified) — in that case it's confirmed on main even if the
    // PR title didn't carry the Jira key.
    for key in &planned_keys {
        if let Some(issue) = jira_map.get(key) {
            let merged = merged_map.get(key).copied();
            if merged.is_some() || is_terminal(&issue.status) {
                // Flag when we relied on terminal status alone (no PR link found) — Jira ahead of git.
                let flag = if merged.is_none() {
                    Some("no-pr".to_string())
                } else {
                    None
                };
                done.push(make_item(issue, merged, flag));
            } else {
                // Flag when Developed — Jira says code is ready but no merged PR found.
                let flag = if issue.status.to_lowercase() == "developed" {
                    Some("no-pr".to_string())
                } else {
                    None
                };
                missing.push(make_item(issue, None, flag));
            }
        }
    }

    // Merged PRs with a Jira key not in the planned set → extra.
    // Skip stories whose fixVersion belongs to an already-released version
    // (not in available_versions and not the current release) — those are just
    // historical PRs that happen to fall inside the time window.
    for key in &merged_keys {
        if planned_keys.contains(key) {
            continue; // already counted as done
        }
        if let Some(issue) = jira_map.get(key) {
            // Keep only: unscheduled, or at least one fixVersion that is the
            // current release or a known unreleased one. Skip only when *every*
            // version belongs to an already-released (historical) version.
            let is_unscheduled = issue.releases.is_empty();
            let touches_relevant = issue
                .releases
                .iter()
                .any(|v| v.name == release_name || available_set.contains(v.name.as_str()));
            if !is_unscheduled && !touches_relevant {
                continue; // all versions belong to past releases — skip
            }
            let merged = merged_map.get(key).copied();
            // Flag when the story is merged but Jira status is still open — git ahead of Jira.
            let flag = if !is_terminal(&issue.status) {
                Some("no-jira".to_string())
            } else {
                None
            };
            extra.push(make_item(issue, merged, flag));
        } else {
            // Merged on main but no Jira issue found for the extracted key.
            let merged = merged_map.get(key).copied();
            let author = merged.map(|m| m.author.as_str()).unwrap_or("").to_string();
            let initials = author_initials(&author);
            let avatar_color = avatar_color_for(&author).to_string();
            let avatar_url = merged.and_then(|m| m.author_avatar_url.clone());
            extra.push(ReleaseDiffItem {
                key: key.clone(),
                summary: merged.map(|m| m.title.clone()).unwrap_or_default(),
                status: String::new(),
                issue_type: String::new(),
                fix_versions: vec![],
                pr_url: merged.map(|m| m.url.clone()),
                pr_number: merged.map(|m| m.number),
                branch: merged.map(|m| m.head_ref.clone()).unwrap_or_default(),
                author,
                initials,
                avatar_color,
                avatar_url,
                is_preview: false,
                flag: Some("no-jira".to_string()),
            });
        }
    }

    // Sort for stable display.
    done.sort_by(|a, b| a.key.cmp(&b.key));
    missing.sort_by(|a, b| a.key.cmp(&b.key));
    extra.sort_by(|a, b| a.key.cmp(&b.key));

    let repo = release_repos.join(" · ");
    let synced_at = "just now".to_string();

    Ok(ReleaseDiffResult {
        done,
        missing,
        extra,
        available_versions,
        synced_at,
        repo,
        since_tag,
    })
}

// ── Toggl ─────────────────────────────────────────────────────────────────────

/// Everything the day planner needs, in one round trip: the Toggl account, the
/// entries already booked inside the working range, the stories the viewer is
/// working on, and the learned project/tag mapping.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglDayContext {
    pub account: crate::toggl::TogglAccount,
    pub workspace_id: i64,
    pub existing: Vec<crate::toggl::TogglTimeEntry>,
    pub issues: Vec<crate::jira::ActiveIssue>,
    pub rules: crate::toggl::LearnedRules,
    /// Google Calendar events overlapping the range, when the calendar is connected.
    pub events: Vec<crate::google::CalendarEvent>,
    pub warnings: Vec<String>,
}

/// Rules older than this are refreshed from Toggl history on the next open.
const TOGGL_RULES_MAX_AGE_DAYS: i64 = 7;

fn toggl_settings(settings: &AppSettings) -> Result<(), String> {
    if !settings.toggl_enabled {
        return Err("Toggl integration is disabled in Settings.".into());
    }
    if settings.toggl_token.is_empty() {
        return Err("Toggl API token missing — add it in Settings.".into());
    }
    Ok(())
}

/// The account payload behind a session cache: `/me` is capped at 30 calls/hour
/// on Free plans, so it is fetched once per token unless `force` is set.
async fn toggl_account(
    settings: &AppSettings,
    state: &tauri::State<'_, AppState>,
    force: bool,
) -> Result<crate::toggl::TogglAccount, String> {
    if !force {
        if let Some((token, account)) = state.toggl_account.lock().as_ref() {
            if token == &settings.toggl_token {
                return Ok(account.clone());
            }
        }
    }
    let account = crate::toggl::fetch_account(&settings.toggl_token, &state.http_client)
        .await
        .map_err(String::from)?;
    *state.toggl_account.lock() = Some((settings.toggl_token.clone(), account.clone()));
    Ok(account)
}

fn toggl_workspace_id(
    settings: &AppSettings,
    account: &crate::toggl::TogglAccount,
) -> Result<i64, String> {
    settings
        .toggl_workspace_id
        .trim()
        .parse::<i64>()
        .ok()
        .or(account.default_workspace_id)
        .or_else(|| account.workspaces.first().map(|w| w.id))
        .ok_or_else(|| "No Toggl workspace available for this account.".to_string())
}

// ── Google Calendar ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatus {
    pub connected: bool,
    /// Loopback URI to register in the Google Cloud console.
    pub redirect_uri: String,
}

/// A live access token, refreshed only when the cached one is about to expire.
async fn google_access_token(
    settings: &AppSettings,
    state: &tauri::State<'_, AppState>,
) -> Result<String, String> {
    if let Some((token, expires_at)) = state.google_access.lock().as_ref() {
        if *expires_at > std::time::Instant::now() {
            return Ok(token.clone());
        }
    }

    let refresh_token = secret_store::get_secret("googleRefreshToken");
    if refresh_token.is_empty() {
        return Err("Google Calendar not connected — connect it in Settings.".into());
    }

    let (token, expires_in) = crate::google::refresh_access_token(
        &settings.google_client_id,
        &settings.google_client_secret,
        &refresh_token,
        &state.http_client,
    )
    .await?;

    // Refresh a minute early rather than racing the expiry.
    let expires_at = std::time::Instant::now()
        + std::time::Duration::from_secs(expires_in.saturating_sub(60).max(30));
    *state.google_access.lock() = Some((token.clone(), expires_at));
    Ok(token)
}

#[tauri::command]
pub async fn google_status(app: tauri::AppHandle) -> Result<GoogleStatus, String> {
    let _ = storage::load_settings(&app).await?;
    Ok(GoogleStatus {
        connected: !secret_store::get_secret("googleRefreshToken").is_empty(),
        redirect_uri: crate::google::redirect_uri(),
    })
}

#[tauri::command]
pub async fn google_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::google::GoogleConnection, String> {
    let settings = storage::load_settings(&app).await?;
    if settings.google_client_id.is_empty() || settings.google_client_secret.is_empty() {
        return Err("Add the Google client id and secret in Settings, then save.".into());
    }

    let (refresh_token, connection) = crate::google::authorize(
        &settings.google_client_id,
        &settings.google_client_secret,
        &app,
        &state.http_client,
    )
    .await?;

    if let Err(reason) = secret_store::set_secret("googleRefreshToken", &refresh_token) {
        return Err(format!(
            "Could not store the Google refresh token in the system credential store ({reason})."
        ));
    }
    *state.google_access.lock() = None;
    Ok(connection)
}

#[tauri::command]
pub async fn google_disconnect(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let _ = secret_store::set_secret("googleRefreshToken", "");
    *state.google_access.lock() = None;
    Ok(())
}

#[tauri::command]
pub async fn toggl_check_connection(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<crate::toggl::TogglAccount, String> {
    let settings = storage::load_settings(&app).await?;
    toggl_settings(&settings)?;
    toggl_account(&settings, &state, true).await
}

#[tauri::command]
pub async fn toggl_prepare_day(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    range_start: String,
    range_end: String,
    force_relearn: bool,
) -> Result<TogglDayContext, String> {
    let settings = storage::load_settings(&app).await?;
    toggl_settings(&settings)?;

    let account = toggl_account(&settings, &state, false).await?;
    let workspace_id = toggl_workspace_id(&settings, &account)?;
    let mut warnings: Vec<String> = vec![];

    let entries_fut = crate::toggl::fetch_time_entries(
        &settings.toggl_token,
        &range_start,
        &range_end,
        &state.http_client,
    );
    let issues_fut = async {
        if crate::models::settings_ready_for_jira(&settings) {
            crate::jira::fetch_my_active_issues(&settings, &state.http_client).await
        } else {
            Ok(crate::jira::ActiveIssues {
                issues: vec![],
                sprint_scoped: true,
            })
        }
    };
    let (entries, issues) = futures::future::join(entries_fut, issues_fut).await;

    let existing = entries.map_err(String::from)?;
    let issues = match issues {
        Ok(active) => {
            if !active.sprint_scoped && !active.issues.is_empty() {
                warnings.push(
                    "Nessuna story nello sprint attivo: mostro tutte le story assegnate a te."
                        .to_string(),
                );
            }
            active.issues
        }
        Err(error) => {
            warnings.push(format!("Jira stories unavailable: {error}"));
            vec![]
        }
    };
    if !crate::models::settings_ready_for_jira(&settings) {
        warnings.push("Jira is not configured — no stories to propose.".to_string());
    }

    // Calendar events are proposals, not blockers: a failure here degrades to a
    // warning instead of sinking the whole day plan.
    let mut events = vec![];
    if settings.google_calendar_enabled {
        match google_access_token(&settings, &state).await {
            Ok(token) => {
                let calendar_id = if settings.google_calendar_id.trim().is_empty() {
                    "primary"
                } else {
                    settings.google_calendar_id.trim()
                };
                match crate::google::fetch_events(
                    &token,
                    calendar_id,
                    &range_start,
                    &range_end,
                    &state.http_client,
                )
                .await
                {
                    Ok(fetched) => events = fetched,
                    Err(error) => warnings.push(format!("Google Calendar: {error}")),
                }
            }
            Err(error) => warnings.push(format!("Google Calendar: {error}")),
        }
    }

    let mut rules = storage::load_toggl_rules(&app);
    let stale = force_relearn
        || rules.entries_scanned == 0
        // Cached under an older shape: re-learn rather than answer with defaults
        // for fields that did not exist when the file was written.
        || rules.version < crate::toggl::RULES_VERSION
        || chrono::DateTime::parse_from_rfc3339(&rules.learned_at)
            .map(|learned| {
                (chrono::Utc::now() - learned.with_timezone(&chrono::Utc)).num_days()
                    >= TOGGL_RULES_MAX_AGE_DAYS
            })
            .unwrap_or(true);

    if stale {
        let today = chrono::Local::now();
        let from = (today - chrono::Duration::days(settings.toggl_history_days as i64))
            .format("%Y-%m-%d")
            .to_string();
        let to = today.format("%Y-%m-%d").to_string();
        match crate::toggl::fetch_time_entries(
            &settings.toggl_token,
            &from,
            &to,
            &state.http_client,
        )
        .await
        {
            Ok(history) => {
                rules = crate::toggl::learn_from_entries(&history, chrono::Utc::now().to_rfc3339());
                if let Err(error) = storage::save_toggl_rules(&app, &rules) {
                    warnings.push(format!("Could not cache the learned mapping: {error}"));
                }
            }
            Err(error) => warnings.push(format!(
                "Could not read Toggl history — project mapping may be incomplete: {error}"
            )),
        }
    }

    Ok(TogglDayContext {
        account,
        workspace_id,
        existing,
        issues,
        rules,
        events,
        warnings,
    })
}

#[tauri::command]
pub async fn toggl_submit_entries(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    entries: Vec<crate::toggl::NewTimeEntry>,
) -> Result<Vec<crate::toggl::CreatedEntry>, String> {
    let settings = storage::load_settings(&app).await?;
    toggl_settings(&settings)?;

    let account = toggl_account(&settings, &state, false).await?;
    let workspace_id = toggl_workspace_id(&settings, &account)?;

    // Sequential on purpose: Toggl rejects concurrent writes with 429 far too
    // eagerly, and a day is only ever a handful of entries.
    let mut results = Vec::with_capacity(entries.len());
    let mut created_entries = Vec::new();
    for entry in &entries {
        match crate::toggl::create_time_entry(
            &settings.toggl_token,
            workspace_id,
            entry,
            &state.http_client,
        )
        .await
        {
            Ok(id) => {
                created_entries.push(crate::toggl::TogglTimeEntry {
                    id,
                    workspace_id,
                    project_id: entry.project_id,
                    description: entry.description.clone(),
                    start: entry.start.clone(),
                    stop: Some(entry.stop.clone()),
                    duration: entry.duration_seconds,
                    tags: entry.tags.clone(),
                    billable: entry.billable,
                });
                results.push(crate::toggl::CreatedEntry {
                    client_ref: entry.client_ref.clone(),
                    id: Some(id),
                    description: entry.description.clone(),
                    ok: true,
                    error: None,
                });
            }
            Err(error) => results.push(crate::toggl::CreatedEntry {
                client_ref: entry.client_ref.clone(),
                id: None,
                description: entry.description.clone(),
                ok: false,
                error: Some(error.to_string()),
            }),
        }
    }

    if !created_entries.is_empty() {
        let mut rules = storage::load_toggl_rules(&app);
        crate::toggl::reinforce_rules(&mut rules, &created_entries, chrono::Utc::now().to_rfc3339());
        let _ = storage::save_toggl_rules(&app, &rules);
    }

    Ok(results)
}

#[tauri::command]
pub async fn move_to_developed(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    jira_key: String,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    crate::jira::transition_issue(&jira_key, "Developed", &settings, &state.http_client).await
}

#[tauri::command]
pub async fn move_jira_fix_versions(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
    target_version: String,
    current_version: Option<String>,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_jira(&settings) {
        return Err("Jira not configured".into());
    }

    let from = current_version.as_deref();
    let futs: Vec<_> = keys
        .iter()
        .map(|key| crate::jira::move_fix_version(key, from, &target_version, &settings, &state.http_client))
        .collect();

    let results = futures::future::join_all(futs).await;
    let errors: Vec<String> = results.into_iter().filter_map(|r| r.err()).collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub async fn drop_jira_fix_versions(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    keys: Vec<String>,
    current_version: Option<String>,
) -> Result<(), String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_jira(&settings) {
        return Err("Jira not configured".into());
    }

    let version = current_version.as_deref();
    let futs: Vec<_> = keys
        .iter()
        .map(|key| crate::jira::drop_fix_version(key, version, &settings, &state.http_client))
        .collect();

    let results = futures::future::join_all(futs).await;
    let errors: Vec<String> = results.into_iter().filter_map(|r| r.err()).collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
