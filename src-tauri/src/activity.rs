//! Local evidence of what the user actually worked on during a day.
//!
//! Jira statuses say what a story is *supposed* to be in; they lag behind
//! reality all the time (the story left in To Do while being worked on, the
//! quick fix on a story already in merge request). The traces work leaves on
//! disk do not lag:
//!
//!   * commits in the local git repositories, authored by the user;
//!   * AI coding sessions — Claude Code (`~/.claude/projects/**.jsonl`) and
//!     Codex (`~/.codex/sessions/**.jsonl`) record a timestamp and the git
//!     branch for every exchange.
//!
//! Branches are named after the story (`PENT-5755/rass`), so both sources map
//! straight onto Jira keys. Everything is read locally; only the keys found
//! leave the machine, to be looked up on Jira.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One piece of evidence that a story was being worked on at a given moment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub key: String,
    /// RFC3339 (UTC).
    pub at: String,
    /// "ai-session" | "commit" | "jira"
    pub source: String,
    /// How the moment relates to the work around it:
    ///   * "during" — the work was happening right then (an AI exchange);
    ///   * "end"    — the work happened *before* it (a commit, a move to Developed);
    ///   * "start"  — the work happens *after* it (a move to In Progress).
    pub kind: String,
    /// Short human label: commit subject, target status, tool name.
    pub detail: String,
    /// How much this signal counts, 1 by default. Lower for moves made in bulk:
    /// five stories dragged to Developed in the same minute is board tidying,
    /// not five pieces of work.
    pub weight: f64,
}

/// AI exchanges are collapsed into buckets of this size: one hundred messages in
/// five minutes are one piece of evidence, not one hundred.
const SESSION_BUCKET_SECS: i64 = 300;

/// How far back AI sessions are scanned to discover which repositories exist.
const REPO_DISCOVERY_DAYS: u64 = 45;

/// Jira keys in a branch name. Branches are often lower-case (`pent-12-fix`),
/// so the name is upper-cased first; the caller validates keys against Jira.
pub fn keys_in_branch(branch: &str) -> Vec<String> {
    crate::jira::extract_all_jira_keys(&branch.to_uppercase())
}

fn parse_utc(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn modified_since(path: &Path, since: SystemTime) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(|modified| modified >= since)
        .unwrap_or(false)
}

/// Every `.jsonl` file below `root`, at most `depth` directories deep.
fn jsonl_files(root: &Path, depth: usize, since: SystemTime) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                found.extend(jsonl_files(&path, depth - 1, since));
            }
        } else if path.extension().is_some_and(|ext| ext == "jsonl") && modified_since(&path, since) {
            found.push(path);
        }
    }
    found
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn claude_projects_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".claude")))
        .map(|dir| dir.join("projects"))
}

fn codex_sessions_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".codex")))
        .map(|dir| dir.join("sessions"))
}

/// Collapses raw (key, instant) sightings into one "during" event per bucket.
#[derive(Default)]
struct SessionBuckets {
    seen: BTreeSet<(String, i64)>,
    detail: HashMap<(String, i64), String>,
}

impl SessionBuckets {
    fn add(&mut self, key: &str, at: DateTime<Utc>, tool: &str) {
        let bucket = at.timestamp().div_euclid(SESSION_BUCKET_SECS);
        let id = (key.to_string(), bucket);
        if self.seen.insert(id.clone()) {
            self.detail.insert(id, tool.to_string());
        }
    }

    fn into_events(self) -> Vec<ActivityEvent> {
        let mut detail = self.detail;
        self.seen
            .into_iter()
            .filter_map(|(key, bucket)| {
                let at = DateTime::<Utc>::from_timestamp(
                    bucket * SESSION_BUCKET_SECS + SESSION_BUCKET_SECS / 2,
                    0,
                )?;
                let tool = detail.remove(&(key.clone(), bucket)).unwrap_or_default();
                Some(ActivityEvent {
                    key,
                    at: at.to_rfc3339(),
                    source: "ai-session".to_string(),
                    kind: "during".to_string(),
                    detail: tool,
                    weight: 1.0,
                })
            })
            .collect()
    }
}

// ── Claude Code ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ClaudeLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "gitBranch")]
    git_branch: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

/// Feeds the user/assistant exchanges of one Claude Code transcript into the buckets.
fn scan_claude_transcript(
    reader: impl BufRead,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    buckets: &mut SessionBuckets,
) {
    for line in reader.lines().map_while(Result::ok) {
        // Cheap pre-filter: most lines are tool output without a branch.
        if !line.contains("\"gitBranch\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeLine>(&line) else {
            continue;
        };
        if !matches!(parsed.kind.as_deref(), Some("user") | Some("assistant")) {
            continue;
        }
        let (Some(timestamp), Some(branch)) = (parsed.timestamp, parsed.git_branch) else {
            continue;
        };
        let Some(at) = parse_utc(&timestamp) else { continue };
        if at < from || at >= to {
            continue;
        }
        for key in keys_in_branch(&branch) {
            buckets.add(&key, at, "Claude Code");
        }
    }
}

