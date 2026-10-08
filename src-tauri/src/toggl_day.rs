//! The Toggl day, assembled once for both front doors: the planner panel (Tauri
//! commands) and the MCP server (`zugit --mcp`).
//!
//! A day is: what is already booked, the meetings on the calendar, the stories
//! that could own the free time, and the evidence of which of them was actually
//! worked on and when — Jira transitions made by the user, commits, AI sessions.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

use crate::activity::ActivityEvent;
use crate::jira::ActiveIssue;
use crate::models::AppSettings;
use crate::storage;
use crate::toggl::{LearnedRules, TogglAccount};

/// Rules older than this are refreshed from Toggl history on the next open.
const TOGGL_RULES_MAX_AGE_DAYS: i64 = 7;

/// Pages of 250 calendar events read when learning from history.
const CALENDAR_HISTORY_PAGES: usize = 12;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglDayContext {
    pub account: TogglAccount,
    pub workspace_id: i64,
    pub existing: Vec<crate::toggl::TogglTimeEntry>,
    /// Stories that could own the free time: in progress, in merge request, or
    /// "touched" — moved by the user during the day, or seen in local activity.
    pub issues: Vec<ActiveIssue>,
    pub rules: LearnedRules,
    /// Google Calendar events overlapping the range, when the calendar is connected.
    pub events: Vec<crate::google::CalendarEvent>,
    /// Evidence of what was worked on, sorted by time. Only keys of `issues`.
    pub activity: Vec<ActivityEvent>,
    /// Gap filling weights, when the option is on (empty otherwise).
    pub fill: Vec<FillStory>,
    pub warnings: Vec<String>,
}

/// A sprint story's claim on the time no evidence explains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillStory {
    pub key: String,
    pub points: f64,
    /// No estimate in Jira (bugs, sub-tasks): counted as one point.
    pub points_assumed: bool,
    /// Minutes already booked on the story over the learned history.
    pub booked_minutes: i64,
    /// What the estimate is worth at the user's pace, when the pace is known.
    pub budget_minutes: Option<i64>,
    /// Share of the unexplained time, relative to the other stories.
    pub weight: f64,
}

/// Stories without an estimate count as this many points.
const ASSUMED_POINTS: f64 = 1.0;

/// Weights for filling: what each story's estimate still leaves unbooked.
///
/// With a known pace (minutes per point) a story's budget is points × pace;
/// its weight is the budget minus what is already booked, so a story finished
/// in a hurry draws the slack and one that already took its share draws none.
/// Stories without an estimate never drop to zero — a "one point" bug can be a
/// one-liner or a week, so booking more on it is fine. Without a pace, or when
/// every budget is spent, the weights fall back to the points themselves.
pub fn fill_weights(
    stories: &[(String, Option<f64>)],
    minutes_by_key: &HashMap<String, i64>,
    minutes_per_point: Option<f64>,
) -> Vec<FillStory> {
    let mut fill: Vec<FillStory> = stories
        .iter()
        .map(|(key, points)| {
            let assumed = points.is_none();
            let points = points.unwrap_or(ASSUMED_POINTS);
            let booked = minutes_by_key.get(key).copied().unwrap_or(0);
            let (budget, weight) = match minutes_per_point {
                Some(pace) => {
                    let budget = points * pace;
                    let remaining = budget - booked as f64;
                    let floor = if assumed { pace * 0.5 } else { 0.0 };
                    (Some(budget.round() as i64), remaining.max(floor))
                }
                None => (None, points),
            };
            FillStory {
                key: key.clone(),
                points,
                points_assumed: assumed,
                booked_minutes: booked,
                budget_minutes: budget,
                weight,
            }
        })
        .collect();
    if fill.iter().all(|story| story.weight <= 0.0) {
        for story in &mut fill {
            story.weight = story.points;
        }
    }
    fill
}

