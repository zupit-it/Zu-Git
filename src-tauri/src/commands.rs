use crate::models::{
    serialize_settings_form, AppSettings, DashboardBootstrap, DashboardSnapshot,
    ListFilterPreferences, SaveSettingsResult, SettingsFormValues, TokenStoreStatus,
};
use crate::{dashboard, secret_store, storage, AppState};

fn build_token_store_status(
    settings: &AppSettings,
    state: &tauri::State<'_, AppState>,
) -> TokenStoreStatus {
    let info = state
        .secret_store_info
        .get_or_init(|| secret_store::get_secret_store_info());
    let last_save_used_vault = *state.last_save_used_vault.lock().unwrap();
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
        .get_or_init(|| secret_store::get_secret_store_info());
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
    *state.last_save_used_vault.lock().unwrap() = Some(used_vault);

    // Clear caches after settings change.
    state.pr_cache.lock().unwrap().clear();
    state.jira_cache.lock().unwrap().clear();

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
