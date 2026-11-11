//! `zugit://` links: a PR's diff opened from outside ZuGit — a Slack nudge,
//! a note, a chat.
//!
//! `zugit://pr/<owner>/<repo>/<number>`. Anyone can write such a link, so it
//! is read strictly and only ever *opens*: the PR's diff when the PR is in the
//! list, its page on GitHub otherwise. Nothing on the PR is ever acted upon.
//!
//! The OS hands the link over (macOS to the running app, Windows and Linux to
//! a second process that single-instance forwards); it waits here until the
//! window, its PR list loaded, takes it.

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const SCHEME: &str = "zugit";
/// Tells the window a link is waiting.
pub const EVENT: &str = "zugit-link";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrLink {
    pub repo: String,
    pub number: u64,
}

/// The last link received, until the window takes it.
#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<PrLink>>);

/// The link to a PR's diff in ZuGit, as `zugitPrLink` in `slack-people.ts`
/// writes it: the tests check that what is written reads back.
#[cfg(test)]
fn pr_link(repo: &str, number: u64) -> String {
    format!("{SCHEME}://pr/{repo}/{number}")
}

/// `zugit://pr/owner/name/123`, and nothing else: a trailing slash is let
/// through, a query or fragment ignored, any other shape refused.
pub fn parse(url: &url::Url) -> Option<PrLink> {
    if url.scheme() != SCHEME || !url.host_str().is_some_and(|host| host.eq_ignore_ascii_case("pr")) {
        return None;
    }
    let parts: Vec<&str> = url.path().trim_matches('/').split('/').collect();
    let [owner, name, number] = parts.as_slice() else { return None };
    let repo = format!("{owner}/{name}");
    if !crate::pr_review::valid_repo(&repo) {
        return None;
    }
    let number = number.parse::<u64>().ok().filter(|n| *n > 0)?;
    Some(PrLink { repo, number })
}

/// Brings the main window up: a link was clicked, or ZuGit launched again.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn received<R: Runtime>(app: &AppHandle<R>, urls: Vec<url::Url>) {
    let Some(link) = urls.iter().find_map(parse) else {
        if !urls.is_empty() {
            eprintln!("[zugit] ignored a link that is not zugit://pr/<owner>/<repo>/<number>");
        }
        return;
    };
    *app.state::<PendingLink>().0.lock() = Some(link);
    focus_main(app);
    let _ = app.emit(EVENT, ());
}

/// Listens for links from now on, and takes the one ZuGit was launched with.
pub fn listen<R: Runtime>(app: &tauri::App<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Installers register the scheme; a dev build on Windows or Linux does it itself.
    #[cfg(all(debug_assertions, any(target_os = "windows", target_os = "linux")))]
    if let Err(error) = app.deep_link().register_all() {
        eprintln!("[zugit] could not register zugit:// links: {error}");
    }

    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| received(&handle, event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        received(app.handle(), urls);
    }
}

/// The waiting link, once: the window calls it on the event and on start.
#[tauri::command]
pub fn deep_link_take(state: tauri::State<'_, PendingLink>) -> Option<PrLink> {
    state.0.lock().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(text: &str) -> Option<PrLink> {
        parse(&text.parse::<url::Url>().unwrap())
    }

    #[test]
    fn a_pr_link_reads_back_as_written() {
        let written = pr_link("zupit-it/Zu-Git", 123);
        assert_eq!(written, "zugit://pr/zupit-it/Zu-Git/123");
        assert_eq!(link(&written), Some(PrLink { repo: "zupit-it/Zu-Git".into(), number: 123 }));
        assert_eq!(link("zugit://pr/org/app.web/7/").unwrap().repo, "org/app.web");
        assert_eq!(link("zugit://PR/org/app/7?from=slack#x").unwrap().number, 7);
    }

    #[test]
    fn anything_else_is_refused() {
        for text in [
            "https://pr/org/app/7",
            "zugit://open/org/app/7",
            "zugit://pr/org/app",
            "zugit://pr/org/app/7/files",
            "zugit://pr/org/app/0",
            "zugit://pr/org/app/-1",
            "zugit://pr/org/app/seven",
            "zugit://pr/../app/7",
            "zugit://pr/org/a%2Fb/7",
            "zugit://pr/org/app;rm/7",
        ] {
            assert_eq!(link(text), None, "{text}");
        }
    }
}
