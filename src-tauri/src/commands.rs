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
    log_notification(&app, &title, body.as_deref());
    Ok(true)
}

/// Appends every notification ZuGit sends to `notifications.log` in the app data
/// folder — the way to tell a repeat sent by ZuGit from one macOS re-shows.
fn log_notification(app: &tauri::AppHandle, title: &str, body: Option<&str>) {
    use std::io::Write;
    let Ok(dir) = storage::data_dir(app) else { return };
    let path = dir.join("notifications.log");
    // Keep it small: start over once it passes 256 KB.
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(
            file,
            "{}\tpid {}\t{}\t{}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            std::process::id(),
            title,
            body.unwrap_or_default()
        );
    }
}

/// Claims the end-of-day Toggl reminder for `day` ("YYYY-MM-DD"): true the first
/// time, false afterwards. Kept in a file rather than the webview's localStorage,
/// which WebKit flushes lazily and can lose on a crash or forced quit.
#[tauri::command]
pub async fn toggl_claim_reminder(app: tauri::AppHandle, day: String) -> Result<bool, String> {
    let dir = storage::data_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("toggl-reminder.txt");
    if std::fs::read_to_string(&path).map(|last| last.trim() == day).unwrap_or(false) {
        return Ok(false);
    }
    std::fs::write(&path, &day).map_err(|e| e.to_string())?;
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

/// The review conversations on a PR, for the diff view. Not cached: they
/// change whenever someone comments.
#[tauri::command]
pub async fn fetch_pr_threads(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    number: u64,
) -> Result<Vec<crate::github::ReviewThread>, String> {
    if !crate::pr_review::valid_repo(&repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let settings = storage::load_settings(&app).await?;
    Ok(crate::github::fetch_review_threads(&repo, number, &settings, &state.http_client).await?)
}

/// Files and patches of a pull request at its latest commit, together with
/// that commit: comments on them are anchored to it. The files are read
/// between two looks at the PR's head, so a push landing meanwhile can never
/// pair them with the wrong commit. Cached by head: until someone pushes,
/// reopening costs one small request.
#[tauri::command]
pub async fn fetch_pr_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    number: u64,
) -> Result<crate::models::PrDiff, String> {
    if !crate::pr_review::valid_repo(&repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let settings = storage::load_settings(&app).await?;
    current_diff(&state, &settings, &repo, number).await
}

/// The PR's diff at its latest commit, with that commit — see `fetch_pr_diff`.
async fn current_diff(
    state: &AppState,
    settings: &crate::models::AppSettings,
    repo: &str,
    number: u64,
) -> Result<crate::models::PrDiff, String> {
    const CACHE_LIMIT: usize = 32;
    const ATTEMPTS: usize = 3;
    let client = &state.http_client;
    for _ in 0..ATTEMPTS {
        let head = crate::github::fetch_pr_meta(repo, number, settings, client).await?.head_sha;
        let key = format!("{repo}#{number}@{head}");
        if let Some(hit) = state.pr_diff_cache.lock().get(&key) {
            return Ok(hit.clone());
        }
        let mut diff = crate::github::fetch_pr_files(repo, number, settings, client).await?;
        // A push landed while the files were read: read them again.
        if crate::github::fetch_pr_meta(repo, number, settings, client).await?.head_sha != head {
            continue;
        }
        diff.head_sha = head;
        let mut cache = state.pr_diff_cache.lock();
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, diff.clone());
        return Ok(diff);
    }
    Err("The pull request is being pushed to right now — try again in a moment.".into())
}

/// Where each of the user's comments written on an older commit sits on the
/// diff's: one compare per older commit, cached, since commits never change.
/// When GitHub cannot be asked, a comment's own code decides.
async fn carry_all(
    state: &AppState,
    settings: &crate::models::AppSettings,
    repo: &str,
    mine: &crate::pr_review::UserReview,
    diff: &crate::models::PrDiff,
) -> std::collections::HashMap<String, crate::pr_review::Carry> {
    use crate::pr_review::{carry, is_sha, DiffIndex, Placement};
    const CACHE_LIMIT: usize = 64;
    let index = DiffIndex::new(&diff.files);
    let head = diff.head_sha.to_lowercase();
    let mut carried = std::collections::HashMap::new();
    for comment in &mine.comments {
        let from = comment.head_sha.to_lowercase();
        if comment.placement != Placement::Inline || from.is_empty() || head.starts_with(&from) {
            continue;
        }
        let key = format!("{repo}@{from}...{head}");
        let cached = state.pr_compare_cache.lock().get(&key).cloned();
        let compare = match cached {
            Some(hit) => Some(hit),
            None if is_sha(&from) => {
                match crate::github::fetch_commit_compare(repo, &from, &head, settings, &state.http_client).await {
                    Ok(fresh) => {
                        let mut cache = state.pr_compare_cache.lock();
                        if cache.len() >= CACHE_LIMIT {
                            cache.clear();
                        }
                        cache.insert(key, fresh.clone());
                        Some(fresh)
                    }
                    Err(_) => None,
                }
            }
            None => None,
        };
        carried.insert(comment.id.clone(), carry(comment, compare.as_ref(), &index));
    }
    carried
}

/// Where the user's comments written on an older commit sit on the PR's
/// latest one: moved with code that did not change, or outdated.
#[tauri::command]
pub async fn pr_comment_positions(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    number: u64,
) -> Result<Vec<crate::pr_review::CommentPosition>, String> {
    if !crate::pr_review::valid_repo(&repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let mine = storage::load_user_review(&storage::data_dir(&app)?, &repo, number)?;
    let settings = storage::load_settings(&app).await?;
    let diff = current_diff(&state, &settings, &repo, number).await?;
    let carried = carry_all(&state, &settings, &repo, &mine, &diff).await;
    Ok(carried
        .into_iter()
        .map(|(id, carry)| crate::pr_review::CommentPosition::new(id, carry, &diff.head_sha))
        .collect())
}

/// The PR's latest commit: an open diff compares it with its own to notice new pushes.
#[tauri::command]
pub async fn fetch_pr_head(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    number: u64,
) -> Result<String, String> {
    if !crate::pr_review::valid_repo(&repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let settings = storage::load_settings(&app).await?;
    Ok(crate::github::fetch_pr_meta(&repo, number, &settings, &state.http_client).await?.head_sha)
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

/// Branches the release diff can be compared against, filtered by the
/// `release_branch_prefix` setting.
#[tauri::command]
pub async fn fetch_release_branches(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repos: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_github(&settings) {
        return Err("GitHub not configured".into());
    }
    let repos = repos
        .filter(|repos| !repos.is_empty())
        .unwrap_or_else(|| settings.github_repos.clone());
    Ok(crate::github::fetch_release_branches(
        &repos,
        &settings.release_branch_prefix,
        &settings,
        &state.http_client,
    )
    .await)
}

#[tauri::command]
pub async fn fetch_release_diff(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    release_name: String,
    project_key: Option<String>,
    repos: Option<Vec<String>>,
    target_branch: Option<String>,
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

    // Empty = the default branch.
    let target_branch = target_branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());

    // RT1 — one batched GitHub GraphQL query for tag-bounded merged PRs. On a
    // release branch, main's recent history is fetched alongside it for the map.
    let merged_fut = crate::github::fetch_merged_prs_since_last_release(
        &release_repos,
        target_branch.as_deref(),
        &settings,
        &state.http_client,
    );
    let mainline_fut = async {
        match target_branch {
            Some(_) => Some(crate::github::fetch_mainline(&release_repos, &settings, &state.http_client).await),
            None => None,
        }
    };
    let ((merged_prs, since_tag), mainline) = tokio::join!(merged_fut, mainline_fut);

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

    // Every merge of each story on the compared branch, oldest first. A story
    // can land more than once: its first release, then a rework after a reject
    // — same key in the title, whatever the prefix.
    let mut records_by_key: std::collections::HashMap<String, Vec<&crate::github::MergedPrRecord>> =
        std::collections::HashMap::new();
    for pr in &merged_prs {
        for key in &pr.jira_keys {
            let list = records_by_key.entry(key.clone()).or_default();
            if !list.iter().any(|r| std::ptr::eq(*r, pr)) {
                list.push(pr);
            }
        }
    }
    // RFC 3339 timestamps from the same API sort correctly as strings.
    records_by_key.values_mut().for_each(|list| list.sort_by(|a, b| a.merged_at.cmp(&b.merged_at)));
    // A row links the latest merge: the rework, when there is one.
    let merged_map: std::collections::HashMap<String, &crate::github::MergedPrRecord> = records_by_key
        .iter()
        .filter_map(|(key, list)| list.last().map(|r| (key.clone(), *r)))
        .collect();

    // On a release branch: each story's PRs on main, oldest first, to tell
    // whether all of them were picked.
    let mut main_prs_by_key: std::collections::HashMap<&str, Vec<&crate::models::MainlineCommit>> =
        std::collections::HashMap::new();
    for commit in mainline.iter().flat_map(|m| m.commits.iter()) {
        for key in &commit.jira_keys {
            main_prs_by_key.entry(key.as_str()).or_default().push(commit);
        }
    }

    let prs_for = |key: &str| -> Vec<crate::models::ItemPr> {
        let records = records_by_key.get(key).map(|v| v.as_slice()).unwrap_or(&[]);
        match (target_branch.is_some(), main_prs_by_key.get(key)) {
            (true, Some(main)) => {
                use crate::release_picks::{pick_status, Merge};
                let merges: Vec<Merge> = main.iter().map(|c| Merge { number: c.number, merged_at: &c.merged_at }).collect();
                let picks: Vec<Merge> = records.iter().map(|r| Merge { number: r.number, merged_at: &r.merged_at }).collect();
                main.iter()
                    .zip(pick_status(&merges, &picks))
                    .map(|(c, picked)| crate::models::ItemPr {
                        number: c.number,
                        url: c.url.clone(),
                        merged_at: c.merged_at.clone(),
                        picked,
                    })
                    .collect()
            }
            (on_branch, _) => records
                .iter()
                .map(|r| crate::models::ItemPr {
                    number: r.number,
                    url: r.url.clone(),
                    merged_at: r.merged_at.clone(),
                    picked: on_branch.then_some(true),
                })
                .collect(),
        }
    };

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

    let make_item = |issue: &crate::jira::JiraIssueSummary, merged: Option<&crate::github::MergedPrRecord>, flag: Option<String>, prs: Vec<crate::models::ItemPr>| {
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
            epic_key: issue.epic.as_ref().and_then(|e| e.key.clone()),
            epic_name: issue.epic.as_ref().map(|e| e.name.clone()),
            merged_at: merged.map(|m| m.merged_at.clone()).filter(|d| !d.is_empty()),
            prs,
        }
    };

    let mut done: Vec<ReleaseDiffItem> = vec![];
    let mut missing: Vec<ReleaseDiffItem> = vec![];
    let mut extra: Vec<ReleaseDiffItem> = vec![];

    // Planned issues → done or missing.
    // A story is Done if a merged PR was found OR if it already has a terminal
    // status (e.g. Verified) — in that case it's confirmed on main even if the
    // PR title didn't carry the Jira key. A release branch gets no such benefit
    // of the doubt: a verified story is exactly what may still need cherry-picking.
    let trust_terminal_status = target_branch.is_none();
    for key in &planned_keys {
        if let Some(issue) = jira_map.get(key) {
            let merged = merged_map.get(key).copied();
            let prs = prs_for(key);
            // Picked once, but a rework merged on main after that pick is not on
            // the branch: the story is only partly there.
            let rework = prs.iter().find(|p| p.picked == Some(false)).filter(|_| merged.is_some()).cloned();
            if let Some(rework) = rework {
                let mut item = make_item(issue, merged, Some("rework-not-picked".to_string()), prs);
                item.pr_url = Some(rework.url);
                item.pr_number = Some(rework.number);
                item.merged_at = None;
                missing.push(item);
            } else if merged.is_some() || (trust_terminal_status && is_terminal(&issue.status)) {
                // Flag when we relied on terminal status alone (no PR link found) — Jira ahead of git.
                let flag = if merged.is_none() {
                    Some("no-pr".to_string())
                } else {
                    None
                };
                done.push(make_item(issue, merged, flag, prs));
            } else {
                // Flag when Developed (or done, on a release branch) — Jira says
                // code is ready but no merged PR found.
                let flag = if issue.status.to_lowercase() == "developed" || is_terminal(&issue.status) {
                    Some("no-pr".to_string())
                } else {
                    None
                };
                missing.push(make_item(issue, None, flag, prs));
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
            extra.push(make_item(issue, merged, flag, prs_for(key)));
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
                epic_key: None,
                epic_name: None,
                merged_at: merged.map(|m| m.merged_at.clone()).filter(|d| !d.is_empty()),
                prs: prs_for(key),
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
        mainline,
    })
}

// ── Toggl ─────────────────────────────────────────────────────────────────────

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

pub fn toggl_workspace_id(
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

/// Everything the day planner needs, in one round trip — see [`crate::toggl_day`].
#[tauri::command]
pub async fn toggl_prepare_day(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    date: String,
    range_start: String,
    range_end: String,
    force_relearn: bool,
) -> Result<crate::toggl_day::TogglDayContext, String> {
    let settings = storage::load_settings(&app).await?;
    toggl_settings(&settings)?;

    let account = toggl_account(&settings, &state, false).await?;
    let workspace_id = toggl_workspace_id(&settings, &account)?;
    let day = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d")
        .map_err(|_| format!("Invalid date '{date}'."))?;
    // Calendar events are proposals, not blockers: a failure here degrades to a
    // warning instead of sinking the whole day plan.
    let google_token = if settings.google_calendar_enabled {
        Some(google_access_token(&settings, &state).await)
    } else {
        None
    };
    let data_dir = storage::data_dir(&app)?;

    crate::toggl_day::build_context(crate::toggl_day::DayRequest {
        settings: &settings,
        data_dir: &data_dir,
        client: &state.http_client,
        account,
        workspace_id,
        google_token,
        range_start,
        range_end,
        day,
        force_relearn,
    })
    .await
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
    let mut created_events = Vec::new();
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
                let created = crate::toggl::TogglTimeEntry {
                    id,
                    workspace_id,
                    project_id: entry.project_id,
                    description: entry.description.clone(),
                    start: entry.start.clone(),
                    stop: Some(entry.stop.clone()),
                    duration: entry.duration_seconds,
                    tags: entry.tags.clone(),
                    billable: entry.billable,
                };
                if let Some(calendar) = &entry.calendar_event {
                    created_events.push((calendar.clone(), created.clone()));
                }
                created_entries.push(created);
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

    let data_dir = storage::data_dir(&app)?;
    if !created_entries.is_empty() {
        let mut rules = storage::load_toggl_rules(&data_dir);
        crate::toggl::reinforce_rules(&mut rules, &created_entries, chrono::Utc::now().to_rfc3339());
        let _ = storage::save_toggl_rules(&data_dir, &rules);
    }
    if !created_events.is_empty() {
        let mut memory = storage::load_event_memory(&data_dir);
        for (calendar, created) in &created_events {
            memory.remember(calendar, created);
        }
        let _ = storage::save_event_memory(&data_dir, &memory);
    }

    Ok(results)
}

/// The plan an MCP client proposed for `date`, if one is waiting.
#[tauri::command]
pub async fn toggl_get_proposal(
    app: tauri::AppHandle,
    date: String,
) -> Result<Option<crate::toggl_day::TogglProposal>, String> {
    Ok(storage::load_toggl_proposal(&storage::data_dir(&app)?, &date))
}

/// Drops the proposal for `date` — after it was submitted, or when the user
/// prefers the automatic plan.
#[tauri::command]
pub async fn toggl_discard_proposal(app: tauri::AppHandle, date: String) -> Result<(), String> {
    storage::delete_toggl_proposal(&storage::data_dir(&app)?, &date)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingProposal {
    pub date: String,
    pub created_at: String,
}

/// Proposals waiting for review — polled so ZuGit can react when an AI
/// assistant hands one over.
#[tauri::command]
pub async fn toggl_list_proposals(app: tauri::AppHandle) -> Result<Vec<PendingProposal>, String> {
    let dir = storage::data_dir(&app)?;
    // Same reach as the planner's date picker.
    storage::prune_toggl_proposals(&dir, chrono::Local::now().date_naive(), 7);
    Ok(storage::list_toggl_proposals(&dir)
        .into_iter()
        .map(|(date, created_at)| PendingProposal { date, created_at })
        .collect())
}

// ── AI review proposals ───────────────────────────────────────────────────────

/// Every proposal an agent handed over through `zugit --mcp` — polled, so the
/// PR rows can show what is waiting.
#[tauri::command]
pub async fn ai_review_list(app: tauri::AppHandle) -> Result<Vec<crate::pr_review::AiReviewSummary>, String> {
    let dir = storage::data_dir(&app)?;
    storage::prune_ai_reviews(&dir, chrono::Utc::now(), crate::pr_review::KEEP_DAYS);
    Ok(storage::load_ai_reviews(&dir).iter().map(|review| review.summary()).collect())
}

#[tauri::command]
pub async fn ai_review_get(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
) -> Result<Vec<crate::pr_review::AiReview>, String> {
    Ok(storage::load_ai_reviews_for(&storage::data_dir(&app)?, &repo, number))
}

/// The proposal the diff view shows, or an error when the agent replaced it
/// since: a new proposal numbers its comments from c1 again, so an id from the
/// old one would land on another comment.
fn shown_ai_review(
    dir: &std::path::Path,
    repo: &str,
    number: u64,
    source: &str,
    created_at: &str,
) -> Result<crate::pr_review::AiReview, String> {
    storage::load_ai_reviews_for(dir, repo, number)
        .into_iter()
        .find(|review| review.source == source && review.created_at == created_at)
        .ok_or_else(|| "This AI review was replaced or discarded meanwhile.".to_string())
}

/// Sends an AI comment back to triage, or discards it. Keeping goes through
/// `ai_review_keep_comment`: a kept comment becomes the user's.
#[tauri::command]
pub async fn ai_review_set_status(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    source: String,
    created_at: String,
    id: String,
    status: crate::pr_review::CommentStatus,
) -> Result<crate::pr_review::AiReview, String> {
    use crate::pr_review::CommentStatus;
    if status == CommentStatus::Kept {
        return Err("A comment is kept with ai_review_keep_comment.".into());
    }
    let dir = storage::data_dir(&app)?;
    let mut review = shown_ai_review(&dir, &repo, number, &source, &created_at)?;
    let comment = review
        .comments
        .iter_mut()
        .find(|comment| comment.id == id)
        .ok_or("This comment is gone — the agent may have replaced its review.")?;
    if comment.status == CommentStatus::Kept {
        return Err("This comment is yours now: delete it from your comments instead.".into());
    }
    comment.status = status;
    storage::save_ai_review(&dir, &review)?;
    Ok(review)
}

/// Makes an AI comment the user's, reworded when `body` is given: it moves to
/// their comments, where a new proposal from the agent no longer touches it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ai_review_keep_comment(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    source: String,
    created_at: String,
    id: String,
    body: Option<String>,
    diff_hunk: Option<String>,
) -> Result<crate::pr_review::CommentChange, String> {
    let dir = storage::data_dir(&app)?;
    let mut review = shown_ai_review(&dir, &repo, number, &source, &created_at)?;
    let now = chrono::Utc::now().to_rfc3339();
    // The user's copy first: should the second write fail, the comment shows
    // twice rather than not at all.
    let mine = storage::update_user_review(&dir, &repo, number, |mine| {
        crate::pr_review::keep_comment(&mut review, &id, body.as_deref(), diff_hunk.as_deref(), mine, &now)
    })?;
    storage::save_ai_review(&dir, &review)?;
    Ok(crate::pr_review::CommentChange { mine, review: Some(review) })
}

/// Drops a whole proposal — the one the user saw: a newer one from the same
/// agent stays. Comments the user kept from it are theirs and stay too.
#[tauri::command]
pub async fn ai_review_discard(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    source: String,
    created_at: String,
) -> Result<(), String> {
    let dir = storage::data_dir(&app)?;
    if shown_ai_review(&dir, &repo, number, &source, &created_at).is_err() {
        return Ok(());
    }
    storage::delete_ai_review(&dir, &repo, number, &source)
}

// ── The user's own PR comments ────────────────────────────────────────────────

#[tauri::command]
pub async fn pr_comments_get(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
) -> Result<crate::pr_review::UserReview, String> {
    storage::load_user_review(&storage::data_dir(&app)?, &repo, number)
}

/// A comment on lines the user selected in the diff. Stays on this machine.
#[tauri::command]
pub async fn pr_comment_add(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    comment: crate::pr_review::NewComment,
) -> Result<crate::pr_review::UserReview, String> {
    let dir = storage::data_dir(&app)?;
    let now = chrono::Utc::now().to_rfc3339();
    storage::update_user_review(&dir, &repo, number, |mine| mine.add(comment, &now))
}

#[tauri::command]
pub async fn pr_comment_update(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    id: String,
    body: String,
) -> Result<crate::pr_review::UserReview, String> {
    let dir = storage::data_dir(&app)?;
    storage::update_user_review(&dir, &repo, number, |mine| mine.edit(&id, &body))
}

/// A reply to one of GitHub's conversations that goes out with the review —
/// new when `id` is None, reworded otherwise.
#[tauri::command]
pub async fn pr_reply_save(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    id: Option<String>,
    thread_id: String,
    body: String,
) -> Result<crate::pr_review::UserReview, String> {
    let dir = storage::data_dir(&app)?;
    let now = chrono::Utc::now().to_rfc3339();
    storage::update_user_review(&dir, &repo, number, |mine| match id {
        Some(id) => mine.edit_reply(&id, &body),
        None => mine.add_reply(&thread_id, &body, &now),
    })
}

#[tauri::command]
pub async fn pr_reply_delete(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    id: String,
) -> Result<crate::pr_review::UserReview, String> {
    let dir = storage::data_dir(&app)?;
    storage::update_user_review(&dir, &repo, number, |mine| {
        mine.remove_reply(&id);
        Ok(())
    })
}

/// Replies to a conversation on GitHub at once, as GitHub's "Add single comment".
#[tauri::command]
pub async fn pr_thread_reply_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    thread_id: String,
    body: String,
) -> Result<(), String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("The reply is empty.".into());
    }
    let settings = storage::load_settings(&app).await?;
    crate::github::add_thread_reply(&thread_id, body, None, &settings, &state.http_client).await
}

/// Resolves a conversation on GitHub, or opens it again; returns whether it is resolved now.
#[tauri::command]
pub async fn pr_thread_resolve(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    thread_id: String,
    resolved: bool,
) -> Result<bool, String> {
    if thread_id.trim().is_empty() {
        return Err("This conversation is not known to ZuGit.".into());
    }
    let settings = storage::load_settings(&app).await?;
    crate::github::set_thread_resolved(thread_id.trim(), resolved, &settings, &state.http_client).await
}

/// The text heading the user's review, kept until it is published.
#[tauri::command]
pub async fn pr_review_set_summary(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    summary: String,
) -> Result<crate::pr_review::UserReview, String> {
    let dir = storage::data_dir(&app)?;
    storage::update_user_review(&dir, &repo, number, |mine| mine.set_summary(&summary))
}

/// Clears a PR from the publishing set however the publish ends.
struct Publishing<'a> {
    set: &'a parking_lot::Mutex<std::collections::HashSet<String>>,
    key: String,
}

