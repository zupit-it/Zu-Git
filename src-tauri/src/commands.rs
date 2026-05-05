use crate::models::{
    DashboardBootstrap, DashboardSnapshot, ListFilterPreferences, SaveSettingsResult,
    SettingsFormValues, serialize_settings_form,
};
use crate::{dashboard, secret_store, storage, AppState};

// ── Bootstrap ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn bootstrap(
    app: tauri::AppHandle,
    _state: tauri::State<'_, AppState>,
) -> Result<DashboardBootstrap, String> {
    let settings = storage::load_settings(&app).await?;
    let list_filters = storage::load_list_filter_preferences(&app).await?;
    let secret_store = secret_store::get_secret_store_info();

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
    let settings = storage::save_settings(&app, &params).await?;

    // Clear caches after settings change.
    state.pr_cache.lock().unwrap().clear();
    state.jira_cache.lock().unwrap().clear();

    let snap = dashboard::build_dashboard_snapshot(
        &settings,
        &state.pr_cache,
        &state.jira_cache,
        &state.http_client,
    )
    .await;

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
    Ok(dashboard::build_dashboard_snapshot(
        &settings,
        &state.pr_cache,
        &state.jira_cache,
        &state.http_client,
    )
    .await)
}

// ── Open external URL ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_external(
    app: tauri::AppHandle,
    url: String,
) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())?;
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
