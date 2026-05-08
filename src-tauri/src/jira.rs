use std::collections::HashMap;
use parking_lot::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;

use crate::models::{AppSettings, MatchStrategy};

static JIRA_KEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Z][A-Z0-9]+-\d+\b").unwrap());

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct JiraIssueSummary {
    pub key: String,
    pub summary: String,
    pub priority: String,
    pub status: String,
    pub release: String,
    pub release_date: Option<String>,
    pub assignee: Option<String>,
}

pub struct JiraKeyMatch {
    pub key: Option<String>,
    pub strategy: MatchStrategy,
}

// ── Key extraction ────────────────────────────────────────────────────────────

pub fn extract_jira_key(text: &str) -> Option<String> {
    JIRA_KEY_RE.find(text).map(|m| m.as_str().to_string())
}

pub fn extract_jira_key_from_title(title: &str, expected_board: Option<&str>) -> JiraKeyMatch {
    let keys: Vec<String> = JIRA_KEY_RE
        .find_iter(title)
        .map(|m| m.as_str().to_string())
        .collect();

    if let Some(board) = expected_board {
        let prefix = format!("{}-", board.to_uppercase());
        if let Some(k) = keys.iter().find(|k| k.starts_with(&prefix)) {
            return JiraKeyMatch {
                key: Some(k.clone()),
                strategy: MatchStrategy::TitleBoard,
            };
        }
    }

    if let Some(k) = keys.first() {
        return JiraKeyMatch {
            key: Some(k.clone()),
            strategy: MatchStrategy::TitleAny,
        };
    }

    JiraKeyMatch {
        key: None,
        strategy: MatchStrategy::None,
    }
}

// ── Jira API response types ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct JiraSearchResponse {
    issues: Vec<JiraIssueResponse>,
}

#[derive(Debug, Deserialize)]
struct JiraIssueResponse {
    key: String,
    fields: JiraFields,
}

#[derive(Debug, Deserialize)]
struct JiraFields {
    summary: Option<String>,
    priority: Option<JiraPriorityField>,
    status: Option<JiraStatusField>,
    assignee: Option<JiraAssigneeField>,
    #[serde(rename = "fixVersions")]
    fix_versions: Option<Vec<JiraFixVersion>>,
}

#[derive(Debug, Deserialize)]
struct JiraPriorityField {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraStatusField {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraAssigneeField {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraFixVersion {
    name: Option<String>,
    #[serde(rename = "releaseDate")]
    release_date: Option<String>,
}

fn map_issue(issue: &JiraIssueResponse) -> JiraIssueSummary {
    let release = issue
        .fields
        .fix_versions
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.name.as_deref())
        .collect::<Vec<_>>()
        .join(", ");

    let release_date = issue
        .fields
        .fix_versions
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .find_map(|v| v.release_date.clone());

    JiraIssueSummary {
        key: issue.key.clone(),
        summary: issue
            .fields
            .summary
            .clone()
            .unwrap_or_else(|| "No Jira summary".to_string()),
        priority: issue
            .fields
            .priority
            .as_ref()
            .and_then(|p| p.name.clone())
            .unwrap_or_else(|| "Medium".to_string()),
        status: issue
            .fields
            .status
            .as_ref()
            .and_then(|s| s.name.clone())
            .unwrap_or_else(|| "Unknown".to_string()),
        release: if release.is_empty() {
            "Unscheduled".to_string()
        } else {
            release
        },
        release_date,
        assignee: issue
            .fields
            .assignee
            .as_ref()
            .and_then(|a| a.display_name.clone()),
    }
}

fn cache_key(base_url: &str, issue_key: &str) -> String {
    format!("{}::{}", base_url, issue_key)
}

// ── Public fetch ──────────────────────────────────────────────────────────────

pub async fn fetch_jira_issues(
    keys: &[String],
    settings: &AppSettings,
    cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
) -> HashMap<String, Option<JiraIssueSummary>> {
    let unique_keys: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        keys.iter()
            .filter(|k| !k.is_empty() && seen.insert(*k))
            .cloned()
            .collect()
    };

    let mut result: HashMap<String, Option<JiraIssueSummary>> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();

    for key in &unique_keys {
        let ck = cache_key(&settings.jira_base_url, key);
        if let Some(cached) = cache.lock().get(&ck).cloned() {
            result.insert(key.clone(), cached);
        } else {
            missing.push(key.clone());
        }
    }

    // Process in chunks of 50.
    for chunk in missing.chunks(50) {
        if let Err(e) = fetch_chunk(chunk, settings, cache, client, &mut result).await {
            // Log but don't fail the whole dashboard.
            eprintln!("[zugit][jira] chunk fetch error: {}", e);
        }
    }

    result
}

async fn fetch_chunk(
    keys: &[String],
    settings: &AppSettings,
    cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
    result: &mut HashMap<String, Option<JiraIssueSummary>>,
) -> Result<(), String> {
    let jql_keys = keys
        .iter()
        .map(|k| format!("\"{}\"", k))
        .collect::<Vec<_>>()
        .join(", ");

    let body = serde_json::json!({
        "jql": format!("issueKey in ({})", jql_keys),
        "fields": ["summary", "priority", "status", "fixVersions", "assignee"],
        "maxResults": keys.len(),
    });

    let response = client
        .post(format!("{}/rest/api/3/search/jql", settings.jira_base_url))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();

    // Fall back to individual fetches for tenants that don't support JQL search.
    if status == 404 || status == 405 || status == 410 {
        for key in keys {
            let individual = fetch_single_issue(key, settings, cache, client).await;
            result.insert(key.clone(), individual);
        }
        return Ok(());
    }

    if !status.is_success() {
        return Err(format!(
            "Jira search failed ({}) for {}",
            status,
            keys.join(", ")
        ));
    }

    let payload: JiraSearchResponse = response.json().await.map_err(|e| e.to_string())?;
    let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();

    for issue in &payload.issues {
        let summary = map_issue(issue);
        let ck = cache_key(&settings.jira_base_url, &issue.key);
        cache.lock().insert(ck, Some(summary.clone()));
        result.insert(issue.key.clone(), Some(summary));
        found.insert(issue.key.clone());
    }

    // Keys not returned by Jira don't exist.
    for key in keys {
        if !found.contains(key) {
            let ck = cache_key(&settings.jira_base_url, key);
            cache.lock().insert(ck, None);
            result.insert(key.clone(), None);
        }
    }

    Ok(())
}

async fn fetch_single_issue(
    key: &str,
    settings: &AppSettings,
    cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
) -> Option<JiraIssueSummary> {
    let url = format!(
        "{}/rest/api/3/issue/{}?fields=summary,priority,status,fixVersions,assignee",
        settings.jira_base_url, key
    );

    let response = client
        .get(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
        .ok()?;

    if response.status() == 404 {
        let ck = cache_key(&settings.jira_base_url, key);
        cache.lock().insert(ck, None);
        return None;
    }

    if !response.status().is_success() {
        return None;
    }

    let issue: JiraIssueResponse = response.json().await.ok()?;
    let summary = map_issue(&issue);
    let ck = cache_key(&settings.jira_base_url, key);
    cache.lock().insert(ck, Some(summary.clone()));
    Some(summary)
}