impl Drop for Publishing<'_> {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
    }
}

/// Publishes the user's comments as a GitHub review. The main review — on
/// the latest commit, with the verdict and the summary — goes first: if GitHub
/// refuses it, nothing is sent and nothing changes here. Comments on code that
/// changed since follow, on the commits they were written on. What GitHub
/// accepted leaves ZuGit: it comes back as GitHub's own conversations.
/// `head_sha` is the commit the diff on screen is of: nothing goes out while
/// the PR has newer ones, or a verdict would land on code nobody here has seen.
#[tauri::command]
pub async fn pr_review_publish(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    repo: String,
    number: u64,
    event: crate::pr_review::ReviewEvent,
    head_sha: String,
) -> Result<crate::pr_review::PublishResult, String> {
    use crate::pr_review::{plan_review, DiffIndex, FailedReview, PublishResult, PublishedReview};
    if !crate::pr_review::valid_repo(&repo) {
        return Err(format!("Invalid repo '{repo}', expected owner/name."));
    }
    let key = format!("{repo}#{number}");
    // One publish per PR at a time: a double click must not post twice.
    if !state.publishing.lock().insert(key.clone()) {
        return Err("This review is being published already.".into());
    }
    let _publishing = Publishing { set: &state.publishing, key };

    let dir = storage::data_dir(&app)?;
    let settings = storage::load_settings(&app).await?;
    let mine = storage::load_user_review(&dir, &repo, number)?;
    let diff = current_diff(&state, &settings, &repo, number).await?;
    if !crate::pr_review::same_commit(&head_sha, &diff.head_sha) {
        return Err("New commits on this PR since you opened the diff: reload it and look at them, then publish.".into());
    }
    let carried = carry_all(&state, &settings, &repo, &mine, &diff).await;
    let client = &state.http_client;
    let mut result = PublishResult::default();

    // A reply to a conversation deleted on GitHub would sink the whole review:
    // it stays here, said so. When GitHub cannot be asked, all of them go.
    let mut planned = mine.clone();
    if !mine.replies.is_empty() {
        if let Ok(threads) = crate::github::fetch_review_threads(&repo, number, &settings, client).await {
            let live: std::collections::HashSet<&str> = threads.iter().map(|t| t.id.as_str()).collect();
            planned.replies.retain(|r| live.contains(r.thread_id.as_str()));
            let gone = mine.replies.len() - planned.replies.len();
            if gone > 0 {
                result.failed.push(FailedReview {
                    commit: diff.head_sha.clone(),
                    error: "The conversation was deleted on GitHub.".into(),
                    comments: gone,
                });
            }
        }
    }
    let plan = plan_review(&planned, &diff.head_sha, event, &DiffIndex::new(&diff.files), &carried)?;
    // GitHub has them: losing track of that here would publish them twice. The
    // file is read again, not written from the copy above: what was added or
    // kept while the review went out stays.
    let forget = |ids: &[String], summary_too: bool| {
        storage::update_user_review(&dir, &repo, number, |now| {
            now.published(ids, &planned, summary_too);
            Ok(())
        })
        .map_err(|e| {
            format!("Published on GitHub, but ZuGit could not update its copy ({e}): delete the published comments here before publishing again.")
        })
    };

    if let Some(main) = &plan.main {
        let url = crate::github::create_review(&repo, number, main, &settings, client).await?;
        forget(&main.ids, true)?;
        result.published.push(PublishedReview { commit: main.commit.clone(), url, comments: main.ids.len() });
    }
    for older in &plan.older {
        match crate::github::create_review(&repo, number, older, &settings, client).await {
            Ok(url) => {
                forget(&older.ids, false)?;
                result.published.push(PublishedReview { commit: older.commit.clone(), url, comments: older.ids.len() });
            }
            Err(error) => {
                result.failed.push(FailedReview { commit: older.commit.clone(), error, comments: older.ids.len() });
            }
        }
    }
    result.mine = storage::load_user_review(&dir, &repo, number).unwrap_or(mine);
    Ok(result)
}

