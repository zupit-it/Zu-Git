//! Silent mode (Settings → Silent mode): between two times of day nothing
//! ZuGit does on its own interrupts. The page decides most of it
//! (`silent-mode.ts`, which this file must agree with); what is sent from here,
//! the system notifications, asks here too, so none gets through whoever asks.

use chrono::Timelike;
use serde::Deserialize;

/// The three settings, read straight from the settings file: asking for all of
/// them would read every token from the keychain for each notification.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SilentWindow {
    #[serde(default)]
    silent_mode_enabled: bool,
    #[serde(default)]
    silent_mode_from: String,
    #[serde(default)]
    silent_mode_to: String,
}

/// "HH:MM" → minutes from midnight; anything else, none.
fn minutes_of(clock: &str) -> Option<u32> {
    crate::toggl_day::parse_hhmm(clock).filter(|minutes| *minutes < 24 * 60)
}

/// Whether `minute` of the day falls in the window. `from` is in, `to` is out;
/// `from` after `to` crosses midnight; the same time twice is the whole day; a
/// time that cannot be read silences nothing.
fn is_silent_at(enabled: bool, from: &str, to: &str, minute: u32) -> bool {
    if !enabled {
        return false;
    }
    let (Some(from), Some(to)) = (minutes_of(from), minutes_of(to)) else { return false };
    if from < to {
        minute >= from && minute < to
    } else {
        minute >= from || minute < to
    }
}

/// Whether silent mode is on right now, by the saved settings and the local clock.
pub fn now(app: &tauri::AppHandle) -> bool {
    let Ok(dir) = crate::storage::data_dir(app) else { return false };
    let window: SilentWindow = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();
    let clock = chrono::Local::now();
    is_silent_at(
        window.silent_mode_enabled,
        &window.silent_mode_from,
        &window.silent_mode_to,
        clock.hour() * 60 + clock.minute(),
    )
}

#[cfg(test)]
mod tests {
    use super::is_silent_at;

    const fn at(hour: u32, minute: u32) -> u32 {
        hour * 60 + minute
    }

    #[test]
    fn a_window_crossing_midnight_runs_until_its_end_the_next_day() {
        let silent = |minute| is_silent_at(true, "14:00", "08:00", minute);
        assert!(!silent(at(13, 59)));
        assert!(silent(at(14, 0)), "the start is in");
        assert!(silent(at(23, 59)));
        assert!(silent(at(0, 0)));
        assert!(silent(at(7, 59)));
        assert!(!silent(at(8, 0)), "the end is out");
        assert!(!silent(at(10, 0)));
    }

    #[test]
    fn a_same_day_window_is_silent_only_between_its_two_times() {
        let silent = |minute| is_silent_at(true, "12:30", "14:00", minute);
        assert!(!silent(at(12, 29)));
        assert!(silent(at(12, 30)));
        assert!(silent(at(13, 59)));
        assert!(!silent(at(14, 0)));
        assert!(!silent(at(3, 0)));
    }

    #[test]
    fn switched_off_nothing_is_silent() {
        assert!(!is_silent_at(false, "14:00", "08:00", at(20, 0)));
        assert!(!is_silent_at(false, "09:00", "09:00", at(9, 0)));
    }

    #[test]
    fn the_same_time_twice_is_the_whole_day() {
        for minute in [at(0, 0), at(8, 59), at(9, 0), at(9, 1), at(23, 59)] {
            assert!(is_silent_at(true, "09:00", "09:00", minute));
        }
    }

    #[test]
    fn a_time_that_cannot_be_read_silences_nothing() {
        assert!(!is_silent_at(true, "", "08:00", at(3, 0)));
        assert!(!is_silent_at(true, "24:00", "08:00", at(3, 0)));
    }
}