// ── Codex ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct CodexLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    git: Option<CodexGit>,
}

#[derive(Deserialize)]
struct CodexGit {
    #[serde(default)]
    branch: Option<String>,
}

/// A Codex rollout names its branch once, in the leading `session_meta` line;
/// every later line with a timestamp is an exchange on that branch.
fn scan_codex_rollout(
    reader: impl BufRead,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    buckets: &mut SessionBuckets,
) {
    let mut keys: Vec<String> = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(parsed) = serde_json::from_str::<CodexLine>(&line) else {
            continue;
        };
        if parsed.kind.as_deref() == Some("session_meta") {
            keys = parsed
                .payload
                .and_then(|payload| payload.git)
                .and_then(|git| git.branch)
                .map(|branch| keys_in_branch(&branch))
                .unwrap_or_default();
            continue;
        }
        if keys.is_empty() {
            continue;
        }
        let Some(at) = parsed.timestamp.as_deref().and_then(parse_utc) else {
            continue;
        };
        if at < from || at >= to {
            continue;
        }
        for key in &keys {
            buckets.add(key, at, "Codex");
        }
    }
}

/// AI-session evidence for `[from, to)`. Only transcripts written to since
/// `from` are opened — anything older cannot contain the day.
pub fn collect_ai_sessions(from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<ActivityEvent> {
    let since: SystemTime = from.into();
    let mut buckets = SessionBuckets::default();

    if let Some(root) = claude_projects_dir() {
        for path in jsonl_files(&root, 1, since) {
            if let Ok(file) = std::fs::File::open(&path) {
                scan_claude_transcript(BufReader::new(file), from, to, &mut buckets);
            }
        }
    }
    if let Some(root) = codex_sessions_dir() {
        for path in jsonl_files(&root, 3, since) {
            if let Ok(file) = std::fs::File::open(&path) {
                scan_codex_rollout(BufReader::new(file), from, to, &mut buckets);
            }
        }
    }

    buckets.into_events()
}

// ── Git ──────────────────────────────────────────────────────────────────────

/// Working directories of recent AI sessions — the repositories the user
/// actually works in, without having to configure a list of folders.
pub fn discover_repo_dirs() -> Vec<PathBuf> {
    let since = SystemTime::now()
        - std::time::Duration::from_secs(REPO_DISCOVERY_DAYS * 24 * 3600);
    let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();

    // The cwd shows up within the first lines of either transcript format.
    let first_cwd = |path: &Path, codex: bool| -> Option<String> {
        let file = std::fs::File::open(path).ok()?;
        BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .take(20)
            .find_map(|line| {
                if codex {
                    serde_json::from_str::<CodexLine>(&line)
                        .ok()?
                        .payload?
                        .cwd
                } else {
                    if !line.contains("\"cwd\"") {
                        return None;
                    }
                    serde_json::from_str::<ClaudeLine>(&line).ok()?.cwd
                }
            })
    };

    if let Some(root) = claude_projects_dir() {
        for path in jsonl_files(&root, 1, since) {
            if let Some(cwd) = first_cwd(&path, false) {
                dirs.insert(PathBuf::from(cwd));
            }
        }
    }
    if let Some(root) = codex_sessions_dir() {
        for path in jsonl_files(&root, 3, since) {
            if let Some(cwd) = first_cwd(&path, true) {
                dirs.insert(PathBuf::from(cwd));
            }
        }
    }

    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: a GUI app spawning git.exe would flash a console.
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).to_string())
}

