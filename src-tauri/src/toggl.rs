//! Toggl Track API v9 client.
//!
//! Only documented endpoints are used:
//!   * `GET  /me?with_related_data=true` — workspaces + projects in one call
//!   * `GET  /me/time_entries`           — existing entries (day view + history)
//!   * `POST /workspaces/{wid}/time_entries` — entry creation
//!
//! Authentication is Basic auth with the API token as username and the literal
//! `api_token` as password.
//!
//! Toggl rate-limits `/me` hard (30 requests/hour on Free plans), so the account
//! payload is cached in `AppState` and only refetched when the caller asks for it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::ApiError;

const API_BASE: &str = "https://api.track.toggl.com/api/v9";
const CREATED_WITH: &str = "ZuGit";

/// Toggl answers 403 (not 401) for a wrong or revoked token, so both codes mean
/// "re-authenticate" here — unlike GitHub/Jira, where 403 is also rate limiting.
fn classify(status: u16, message: String) -> ApiError {
    if status == 401 || status == 403 {
        ApiError::Auth(message)
    } else {
        ApiError::Other(message)
    }
}

// ── Public types (serialised to the frontend) ────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglWorkspace {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglProject {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
    pub color: Option<String>,
    pub active: bool,
    pub client_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglTag {
    pub id: i64,
    pub workspace_id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglTimeEntry {
    pub id: i64,
    pub workspace_id: i64,
    pub project_id: Option<i64>,
    pub description: String,
    /// RFC3339, as returned by Toggl (UTC).
    pub start: String,
    pub stop: Option<String>,
    /// Seconds; negative when the entry is still running.
    pub duration: i64,
    pub tags: Vec<String>,
    pub billable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TogglAccount {
    pub fullname: String,
    pub email: String,
    pub default_workspace_id: Option<i64>,
    pub workspaces: Vec<TogglWorkspace>,
    pub projects: Vec<TogglProject>,
    /// Tags defined in the workspaces — the options offered by the tag picker.
    pub tags: Vec<TogglTag>,
}

// ── Raw API shapes ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawMe {
    #[serde(default)]
    fullname: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    default_workspace_id: Option<i64>,
    #[serde(default)]
    workspaces: Vec<RawWorkspace>,
    #[serde(default)]
    projects: Vec<RawProject>,
    #[serde(default)]
    tags: Vec<RawTag>,
}

#[derive(Debug, Deserialize)]
struct RawTag {
    id: i64,
    workspace_id: i64,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawWorkspace {
    id: i64,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProject {
    id: i64,
    workspace_id: i64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    client_name: Option<String>,
    /// Archived projects are still returned; they are kept but flagged inactive.
    #[serde(default)]
    server_deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawTimeEntry {
    id: i64,
    workspace_id: i64,
    #[serde(default)]
    project_id: Option<i64>,
    #[serde(default)]
    description: Option<String>,
    start: String,
    #[serde(default)]
    stop: Option<String>,
    #[serde(default)]
    duration: i64,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    billable: Option<bool>,
}

// ── Fetch ────────────────────────────────────────────────────────────────────

pub async fn fetch_account(
    token: &str,
    client: &reqwest::Client,
) -> Result<TogglAccount, ApiError> {
    let response = client
        .get(format!("{API_BASE}/me?with_related_data=true"))
        .basic_auth(token, Some("api_token"))
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("Toggl unreachable: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(classify(
            status.as_u16(),
            format!("Toggl /me failed ({status})"),
        ));
    }

    let me: RawMe = response
        .json()
        .await
        .map_err(|e| ApiError::Other(format!("Could not parse the Toggl profile: {e}")))?;

    let mut projects: Vec<TogglProject> = me
        .projects
        .into_iter()
        .filter(|p| p.server_deleted_at.is_none())
        .map(|p| TogglProject {
            id: p.id,
            workspace_id: p.workspace_id,
            name: p.name.unwrap_or_else(|| format!("Project {}", p.id)),
            color: p.color,
            active: p.active.unwrap_or(true),
            client_name: p.client_name,
        })
        .collect();
    // Active first, then alphabetical — the order the picker renders them in.
    projects.sort_by(|a, b| b.active.cmp(&a.active).then_with(|| a.name.cmp(&b.name)));

    Ok(TogglAccount {
        fullname: me.fullname.unwrap_or_default(),
        email: me.email.unwrap_or_default(),
        default_workspace_id: me.default_workspace_id,
        workspaces: me
            .workspaces
            .into_iter()
            .map(|w| TogglWorkspace {
                name: w.name.unwrap_or_else(|| format!("Workspace {}", w.id)),
                id: w.id,
            })
            .collect(),
        projects,
        tags: me
            .tags
            .into_iter()
            .map(|t| TogglTag {
                name: t.name.unwrap_or_else(|| format!("Tag {}", t.id)),
                id: t.id,
                workspace_id: t.workspace_id,
            })
            .collect(),
    })
}

/// Time entries overlapping `[start, end)`. Both bounds are passed straight to
/// Toggl, so the caller decides the timezone (we send RFC3339 with local offset).
pub async fn fetch_time_entries(
    token: &str,
    start: &str,
    end: &str,
    client: &reqwest::Client,
) -> Result<Vec<TogglTimeEntry>, ApiError> {
    let response = client
        .get(format!("{API_BASE}/me/time_entries"))
        .query(&[("start_date", start), ("end_date", end)])
        .basic_auth(token, Some("api_token"))
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("Toggl unreachable: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(classify(
            status.as_u16(),
            format!("Toggl time entries failed ({status})"),
        ));
    }

    let raw: Vec<RawTimeEntry> = response
        .json()
        .await
        .map_err(|e| ApiError::Other(format!("Could not parse Toggl time entries: {e}")))?;

    Ok(raw
        .into_iter()
        .map(|e| TogglTimeEntry {
            id: e.id,
            workspace_id: e.workspace_id,
            project_id: e.project_id,
            description: e.description.unwrap_or_default(),
            start: e.start,
            stop: e.stop,
            duration: e.duration,
            tags: e.tags.unwrap_or_default(),
            billable: e.billable.unwrap_or(false),
        })
        .collect())
}