/// Moves made in the same minute share one unit of evidence between them.
fn bulk_weights(moves: &[crate::jira::MyTransition]) -> Vec<f64> {
    let minute = |at: &str| at.chars().take(16).collect::<String>();
    let mut per_minute: HashMap<String, usize> = HashMap::new();
    for transition in moves {
        *per_minute.entry(minute(&transition.at)).or_default() += 1;
    }
    moves
        .iter()
        .map(|transition| 1.0 / per_minute[&minute(&transition.at)] as f64)
        .collect()
}

pub struct DayRequest<'a> {
    pub settings: &'a AppSettings,
    pub data_dir: &'a Path,
    pub client: &'a reqwest::Client,
    pub account: TogglAccount,
    pub workspace_id: i64,
    /// `None` when the calendar is disabled; `Some(Err)` when it should work but
    /// the token could not be refreshed.
    pub google_token: Option<Result<String, String>>,
    /// Window the Toggl entries and calendar events are read for (RFC3339).
    pub range_start: String,
    pub range_end: String,
    /// The planned day, for the evidence lookups.
    pub day: chrono::NaiveDate,
    pub force_relearn: bool,
    /// Moving to another day: the viewer's active and sprint stories read a few
    /// minutes ago are still good. Opening the planner reads them afresh.
    pub reuse_jira: bool,
}

fn local_midnight(day: chrono::NaiveDate) -> DateTime<Local> {
    day.and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .unwrap_or_else(Local::now)
}

/// The day's evidence window: the whole calendar day, stretched to cover an
/// overnight working range when there is one.
fn evidence_window(day: chrono::NaiveDate, range_end: &str) -> (DateTime<Local>, DateTime<Local>) {
    let from = local_midnight(day);
    let mut to = local_midnight(day.succ_opt().unwrap_or(day));
    if let Ok(end) = DateTime::parse_from_rfc3339(range_end) {
        // The fetch window carries half a day of margin; anything past it is
        // the next day's business.
        let end = end.with_timezone(&Local) - chrono::Duration::hours(12);
        if end > to {
            to = end;
        }
    }
    (from, to)
}

/// What a move past merge request is worth when no commit or AI session of the
/// user backs it: next to nothing. Moving a story to Developed is as often the
/// reviewer merging someone else's MR as the end of one's own work.
const UNBACKED_HANDOVER: f64 = 0.1;

/// A move that closes work *and* is not the developer's own hand-off to review:
/// Developed, Done, Verified… — anything but "in progress" and merge request.
fn is_handover(to_status: &str, kind: &str, merge_names: &HashSet<String>) -> bool {
    kind == "end" && !merge_names.contains(&to_status.trim().to_lowercase())
}

/// Moving a story into "in progress" starts work on it; every other status it
/// is moved into (Developed, Merge Request, Done…) marks work that just ended.
///
/// Jira names statuses in the user's language, so "in progress" is whatever
/// the in-progress stories are called ("In corso"), plus the English name.
fn transition_kind(to_status: &str, in_progress_names: &HashSet<String>) -> &'static str {
    let name = to_status.trim().to_lowercase();
    if name == "in progress" || in_progress_names.contains(&name) {
        "start"
    } else {
        "end"
    }
}

/// Project prefixes the user plausibly books on — used to drop branch-name
/// lookalikes ("RELEASE-2026") before they reach Jira.
fn known_prefixes(settings: &AppSettings, issues: &[ActiveIssue], rules: &LearnedRules) -> HashSet<String> {
    let mut prefixes: HashSet<String> = HashSet::new();
    let mut add = |key: &str| {
        if let Some((prefix, _)) = key.split_once('-') {
            prefixes.insert(prefix.to_uppercase());
        } else if !key.is_empty() {
            prefixes.insert(key.to_uppercase());
        }
    };
    issues.iter().for_each(|issue| add(&issue.key));
    rules.by_prefix.keys().for_each(|prefix| add(prefix));
    settings.jira_repo_boards.values().for_each(|board| add(board));
    prefixes
}

