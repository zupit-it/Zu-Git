//! How much of GitHub's hourly limits the token has used. GitHub says it in the
//! headers of every answer, so nothing is asked for it: each answer is read on
//! its way (`note`), and the window is told when a number changed (`EVENT`).
//! Settings → GitHub can show it in the top bar.
//!
//! Two limits matter to ZuGit, each with its own hour: GraphQL, counted in
//! points (the PR list, a PR read on its own, auto-merge, rebase), and REST,
//! counted in requests (diffs, files, reviews, reviewer requests).

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::Mutex;
use reqwest::header::HeaderMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Sent to the window with the new `GithubQuota` whenever it changes.
pub const EVENT: &str = "github-quota";

/// One of GitHub's hourly limits, as its last answer gave it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub limit: u32,
    pub used: u32,
    /// When the hour ends and `used` goes back to zero, in seconds since the epoch.
    pub reset_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct GithubQuota {
    pub graphql: Option<Bucket>,
    pub rest: Option<Bucket>,
}

static QUOTA: Lazy<Mutex<GithubQuota>> = Lazy::new(|| Mutex::new(GithubQuota::default()));
static APP: OnceCell<AppHandle> = OnceCell::new();

/// The window to tell. Without one (`zugit --mcp`) the numbers are kept and nobody is told.
pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

pub fn current() -> GithubQuota {
    *QUOTA.lock()
}

/// Another token may be in use from now on: its limits are its own.
pub fn forget() {
    let changed = std::mem::take(&mut *QUOTA.lock()) != GithubQuota::default();
    if changed {
        tell();
    }
}

/// Reads the limit out of the headers of an answer from GitHub.
pub fn note(headers: &HeaderMap) {
    let Some((resource, bucket)) = bucket_in(headers) else { return };
    let changed = {
        let mut quota = QUOTA.lock();
        let slot = match resource.as_str() {
            "graphql" => &mut quota.graphql,
            "core" => &mut quota.rest,
            // Search, code scanning…: limits of their own, which ZuGit does not come near.
            _ => return,
        };
        let next = latest(*slot, bucket);
        let changed = *slot != Some(next);
        *slot = Some(next);
        changed
    };
    if changed {
        tell();
    }
}

fn tell() {
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, current());
    }
}

/// Answers land in any order: within one hour the higher count is the later one.
fn latest(known: Option<Bucket>, seen: Bucket) -> Bucket {
    match known {
        Some(known) if known.reset_at == seen.reset_at && known.limit == seen.limit && known.used > seen.used => known,
        // An hour that ended is not the news: an answer sent before it did, landing late.
        Some(known) if known.limit == seen.limit && known.reset_at > seen.reset_at => known,
        _ => seen,
    }
}

/// The limit an answer's headers tell of, and which one: `core` (REST) or `graphql`.
fn bucket_in(headers: &HeaderMap) -> Option<(String, Bucket)> {
    let text = |name: &str| headers.get(name)?.to_str().ok().map(str::trim);
    let resource = text("x-ratelimit-resource")?.to_ascii_lowercase();
    let limit: u32 = text("x-ratelimit-limit")?.parse().ok()?;
    let reset_at: i64 = text("x-ratelimit-reset")?.parse().ok()?;
    // Older GitHub Enterprise Servers say only what is left.
    let used = match text("x-ratelimit-used").and_then(|v| v.parse::<u32>().ok()) {
        Some(used) => used,
        None => limit.saturating_sub(text("x-ratelimit-remaining")?.parse().ok()?),
    };
    Some((resource, Bucket { limit, used, reset_at }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().unwrap());
        }
        map
    }

    fn graphql(used: &str, reset: &str) -> HeaderMap {
        headers(&[
            ("x-ratelimit-resource", "graphql"),
            ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-used", used),
            ("x-ratelimit-remaining", "0"),
            ("x-ratelimit-reset", reset),
        ])
    }

    #[test]
    fn the_limit_is_read_from_an_answers_headers() {
        let (resource, bucket) = bucket_in(&graphql("52", "1794300000")).unwrap();
        assert_eq!(resource, "graphql");
        assert_eq!(bucket, Bucket { limit: 5000, used: 52, reset_at: 1_794_300_000 });

        // REST calls its limit "core".
        let rest = headers(&[
            ("x-ratelimit-resource", "core"),
            ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-used", "7"),
            ("x-ratelimit-reset", "1794300600"),
        ]);
        assert_eq!(bucket_in(&rest).unwrap().0, "core");
    }

    #[test]
    fn what_is_left_tells_what_is_used_when_the_server_does_not() {
        let old = headers(&[
            ("x-ratelimit-resource", "core"),
            ("x-ratelimit-limit", "5000"),
            ("x-ratelimit-remaining", "4990"),
            ("x-ratelimit-reset", "1794300000"),
        ]);
        assert_eq!(bucket_in(&old).unwrap().1.used, 10);
    }

    #[test]
    fn an_answer_without_the_headers_says_nothing() {
        assert!(bucket_in(&HeaderMap::new()).is_none());
        assert!(bucket_in(&headers(&[("x-ratelimit-resource", "graphql"), ("x-ratelimit-limit", "many")])).is_none());
    }

    #[test]
    fn answers_landing_out_of_order_do_not_take_the_count_back() {
        let at = |used, reset_at| Bucket { limit: 5000, used, reset_at };
        // Two answers of the same hour, the earlier one landing last.
        assert_eq!(latest(Some(at(60, 100)), at(55, 100)), at(60, 100));
        assert_eq!(latest(Some(at(55, 100)), at(60, 100)), at(60, 100));
        // A new hour starts the count again…
        assert_eq!(latest(Some(at(4800, 100)), at(3, 3700)), at(3, 3700));
        // …and a straggler from the hour before does not bring the old one back.
        assert_eq!(latest(Some(at(3, 3700)), at(4801, 100)), at(3, 3700));
        // Another token, with another limit, is simply what GitHub says now.
        assert_eq!(latest(Some(at(60, 100)), Bucket { limit: 15_000, used: 2, reset_at: 90 }), Bucket { limit: 15_000, used: 2, reset_at: 90 });
        assert_eq!(latest(None, at(1, 100)), at(1, 100));
    }
}