// ── Create ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTimeEntry {
    pub description: String,
    /// RFC3339 with offset.
    pub start: String,
    pub stop: String,
    pub duration_seconds: i64,
    pub project_id: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub billable: bool,
    /// Echoed back in the result so the UI can mark the right row.
    #[serde(default)]
    pub client_ref: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedEntry {
    pub client_ref: String,
    pub id: Option<i64>,
    pub description: String,
    pub ok: bool,
    pub error: Option<String>,
}

pub async fn create_time_entry(
    token: &str,
    workspace_id: i64,
    entry: &NewTimeEntry,
    client: &reqwest::Client,
) -> Result<i64, ApiError> {
    let body = serde_json::json!({
        "created_with": CREATED_WITH,
        "workspace_id": workspace_id,
        "description": entry.description,
        "start": entry.start,
        "stop": entry.stop,
        "duration": entry.duration_seconds,
        "project_id": entry.project_id,
        "tags": entry.tags,
        "billable": entry.billable,
    });

    let response = client
        .post(format!("{API_BASE}/workspaces/{workspace_id}/time_entries"))
        .basic_auth(token, Some("api_token"))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("Toggl unreachable: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.trim();
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(": {}", detail.chars().take(200).collect::<String>())
        };
        return Err(classify(
            status.as_u16(),
            format!("Toggl rejected the entry ({status}){suffix}"),
        ));
    }

    let created: RawTimeEntry = response
        .json()
        .await
        .map_err(|e| ApiError::Other(format!("Could not parse the created entry: {e}")))?;
    Ok(created.id)
}

