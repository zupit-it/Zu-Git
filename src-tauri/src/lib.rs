mod commands;
mod dashboard;
mod github;
mod jira;
mod models;
mod secret_store;
mod storage;

use std::collections::HashMap;
use parking_lot::Mutex;

use github::CachedPrDetails;
use jira::JiraIssueSummary;

pub struct AppState {
    pub pr_cache: Mutex<HashMap<String, CachedPrDetails>>,
    pub jira_cache: Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    pub http_client: reqwest::Client,
    /// Probe result cached after the first call — avoids re-running the probe on every refresh.
    pub secret_store_info: std::sync::OnceLock<models::SecretStoreInfo>,
    /// Whether the last `save_settings` successfully stored tokens in the system vault.
    /// None = settings never saved in this session.
    pub last_save_used_vault: Mutex<Option<bool>>,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // On macOS the menu bar lives at the top of the screen (system-wide),
            // so we keep it. On Windows/Linux it would render as an in-window bar,
            // which we don't want.
            #[cfg(not(target_os = "macos"))]
            let _ = &app;
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem, Submenu};

                let menu = Menu::with_items(
                    app,
                    &[
                        &Submenu::with_items(
                            app,
                            "ZuGit",
                            true,
                            &[&PredefinedMenuItem::quit(app, None)?],
                        )?,
                        &Submenu::with_items(
                            app,
                            "Edit",
                            true,
                            &[
                                &PredefinedMenuItem::undo(app, None)?,
                                &PredefinedMenuItem::redo(app, None)?,
                                &PredefinedMenuItem::separator(app)?,
                                &PredefinedMenuItem::cut(app, None)?,
                                &PredefinedMenuItem::copy(app, None)?,
                                &PredefinedMenuItem::paste(app, None)?,
                                &PredefinedMenuItem::select_all(app, None)?,
                            ],
                        )?,
                    ],
                )?;
                app.set_menu(menu)?;
            }
            Ok(())
        })
        .manage(AppState {
            pr_cache: Mutex::new(HashMap::new()),
            jira_cache: Mutex::new(HashMap::new()),
            http_client: reqwest::Client::new(),
            secret_store_info: std::sync::OnceLock::new(),
            last_save_used_vault: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::save_settings,
            commands::refresh_dashboard,
            commands::open_external,
            commands::show_native_notification,
            commands::save_list_filters,
            commands::request_review,
            commands::check_for_update,
            commands::install_update,
            commands::get_draft_pr_info,
            commands::create_pull_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