/// Deletes one of the user's comments. One kept from an AI review goes back
/// to that proposal as discarded, where Undo can still bring it back.
#[tauri::command]
pub async fn pr_comment_delete(
    app: tauri::AppHandle,
    repo: String,
    number: u64,
    id: String,
) -> Result<crate::pr_review::CommentChange, String> {
    let dir = storage::data_dir(&app)?;
    let mut removed = None;
    let mine = storage::update_user_review(&dir, &repo, number, |mine| {
        removed = mine.remove(&id);
        Ok(())
    })?;
    let Some(removed) = removed else {
        return Ok(crate::pr_review::CommentChange { mine, review: None });
    };
    let mut released = None;
    if let Some(from) = &removed.kept_from {
        if let Ok(mut review) = shown_ai_review(&dir, &repo, number, &from.source, &from.created_at) {
            if crate::pr_review::release_kept(&mut review, from) {
                storage::save_ai_review(&dir, &review)?;
                released = Some(review);
            }
        }
    }
    Ok(crate::pr_review::CommentChange { mine, review: released })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSetupInfo {
    /// Absolute path of the running ZuGit executable — the MCP server command.
    pub executable: String,
}

#[tauri::command]
pub async fn mcp_setup_info() -> Result<McpSetupInfo, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(McpSetupInfo {
        executable: executable.to_string_lossy().to_string(),
    })
}

/// Whether Claude Code, Codex and Claude Desktop are set up to run this
/// executable as their ZuGit MCP server. Reads their configs, never writes them.
#[tauri::command]
pub async fn mcp_setup_status() -> Result<Vec<crate::mcp_setup::McpClientStatus>, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || crate::mcp_setup::statuses(&executable))
        .await
        .map_err(|e| e.to_string())
}

// ── Release notes overrides ───────────────────────────────────────────────────

/// Manual include/exclude decisions for one release's notes, keyed by Jira key.
#[tauri::command]
pub async fn fetch_release_note_overrides(
    app: tauri::AppHandle,
    release_name: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(storage::load_release_note_overrides(&app, &release_name))
}

/// `mode` is "include", "exclude", or `None` to go back to the automatic rule.
#[tauri::command]
pub async fn set_release_note_override(
    app: tauri::AppHandle,
    release_name: String,
    issue_key: String,
    mode: Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mode = match mode.as_deref() {
        Some("include") => Some("include".to_string()),
        Some("exclude") => Some("exclude".to_string()),
        Some(other) => return Err(format!("Unknown release note override '{other}'")),
        None => None,
    };
    storage::set_release_note_override(&app, &release_name, &issue_key, mode)
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