// ── Learned rules ────────────────────────────────────────────────────────────

/// What history says about a Jira key / recurring meeting: which Toggl project it
/// was booked on, which tags came with it, and the description wording used.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHint {
    pub project_id: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Majority of the past entries for this key were billable.
    #[serde(default)]
    pub billable: bool,
    #[serde(default)]
    pub description: Option<String>,
    /// How many past entries back this hint.
    pub uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringHint {
    /// Canonical description as most often written (e.g. "Retrospective").
    pub label: String,
    /// Normalised form used for matching.
    pub normalized: String,
    pub hint: ProjectHint,
}

/// Bumped whenever a new field is learned from history. Rules cached under an
/// older version are re-learned on the next open instead of silently answering
/// with the default for the field that did not exist yet.
pub const RULES_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnedRules {
    /// 0 = written before versioning, i.e. before `billable` was learned.
    #[serde(default)]
    pub version: u32,
    /// Exact Jira key → project/tags/description ("PENT-1234").
    #[serde(default)]
    pub by_key: HashMap<String, ProjectHint>,
    /// Jira project prefix → project/tags ("PENT"), used for keys never booked before.
    #[serde(default)]
    pub by_prefix: HashMap<String, ProjectHint>,
    /// Recurring non-story entries (retro, stima, daily…), most frequent first.
    #[serde(default)]
    pub recurring: Vec<RecurringHint>,
    #[serde(default)]
    pub entries_scanned: usize,
    #[serde(default)]
    pub learned_at: String,
}

/// Vote tallies for one grouping key.
#[derive(Default)]
struct Votes {
    projects: HashMap<i64, u32>,
    tags: HashMap<String, u32>,
    descriptions: HashMap<String, u32>,
    billable: u32,
    total: u32,
}

impl Votes {
    fn record(&mut self, entry: &TogglTimeEntry) {
        self.total += 1;
        if entry.billable {
            self.billable += 1;
        }
        if let Some(pid) = entry.project_id {
            *self.projects.entry(pid).or_default() += 1;
        }
        for tag in &entry.tags {
            *self.tags.entry(tag.clone()).or_default() += 1;
        }
        let description = entry.description.trim();
        if !description.is_empty() {
            *self.descriptions.entry(description.to_string()).or_default() += 1;
        }
    }

    fn into_hint(self) -> ProjectHint {
        let project_id = self
            .projects
            .iter()
            .max_by_key(|(pid, count)| (**count, **pid))
            .map(|(pid, _)| *pid);

        // A tag only sticks if it was used on at least half of the entries —
        // otherwise a one-off tag would be replayed onto every new entry.
        let threshold = self.total.div_ceil(2).max(1);
        let mut tags: Vec<(String, u32)> = self
            .tags
            .into_iter()
            .filter(|(_, count)| *count >= threshold)
            .collect();
        tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        let description = self
            .descriptions
            .into_iter()
            .max_by_key(|(text, count)| (*count, text.len()))
            .map(|(text, _)| text);

        ProjectHint {
            project_id,
            tags: tags.into_iter().map(|(tag, _)| tag).collect(),
            // Billable when most past entries were — same majority rule as tags.
            billable: self.billable >= threshold,
            description,
            uses: self.total,
        }
    }
}

