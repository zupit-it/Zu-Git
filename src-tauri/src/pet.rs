//! Tiny King: a small window at the right edge of the screen where he walks in,
//! plays an animation about the user's PRs with a speech bubble saying what it
//! is about, and walks out (meme mode). Transparent, always on top and never
//! focused: it shows up over whatever the user is doing, then the page asks for
//! it to be closed. Click-through but for him and his bubble, a click on which
//! brings ZuGit up on the PR he is talking about.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "pet";
const ANIMATIONS: [&str; 4] = ["idle", "pr_merged", "ci_failed", "review_wait"];
/// Logical size of the king, whose sprite cell is 3:4, at the window's bottom right.
const KING_HEIGHT: f64 = 184.0;
/// The window is wider and taller than him, for the bubble above-left of his head.
const WIDTH: f64 = 300.0;
/// Room above him for the bubble at its tallest (two lines of title, two of
/// detail, a note that wraps) and the buttons sticking out over its top edge.
const BUBBLE_HEIGHT: f64 = 140.0;
const HEIGHT: f64 = KING_HEIGHT + BUBBLE_HEIGHT;
/// Where the king's centre sits, as a share of the screen's height from the top.
const CENTRE: f64 = 0.72;
/// A bubble is a line or two, not a page.
const MAX_TEXT: usize = 140;
/// Pages in one bubble, at most (MAX_PAGES in pet-lines.ts).
const MAX_PAGES: usize = 4;
/// Appearances asked for at once, at most: one per kind of news.
const MAX_PLAYS: usize = 4;

/// One appearance, as the page plays it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPlay {
    animation: String,
    /// What his bubble says, a page at a time.
    #[serde(default)]
    pages: Vec<PetPage>,
    /// Times the animation plays in a row.
    cycles: u32,
    /// How long he stays, idle, before walking off.
    linger_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetPage {
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// The PR the page is about, opened by a click.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pr: Option<PetPr>,
    /// A review to do: the bubble offers the PR's diff too.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    diff: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PetPr {
    repo: String,
    id: u64,
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(MAX_TEXT) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

/// Shows the king for `plays`, one after the other, opening his window if it is
/// not up yet. All at once rather than a call each: a second call while the
/// window is still opening would find its page not listening yet.
/// Async: creating a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn pet_play(app: AppHandle, mut plays: Vec<PetPlay>) -> Result<(), String> {
    if let Some(play) = plays.iter().find(|p| !ANIMATIONS.contains(&p.animation.as_str())) {
        return Err(format!("Unknown animation '{}'.", play.animation));
    }
    plays.truncate(MAX_PLAYS);
    for play in &mut plays {
        play.cycles = play.cycles.clamp(1, 5);
        play.linger_ms = play.linger_ms.min(30_000);
        play.pages.truncate(MAX_PAGES);
        for page in &mut play.pages {
            page.title = clip(&page.title);
            page.detail = page.detail.as_deref().map(clip);
            page.note = page.note.as_deref().map(clip);
        }
    }
    if plays.is_empty() {
        return Ok(());
    }
    if app.get_webview_window(LABEL).is_some() {
        // Already on screen: the page plays them after the current one.
        return app.emit_to(LABEL, "pet-play", &plays).map_err(|e| e.to_string());
    }

    // The screen ZuGit is on, minus the menu bar, Dock or taskbar.
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No screen to show the king on.")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let right = area.position.x as f64 + area.size.width as f64;
    let bottom = area.position.y as f64 + area.size.height as f64;
    // Flush with the screen's edge: he walks in from beyond it, and out again.
    let x = right - WIDTH * scale;
    let king_top = area.position.y as f64 + area.size.height as f64 * CENTRE - KING_HEIGHT * scale / 2.0;
    let y = (king_top - BUBBLE_HEIGHT * scale).min(bottom - HEIGHT * scale);

    // The page reads what to play, and who plays it, before its scripts run:
    // nothing is missed while it loads.
    let first = serde_json::to_string(&plays).map_err(|e| e.to_string())?;
    let pack = match crate::pet_pack::custom_pack(&app) {
        Some((manifest, dir)) => serde_json::json!({ "manifest": manifest, "dir": dir }),
        None => serde_json::Value::Null,
    };
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("Tiny King")
        .initialization_script(format!("window.__PET_PLAY = {first}; window.__PET_PACK = {pack};"))
        .inner_size(WIDTH, HEIGHT)
        .position(x / scale, y / scale)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        // A click on him counts, though his window is never the active one.
        .accept_first_mouse(true)
        .build()
        .map_err(|e| e.to_string())?;
    // The logical position above is only exact on a screen with the main one's
    // scale: place it in the screen's own pixels now that it exists.
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = window.set_size(LogicalSize::new(WIDTH, HEIGHT));
    // Clicks go to whatever is under him, until the page says the cursor is on
    // him or his bubble (pet_clickable).
    let _ = window.set_ignore_cursor_events(true);
    Ok(())
}

/// Where the cursor is in the king's window, in CSS px; outside it or unknown,
/// none. The page asks over and over: a window letting clicks through gets no
/// mouse events to tell it.
#[tauri::command]
pub fn pet_cursor(window: WebviewWindow) -> Option<(f64, f64)> {
    let cursor = window.cursor_position().ok()?;
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().ok()?;
    let (x, y) = ((cursor.x - origin.x as f64) / scale, (cursor.y - origin.y as f64) / scale);
    ((0.0..=WIDTH).contains(&x) && (0.0..=HEIGHT).contains(&y)).then_some((x, y))
}

/// Takes clicks while the cursor is on him or his bubble, lets them through
/// everywhere else.
#[tauri::command]
pub fn pet_clickable(window: WebviewWindow, on: bool) {
    let _ = window.set_ignore_cursor_events(!on);
}

/// He was clicked: ZuGit comes up on `pr`, its row or with `diff` its diff, or
/// just comes up for a page about no PR in particular.
#[tauri::command]
pub fn pet_open(app: AppHandle, pr: Option<PetPr>, diff: bool) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("ZuGit's window is gone.")?;
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    let open = serde_json::json!({ "pr": pr, "diff": diff });
    app.emit_to("main", "pet-open", open).map_err(|e| e.to_string())
}

/// The page is done: the king leaves.
#[tauri::command]
pub fn pet_done(app: AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::clip;

    #[test]
    fn clip_keeps_short_text_and_cuts_long_text_on_a_char() {
        assert_eq!(clip("PR mergiata"), "PR mergiata");
        let long = "è".repeat(200);
        let cut = clip(&long);
        assert_eq!(cut.chars().count(), 141);
        assert!(cut.ends_with('…'));
    }
}