/// Turns one `git log --format=%S%x1f%aI%x1f%s` line into an event. The key
/// comes from the commit subject when it names one, otherwise from the branch
/// the commit was reached through.
fn parse_log_line(line: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> Option<ActivityEvent> {
    let mut parts = line.splitn(3, '\u{1f}');
    let source_ref = parts.next()?;
    let authored = parse_utc(parts.next()?)?;
    let subject = parts.next().unwrap_or("").trim();
    // `--since` filters on the committer date, which a rebase rewrites; the
    // author date is when the work was actually done.
    if authored < from || authored >= to {
        return None;
    }

    let key = crate::jira::extract_all_jira_keys(subject)
        .into_iter()
        .next()
        .or_else(|| keys_in_branch(source_ref).into_iter().next())?;

    Some(ActivityEvent {
        key,
        at: authored.to_rfc3339(),
        source: "commit".to_string(),
        kind: "end".to_string(),
        detail: subject.chars().take(80).collect(),
        weight: 1.0,
    })
}

/// Commits authored by the user in `[from, to)`, across every branch of the
/// given repositories (unpushed ones included).
pub fn collect_commits(repo_dirs: &[PathBuf], from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<ActivityEvent> {
    let mut roots: BTreeSet<PathBuf> = BTreeSet::new();
    for dir in repo_dirs {
        if let Some(top) = git(dir, &["rev-parse", "--show-toplevel"]) {
            roots.insert(PathBuf::from(top.trim()));
        }
    }

    let since = from.to_rfc3339();
    // A day of margin: the committer date can trail the author date.
    let until = (to + chrono::Duration::days(1)).to_rfc3339();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut events = Vec::new();

    for root in roots {
        let Some(email) = git(&root, &["config", "user.email"]) else { continue };
        let email = email.trim();
        if email.is_empty() {
            continue;
        }
        let Some(log) = git(
            &root,
            &[
                "log",
                "--all",
                "--source",
                "--no-merges",
                &format!("--since={since}"),
                &format!("--until={until}"),
                &format!("--author={email}"),
                "--format=%S%x1f%aI%x1f%s",
            ],
        ) else {
            continue;
        };
        for line in log.lines() {
            if let Some(event) = parse_log_line(line, from, to) {
                // The same commit can sit in several clones of one repository.
                if seen.insert((event.at.clone(), event.detail.clone())) {
                    events.push(event);
                }
            }
        }
    }
    events
}

/// All local evidence for `[from, to)`, sorted by time.
pub fn collect(from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<ActivityEvent> {
    let mut events = collect_ai_sessions(from, to);
    events.extend(collect_commits(&discover_repo_dirs(), from, to));
    events.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(value: &str) -> DateTime<Utc> {
        parse_utc(value).unwrap()
    }

    #[test]
    fn branch_keys_are_found_case_insensitively() {
        assert_eq!(keys_in_branch("PENT-5755/rass"), vec!["PENT-5755"]);
        assert_eq!(keys_in_branch("feature/pent-12-login"), vec!["PENT-12"]);
        assert!(keys_in_branch("main").is_empty());
        assert!(keys_in_branch("SKILLS/add-review-skill").is_empty());
    }

    #[test]
    fn claude_exchanges_are_bucketed_per_story() {
        let transcript = [
            r#"{"type":"user","timestamp":"2026-10-01T08:00:10Z","gitBranch":"PENT-1/a","cwd":"/x"}"#,
            r#"{"type":"assistant","timestamp":"2026-10-01T08:02:00Z","gitBranch":"PENT-1/a","cwd":"/x"}"#,
            r#"{"type":"assistant","timestamp":"2026-10-01T08:20:00Z","gitBranch":"PENT-1/a","cwd":"/x"}"#,
            r#"{"type":"attachment","timestamp":"2026-10-01T08:30:00Z","gitBranch":"PENT-1/a"}"#,
            r#"{"type":"user","timestamp":"2026-10-01T09:00:00Z","gitBranch":"main","cwd":"/x"}"#,
            r#"{"type":"user","timestamp":"2026-09-30T09:00:00Z","gitBranch":"PENT-1/a","cwd":"/x"}"#,
        ]
        .join("\n");
        let mut buckets = SessionBuckets::default();
        scan_claude_transcript(
            transcript.as_bytes(),
            utc("2026-10-01T00:00:00Z"),
            utc("2026-10-02T00:00:00Z"),
            &mut buckets,
        );
        let events = buckets.into_events();
        // 08:00 and 08:02 share a bucket; 08:20 is another; main and the
        // previous day are ignored; attachments are not exchanges.
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.key == "PENT-1" && e.kind == "during"));
    }

    #[test]
    fn codex_rollouts_take_the_branch_from_the_session_meta() {
        let rollout = [
            r#"{"timestamp":"2026-10-01T10:00:00Z","type":"session_meta","payload":{"cwd":"/x","git":{"branch":"PENT-7/fix"}}}"#,
            r#"{"timestamp":"2026-10-01T10:01:00Z","type":"response_item","payload":{}}"#,
            r#"{"timestamp":"2026-10-01T10:40:00Z","type":"event_msg","payload":{}}"#,
        ]
        .join("\n");
        let mut buckets = SessionBuckets::default();
        scan_codex_rollout(
            rollout.as_bytes(),
            utc("2026-10-01T00:00:00Z"),
            utc("2026-10-02T00:00:00Z"),
            &mut buckets,
        );
        let events = buckets.into_events();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|e| e.key == "PENT-7" && e.detail == "Codex"));
    }

    #[test]
    fn commits_prefer_the_subject_key_then_the_branch() {
        let from = utc("2026-10-01T00:00:00Z");
        let to = utc("2026-10-02T00:00:00Z");

        let subject = parse_log_line(
            "refs/heads/PENT-1/x\u{1f}2026-10-01T09:30:00+02:00\u{1f}PENT-2 fix typo",
            from,
            to,
        )
        .unwrap();
        assert_eq!(subject.key, "PENT-2");
        assert_eq!(subject.kind, "end");

        let branch = parse_log_line(
            "refs/remotes/origin/PENT-5755/rass\u{1f}2026-10-01T09:30:00+02:00\u{1f}tweak",
            from,
            to,
        )
        .unwrap();
        assert_eq!(branch.key, "PENT-5755");

        assert!(parse_log_line("refs/heads/main\u{1f}2026-10-01T09:30:00+02:00\u{1f}tweak", from, to).is_none());
        assert!(
            parse_log_line("refs/heads/PENT-1/x\u{1f}2026-09-29T09:30:00+02:00\u{1f}old", from, to).is_none(),
            "author date outside the day"
        );
    }
}