/// Strips keys, digits and punctuation so "Retro 12/05" and "retro sprint 34"
/// collapse onto the same recurring rule.
fn normalize_description(description: &str) -> String {
    let without_keys = crate::jira::strip_jira_keys(description);
    let cleaned: String = without_keys
        .chars()
        .map(|c| {
            if c.is_alphabetic() || c.is_whitespace() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Builds the mapping rules from past time entries: which project (and tags) each
/// Jira key, key prefix and recurring meeting ended up on.
pub fn learn_from_entries(entries: &[TogglTimeEntry], learned_at: String) -> LearnedRules {
    let mut by_key: HashMap<String, Votes> = HashMap::new();
    let mut by_prefix: HashMap<String, Votes> = HashMap::new();
    let mut recurring: HashMap<String, Votes> = HashMap::new();

    for entry in entries {
        // Running entries have no settled shape yet — skip them.
        if entry.duration < 0 {
            continue;
        }
        let keys = crate::jira::extract_all_jira_keys(&entry.description);
        if keys.is_empty() {
            let normalized = normalize_description(&entry.description);
            if normalized.len() >= 3 {
                recurring.entry(normalized).or_default().record(entry);
            }
            continue;
        }
        for key in keys {
            by_key.entry(key.clone()).or_default().record(entry);
            if let Some((prefix, _)) = key.split_once('-') {
                by_prefix.entry(prefix.to_string()).or_default().record(entry);
            }
        }
    }

    // Two sightings is the bar for "this is a recurring thing", not a one-off.
    let mut recurring: Vec<RecurringHint> = recurring
        .into_iter()
        .filter(|(_, votes)| votes.total >= 2)
        .map(|(normalized, votes)| {
            let hint = votes.into_hint();
            RecurringHint {
                label: hint
                    .description
                    .clone()
                    .unwrap_or_else(|| normalized.clone()),
                normalized,
                hint,
            }
        })
        .collect();
    recurring.sort_by(|a, b| b.hint.uses.cmp(&a.hint.uses).then_with(|| a.label.cmp(&b.label)));

    LearnedRules {
        by_key: by_key
            .into_iter()
            .map(|(key, votes)| (key, votes.into_hint()))
            .collect(),
        by_prefix: by_prefix
            .into_iter()
            .map(|(prefix, votes)| (prefix, votes.into_hint()))
            .collect(),
        recurring,
        entries_scanned: entries.len(),
        learned_at,
        version: RULES_VERSION,
    }
}

/// Folds freshly created entries into the existing rules, so a project picked by
/// hand today is proposed automatically tomorrow — without refetching history.
pub fn reinforce_rules(rules: &mut LearnedRules, entries: &[TogglTimeEntry], learned_at: String) {
    for entry in entries {
        let keys = crate::jira::extract_all_jira_keys(&entry.description);
        if keys.is_empty() {
            let normalized = normalize_description(&entry.description);
            if normalized.len() < 3 {
                continue;
            }
            match rules
                .recurring
                .iter_mut()
                .find(|rule| rule.normalized == normalized)
            {
                Some(rule) => reinforce_hint(&mut rule.hint, entry),
                None => rules.recurring.push(RecurringHint {
                    label: entry.description.trim().to_string(),
                    normalized,
                    hint: ProjectHint {
                        project_id: entry.project_id,
                        tags: entry.tags.clone(),
                        billable: entry.billable,
                        description: Some(entry.description.trim().to_string()),
                        uses: 1,
                    },
                }),
            }
            continue;
        }
        for key in keys {
            reinforce_hint(rules.by_key.entry(key.clone()).or_default(), entry);
            if let Some((prefix, _)) = key.split_once('-') {
                reinforce_hint(rules.by_prefix.entry(prefix.to_string()).or_default(), entry);
            }
        }
    }
    rules.learned_at = learned_at;
}

/// The newest choice wins: it is the most recent evidence of what the user wants.
fn reinforce_hint(hint: &mut ProjectHint, entry: &TogglTimeEntry) {
    if entry.project_id.is_some() {
        hint.project_id = entry.project_id;
    }
    hint.tags = entry.tags.clone();
    hint.billable = entry.billable;
    let description = entry.description.trim();
    if !description.is_empty() {
        hint.description = Some(description.to_string());
    }
    hint.uses += 1;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(description: &str, project_id: Option<i64>, tags: &[&str]) -> TogglTimeEntry {
        TogglTimeEntry {
            id: 1,
            workspace_id: 1,
            project_id,
            description: description.to_string(),
            start: "2026-07-01T08:00:00Z".to_string(),
            stop: Some("2026-07-01T09:00:00Z".to_string()),
            duration: 3600,
            tags: tags.iter().map(|t| t.to_string()).collect(),
            billable: false,
        }
    }

    #[test]
    fn learns_project_per_key_and_prefix() {
        let entries = vec![
            entry("PENT-1 login page", Some(10), &[]),
            entry("PENT-2 logout", Some(10), &[]),
            entry("ACME-9 invoice", Some(20), &[]),
        ];
        let rules = learn_from_entries(&entries, String::new());

        assert_eq!(rules.by_key["PENT-1"].project_id, Some(10));
        assert_eq!(rules.by_prefix["PENT"].project_id, Some(10));
        assert_eq!(rules.by_prefix["PENT"].uses, 2);
        assert_eq!(rules.by_prefix["ACME"].project_id, Some(20));
    }

    #[test]
    fn recurring_needs_two_sightings_and_keeps_stable_tags() {
        let entries = vec![
            entry("Retrospective", Some(30), &["meeting"]),
            entry("Retrospective 12/05", Some(30), &["meeting"]),
            entry("One off chat", Some(30), &["meeting"]),
        ];
        let rules = learn_from_entries(&entries, String::new());

        assert_eq!(rules.recurring.len(), 1);
        let retro = &rules.recurring[0];
        assert_eq!(retro.normalized, "retrospective");
        assert_eq!(retro.hint.project_id, Some(30));
        assert_eq!(retro.hint.tags, vec!["meeting".to_string()]);
    }

    #[test]
    fn billable_follows_the_majority_of_past_entries() {
        let billable = |description: &str| TogglTimeEntry {
            billable: true,
            ..entry(description, Some(10), &[])
        };
        let rules = learn_from_entries(
            &[
                billable("PENT-1 a"),
                billable("PENT-1 b"),
                entry("PENT-1 c", Some(10), &[]),
                entry("ACME-1 x", Some(20), &[]),
                billable("ACME-1 y"),
            ],
            String::new(),
        );

        assert!(rules.by_key["PENT-1"].billable, "2 of 3 were billable");
        assert!(rules.by_key["ACME-1"].billable, "1 of 2 clears the half bar");
        assert!(!rules.by_key["PENT-1"].tags.contains(&"".to_string()));
    }

    #[test]
    fn learning_stamps_the_current_rules_version() {
        let rules = learn_from_entries(&[entry("PENT-1 a", Some(10), &[])], String::new());
        assert_eq!(rules.version, RULES_VERSION);
    }

    #[test]
    fn rules_cached_before_versioning_parse_as_version_zero() {
        // A file written before `billable` existed must still load — and be
        // recognisable as stale.
        let legacy = r#"{"byKey":{},"byPrefix":{},"recurring":[],"entriesScanned":42,"learnedAt":"2026-07-30T08:00:00Z"}"#;
        let rules: LearnedRules = serde_json::from_str(legacy).expect("legacy rules must parse");
        assert_eq!(rules.version, 0);
        assert_eq!(rules.entries_scanned, 42);
        assert!(rules.version < RULES_VERSION);
    }

    #[test]
    fn non_billable_history_stays_non_billable() {
        let rules = learn_from_entries(
            &[entry("PENT-9 a", Some(10), &[]), entry("PENT-9 b", Some(10), &[])],
            String::new(),
        );
        assert!(!rules.by_key["PENT-9"].billable);
    }

    #[test]
    fn rare_tags_are_not_replayed() {
        let entries = vec![
            entry("PENT-1 a", Some(10), &["urgent"]),
            entry("PENT-1 b", Some(10), &[]),
            entry("PENT-1 c", Some(10), &[]),
        ];
        let rules = learn_from_entries(&entries, String::new());

        assert!(rules.by_key["PENT-1"].tags.is_empty());
    }
}