/// The user's pace from history: estimates of the stories booked in the learned
/// window against the minutes booked on them. Stories not started yet or still
/// in progress would drag the median down, so they are left out.
async fn learn_pace(rules: &mut LearnedRules, in_progress_names: &HashSet<String>, req: &DayRequest<'_>) {
    let keys: Vec<String> = rules
        .minutes_by_key
        .iter()
        .filter(|(_, minutes)| **minutes >= 30)
        .map(|(key, _)| key.clone())
        .collect();
    if keys.is_empty() {
        return;
    }
    let pointed = crate::jira::fetch_points_for(&keys, req.settings, req.client).await;
    let samples: Vec<(f64, i64)> = pointed
        .iter()
        .filter(|issue| issue.status_category != "new")
        .filter(|issue| !in_progress_names.contains(&issue.status.trim().to_lowercase()))
        .filter_map(|issue| Some((issue.points?, *rules.minutes_by_key.get(&issue.key)?)))
        .collect();
    rules.minutes_per_point = crate::toggl::minutes_per_point(&samples);
    rules.points_sample = samples.len();
}

async fn load_rules(
    req: &DayRequest<'_>,
    in_progress_names: &HashSet<String>,
    warnings: &mut Vec<String>,
) -> LearnedRules {
    let mut rules = storage::load_toggl_rules(req.data_dir);
    let stale = req.force_relearn
        || rules.entries_scanned == 0
        // Cached under an older shape: re-learn rather than answer with defaults
        // for fields that did not exist when the file was written.
        || rules.version < crate::toggl::RULES_VERSION
        || DateTime::parse_from_rfc3339(&rules.learned_at)
            .map(|learned| (Utc::now() - learned.with_timezone(&Utc)).num_days() >= TOGGL_RULES_MAX_AGE_DAYS)
            .unwrap_or(true);

    if stale {
        let today = Local::now();
        let from = (today - chrono::Duration::days(req.settings.toggl_history_days as i64))
            .format("%Y-%m-%d")
            .to_string();
        // Toggl's end date is exclusive: tomorrow, so today's entries count too.
        let to = (today + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        match crate::toggl::fetch_time_entries(&req.settings.toggl_token, &from, &to, req.client).await {
            Ok(history) => {
                rules = crate::toggl::learn_from_entries(&history, Utc::now().to_rfc3339());
                if let Some(Ok(token)) = &req.google_token {
                    let time_min = format!("{from}T00:00:00Z");
                    let time_max = today.to_rfc3339();
                    match crate::google::fetch_events_paged(
                        token,
                        calendar_id(req.settings),
                        &time_min,
                        &time_max,
                        CALENDAR_HISTORY_PAGES,
                        req.client,
                    )
                    .await
                    {
                        Ok(past_events) => crate::toggl::learn_from_calendar(&mut rules, &history, &past_events),
                        Err(error) => warnings.push(format!(
                            "Calendar history unavailable — meetings fall back to name matching: {error}"
                        )),
                    }
                }
                if crate::models::settings_ready_for_jira(req.settings) {
                    learn_pace(&mut rules, in_progress_names, req).await;
                }
                if let Err(error) = storage::save_toggl_rules(req.data_dir, &rules) {
                    warnings.push(format!("Could not cache the learned mapping: {error}"));
                }
            }
            Err(error) => warnings.push(format!(
                "Could not read Toggl history — project mapping may be incomplete: {error}"
            )),
        }
    }

    // The pace is only needed for gap filling; if the last relearn could not
    // work it out (Jira was down, the option was off), try again now rather
    // than leaving filling without budgets for a week.
    if !stale
        && req.settings.toggl_fill_gaps
        && rules.minutes_per_point.is_none()
        && crate::models::settings_ready_for_jira(req.settings)
    {
        learn_pace(&mut rules, in_progress_names, req).await;
        if rules.minutes_per_point.is_some() {
            let _ = storage::save_toggl_rules(req.data_dir, &rules);
        }
    }

    // What the user picked in the planner beats what history suggests, and
    // survives the weekly relearn.
    storage::load_event_memory(req.data_dir).overlay(&mut rules);
    rules
}

pub fn calendar_id(settings: &AppSettings) -> &str {
    if settings.google_calendar_id.trim().is_empty() {
        "primary"
    } else {
        settings.google_calendar_id.trim()
    }
}

pub async fn build_context(req: DayRequest<'_>) -> Result<TogglDayContext, String> {
    let settings = req.settings;
    let mut warnings: Vec<String> = vec![];
    let jira_ready = crate::models::settings_ready_for_jira(settings);
    let (window_from, window_to) = evidence_window(req.day, &req.range_end);

    let entries_fut = crate::toggl::fetch_time_entries(
        &settings.toggl_token,
        &req.range_start,
        &req.range_end,
        req.client,
    );
    let issues_fut = async {
        if jira_ready {
            crate::jira::my_active_issues(settings, req.client, req.reuse_jira).await.map(Some)
        } else {
            Ok(None)
        }
    };
    let transitions_fut = async {
        if jira_ready {
            Some(crate::jira::fetch_my_transitions(window_from, window_to, settings, req.client).await)
        } else {
            None
        }
    };
    let activity_fut = async {
        if !settings.toggl_activity_signals {
            return vec![];
        }
        let (from, to) = (window_from.with_timezone(&Utc), window_to.with_timezone(&Utc));
        // Commits only from clones of the repositories configured in ZuGit.
        let repos = settings.github_repos.clone();
        tokio::task::spawn_blocking(move || crate::activity::collect(from, to, &repos))
            .await
            .unwrap_or_default()
    };
    // Calendar and sprint depend on nothing read above: asked alongside, not
    // after. Each of these services answers in a few hundred milliseconds.
    let events_fut = async {
        match &req.google_token {
            Some(Ok(token)) => Some(
                crate::google::fetch_events(token, calendar_id(settings), &req.range_start, &req.range_end, req.client)
                    .await,
            ),
            _ => None,
        }
    };
    let sprint_fut = async {
        if settings.toggl_fill_gaps && jira_ready {
            Some(crate::jira::sprint_issues(settings, req.client, req.reuse_jira).await)
        } else {
            None
        }
    };
    let (entries, active, transitions, mut activity, fetched_events, sprint) =
        tokio::join!(entries_fut, issues_fut, transitions_fut, activity_fut, events_fut, sprint_fut);

    let existing = entries.map_err(String::from)?;
    let mut issues = match active {
        Ok(Some(active)) => {
            if !active.sprint_scoped && !active.issues.is_empty() {
                warnings.push(
                    "Nessuno sprint attivo: mostro le story assegnate a te aggiornate negli ultimi 14 giorni.".to_string(),
                );
            }
            active.issues
        }
        Ok(None) => {
            warnings.push("Jira is not configured — no stories to propose.".to_string());
            vec![]
        }
        Err(error) => {
            warnings.push(format!("Jira stories unavailable: {error}"));
            vec![]
        }
    };

    let in_progress_names: HashSet<String> = issues
        .iter()
        .filter(|issue| issue.stage == "in-progress")
        .map(|issue| issue.status.trim().to_lowercase())
        .collect();
    let merge_names: HashSet<String> = issues
        .iter()
        .filter(|issue| issue.stage == "merge-request")
        .map(|issue| issue.status.trim().to_lowercase())
        .chain([settings.jira_merge_transition.trim().to_lowercase()])
        .collect();
    // Stories with commits or AI sessions of the user today. Only meaningful
    // when local signals are read at all; otherwise nothing can be checked.
    let backed: Option<HashSet<String>> = settings
        .toggl_activity_signals
        .then(|| activity.iter().map(|event| event.key.clone()).collect());

    // Stories the user moved during the day join the candidates, whatever
    // status they ended up in — and each move is a piece of evidence.
    match transitions {
        Some(Ok((touched, moves))) => {
            let mut last_move: HashMap<&str, &str> = HashMap::new();
            for (transition, bulk) in moves.iter().zip(bulk_weights(&moves)) {
                last_move.insert(&transition.key, &transition.at);
                let kind = transition_kind(&transition.to_status, &in_progress_names);
                let unbacked = is_handover(&transition.to_status, kind, &merge_names)
                    && backed.as_ref().is_some_and(|keys| !keys.contains(&transition.key));
                let mut notes: Vec<&str> = vec![];
                if bulk < 1.0 {
                    notes.push("in blocco");
                }
                if unbacked {
                    notes.push("senza tuoi commit o sessioni");
                }
                activity.push(ActivityEvent {
                    key: transition.key.clone(),
                    at: transition.at.clone(),
                    source: "jira".to_string(),
                    kind: kind.to_string(),
                    detail: if notes.is_empty() {
                        format!("→ {}", transition.to_status)
                    } else {
                        format!("→ {} ({})", transition.to_status, notes.join(", "))
                    },
                    weight: if unbacked { bulk * UNBACKED_HANDOVER } else { bulk },
                });
            }
            for issue in touched {
                if issues.iter().any(|known| known.key == issue.key) {
                    continue;
                }
                let Some(at) = last_move.get(issue.key.as_str()) else { continue };
                issues.push(touched_issue(settings, &issue, Some(at.to_string())));
            }
        }
        Some(Err(error)) => warnings.push(format!("Jira transitions unavailable: {error}")),
        None => {}
    }

    let mut events = vec![];
    match (&req.google_token, fetched_events) {
        (_, Some(Ok(fetched))) => events = fetched,
        (_, Some(Err(error))) => warnings.push(format!("Google Calendar: {error}")),
        (Some(Err(error)), None) => warnings.push(format!("Google Calendar: {error}")),
        _ => {}
    }

    let rules = load_rules(&req, &in_progress_names, &mut warnings).await;

    // Keys seen only in local activity: look them up, so the planner can show
    // a summary — and so lookalikes Jira does not know are dropped.
    let prefixes = known_prefixes(settings, &issues, &rules);
    let unknown: Vec<String> = activity
        .iter()
        .map(|event| event.key.clone())
        .filter(|key| !issues.iter().any(|issue| &issue.key == key))
        .filter(|key| {
            prefixes.is_empty()
                || key
                    .split_once('-')
                    .is_some_and(|(prefix, _)| prefixes.contains(prefix))
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if jira_ready && !unknown.is_empty() {
        for issue in crate::jira::fetch_issue_summaries(&unknown, settings, req.client).await {
            issues.push(touched_issue(settings, &issue, None));
        }
    }

    let known: HashSet<String> = issues.iter().map(|issue| issue.key.clone()).collect();
    activity.retain(|event| known.contains(&event.key));
    activity.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));

    let fill = match sprint {
        Some(sprint) => sprint_fill(settings, sprint, &mut issues, &rules, &mut warnings),
        None => vec![],
    };

    Ok(TogglDayContext {
        account: req.account,
        workspace_id: req.workspace_id,
        existing,
        issues,
        rules,
        events,
        activity,
        fill,
        warnings,
    })
}

/// The sprint's stories with their filling weights — only the sprint's: a
/// story outside it, however long it sat in a status, never draws filled time.
/// Sprint stories not yet among the candidates join them as "sprint" — they
/// only ever receive filled time, never compete for slots with evidence.
fn sprint_fill(
    settings: &AppSettings,
    sprint: Result<Vec<crate::jira::PointedIssue>, crate::models::ApiError>,
    issues: &mut Vec<ActiveIssue>,
    rules: &LearnedRules,
    warnings: &mut Vec<String>,
) -> Vec<FillStory> {
    let sprint = match sprint {
        Ok(sprint) => sprint,
        Err(error) => {
            warnings.push(format!("Sprint unavailable for gap filling: {error}"));
            vec![]
        }
    };

    let mut points: HashMap<String, Option<f64>> = HashMap::new();
    for story in &sprint {
        let candidate = issues.iter().any(|issue| issue.key == story.key);
        // A story nobody has started cannot have soaked up yesterday's slack.
        if story.status_category == "new" && !candidate {
            continue;
        }
        points.insert(story.key.clone(), story.points);
        if !candidate {
            issues.push(ActiveIssue {
                key: story.key.clone(),
                summary: story.summary.clone(),
                status: story.status.clone(),
                issue_type: story.issue_type.clone(),
                url: format!("{}/browse/{}", settings.jira_base_url, story.key),
                status_changed_at: None,
                stage: "sprint".to_string(),
            });
        }
    }

    let mut stories: Vec<(String, Option<f64>)> = points.into_iter().collect();
    stories.sort_by(|a, b| a.0.cmp(&b.0));
    fill_weights(&stories, &rules.minutes_by_key, rules.minutes_per_point)
}

fn touched_issue(
    settings: &AppSettings,
    issue: &crate::jira::JiraIssueSummary,
    status_changed_at: Option<String>,
) -> ActiveIssue {
    ActiveIssue {
        key: issue.key.clone(),
        summary: issue.summary.clone(),
        status: issue.status.clone(),
        issue_type: issue.issue_type.clone(),
        url: format!("{}/browse/{}", settings.jira_base_url, issue.key),
        status_changed_at,
        stage: "touched".to_string(),
    }
}

// ── Proposals ────────────────────────────────────────────────────────────────

/// One entry an MCP client proposes for a day. Times are local wall-clock
/// "HH:MM" on the proposal's date — what a model reads and writes most reliably.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedEntry {
    pub start: String,
    pub end: String,
    pub description: String,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub billable: Option<bool>,
    /// Why the client put this here — shown next to the row in ZuGit.
    #[serde(default)]
    pub reason: Option<String>,
}

