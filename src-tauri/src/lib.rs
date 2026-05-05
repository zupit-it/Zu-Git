mod commands;
mod dashboard;
mod github;
mod jira;
mod models;
mod secret_store;
mod storage;

use std::collections::HashMap;
use std::sync::Mutex;

use github::CachedPrDetails;
use jira::JiraIssueSummary;

pub struct AppState {
    pub pr_cache: Mutex<HashMap<String, CachedPrDetails>>,
    pub jira_cache: Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    pub http_client: reqwest::Client,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
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
            Ok(())
        })
        .manage(AppState {
            pr_cache: Mutex::new(HashMap::new()),
            jira_cache: Mutex::new(HashMap::new()),
            http_client: reqwest::Client::new(),
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::save_settings,
            commands::refresh_dashboard,
            commands::open_external,
            commands::show_native_notification,
            commands::save_list_filters,
            commands::request_review,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
