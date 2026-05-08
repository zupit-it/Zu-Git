use crate::models::{
    serialize_settings_form, AppSettings, DashboardBootstrap, DashboardSnapshot,
    DraftPrInfo, ListFilterPreferences, SaveSettingsResult, SettingsFormValues, TokenStoreStatus,
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
    state.pr_cache.lock().clear();
    state.jira_cache.lock().clear();

    let mut snap = dashboard::build_dashboard_snapshot(
        &settings,
        &state.pr_cache,
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
        &state.pr_cache,
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
) -> Result<Option<DraftPrInfo>, String> {
    let settings = storage::load_settings(&app).await?;
    if !crate::models::settings_ready_for_github(&settings) {
        return Ok(None);
    }
    let viewer_login = crate::github::fetch_viewer_login(&settings, &state.http_client)
        .await
        .unwrap_or_default();
    if viewer_login.is_empty() {
        return Ok(None);
    }
    Ok(crate::github::find_viewer_branch(
        &settings.github_repos,
        &viewer_login,
        &settings,
        &state.http_client,
    )
    .await)
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