/// A day plan waiting for the user's confirmation in ZuGit. Nothing reaches
/// Toggl until it is reviewed and submitted from the planner.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglProposal {
    pub date: String,
    /// RFC3339.
    pub created_at: String,
    /// Name of the MCP client that wrote it ("claude-code", "codex"…).
    pub source: String,
    #[serde(default)]
    pub note: Option<String>,
    pub entries: Vec<ProposedEntry>,
}

/// "HH:MM" → minutes from midnight; "24:00" is accepted as the end of the day.
pub fn parse_hhmm(value: &str) -> Option<u32> {
    let (h, m) = value.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if m >= 60 || h > 24 || (h == 24 && m > 0) {
        return None;
    }
    Some(h * 60 + m)
}

/// Checks a proposal is something the planner can show and submit: sane
/// times, a description on every row, no rows on top of each other.
pub fn validate_entries(entries: &mut [ProposedEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return Err("The proposal has no entries.".into());
    }
    if entries.len() > 60 {
        return Err("Too many entries for one day (max 60).".into());
    }
    let mut spans = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter_mut().enumerate() {
        let row = index + 1;
        let start = parse_hhmm(&entry.start)
            .ok_or_else(|| format!("Entry {row}: start '{}' is not HH:MM.", entry.start))?;
        let end = parse_hhmm(&entry.end)
            .ok_or_else(|| format!("Entry {row}: end '{}' is not HH:MM.", entry.end))?;
        if end <= start {
            return Err(format!("Entry {row}: end must be after start."));
        }
        entry.description = entry.description.trim().chars().take(300).collect();
        if entry.description.is_empty() {
            return Err(format!("Entry {row}: description is empty."));
        }
        entry.issue_key = entry
            .issue_key
            .take()
            .map(|key| key.trim().to_uppercase())
            .filter(|key| !key.is_empty());
        spans.push((start, end, row));
    }
    spans.sort();
    for pair in spans.windows(2) {
        if pair[1].0 < pair[0].1 {
            return Err(format!("Entries {} and {} overlap.", pair[0].2, pair[1].2));
        }
    }
    entries.sort_by_key(|entry| parse_hhmm(&entry.start));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proposed(start: &str, end: &str, description: &str) -> ProposedEntry {
        ProposedEntry {
            start: start.into(),
            end: end.into(),
            description: description.into(),
            issue_key: Some(" pent-1 ".into()),
            project_id: None,
            tags: vec![],
            billable: None,
            reason: None,
        }
    }

    #[test]
    fn proposals_are_sorted_and_normalised() {
        let mut entries = vec![proposed("10:00", "11:00", "b"), proposed("08:00", "10:00", " a ")];
        validate_entries(&mut entries).unwrap();
        assert_eq!(entries[0].start, "08:00");
        assert_eq!(entries[0].description, "a");
        assert_eq!(entries[0].issue_key.as_deref(), Some("PENT-1"));
    }

    #[test]
    fn overlapping_or_broken_proposals_are_refused() {
        let mut overlap = vec![proposed("08:00", "10:00", "a"), proposed("09:30", "11:00", "b")];
        assert!(validate_entries(&mut overlap).unwrap_err().contains("overlap"));

        let mut backwards = vec![proposed("10:00", "09:00", "a")];
        assert!(validate_entries(&mut backwards).is_err());

        let mut empty = vec![proposed("08:00", "09:00", "  ")];
        assert!(validate_entries(&mut empty).is_err());

        let mut garbage = vec![proposed("8", "09:00", "a")];
        assert!(validate_entries(&mut garbage).is_err());
    }

    #[test]
    fn transitions_into_in_progress_start_work_and_the_rest_end_it() {
        let names: HashSet<String> = ["in corso".to_string()].into();
        assert_eq!(transition_kind("In Progress", &names), "start");
        assert_eq!(transition_kind("In corso", &names), "start");
        assert_eq!(transition_kind("Developed", &names), "end");
        assert_eq!(transition_kind("Merge Request", &names), "end");
    }

    #[test]
    fn only_moves_past_merge_request_are_handovers() {
        let merge: HashSet<String> = ["merge request".to_string()].into();
        assert!(is_handover("Developed", "end", &merge));
        assert!(is_handover("Done", "end", &merge));
        assert!(!is_handover(" Merge Request ", "end", &merge));
        assert!(!is_handover("In corso", "start", &merge));
    }

    #[test]
    fn filling_follows_what_each_estimate_leaves_unbooked() {
        let booked: HashMap<String, i64> =
            [("PENT-BIG".to_string(), 360), ("PENT-SMALL".to_string(), 300)].into();
        let fill = fill_weights(
            &[
                ("PENT-BIG".into(), Some(8.0)),   // 8 × 180 = 1440, 360 booked → 1080 left
                ("PENT-SMALL".into(), Some(1.0)), // 180, 300 booked → nothing left
                ("PENT-BUG".into(), None),        // assumed 1 point, never below half a point
            ],
            &booked,
            Some(180.0),
        );
        assert_eq!(fill[0].weight, 1080.0);
        assert_eq!(fill[0].budget_minutes, Some(1440));
        assert_eq!(fill[1].weight, 0.0);
        assert!(fill[2].points_assumed);
        assert_eq!(fill[2].weight, 180.0);
    }

    #[test]
    fn without_a_pace_or_any_budget_left_filling_follows_the_points() {
        let fill = fill_weights(&[("A-1".into(), Some(5.0)), ("A-2".into(), None)], &HashMap::new(), None);
        assert_eq!((fill[0].weight, fill[1].weight), (5.0, 1.0));

        let spent: HashMap<String, i64> = [("A-1".to_string(), 9999)].into();
        let fill = fill_weights(&[("A-1".into(), Some(3.0))], &spent, Some(60.0));
        assert_eq!(fill[0].weight, 3.0);
    }

    #[test]
    fn moves_made_in_the_same_minute_share_their_weight() {
        let moved = |key: &str, at: &str| crate::jira::MyTransition {
            key: key.into(),
            at: at.into(),
            to_status: "Developed".into(),
        };
        let weights = bulk_weights(&[
            moved("A-1", "2026-10-01T10:14:05+00:00"),
            moved("A-2", "2026-10-01T10:14:40+00:00"),
            moved("A-3", "2026-10-01T15:00:00+00:00"),
        ]);
        assert_eq!(weights, vec![0.5, 0.5, 1.0]);
    }

    #[test]
    fn hhmm_accepts_the_end_of_the_day() {
        assert_eq!(parse_hhmm("24:00"), Some(1440));
        assert_eq!(parse_hhmm("8:05"), Some(485));
        assert_eq!(parse_hhmm("24:01"), None);
        assert_eq!(parse_hhmm("12:60"), None);
    }
}
