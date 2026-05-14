use std::collections::HashMap;
use parking_lot::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::{AppSettings, ChecklistItem, MatchStrategy};

static JIRA_KEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Z][A-Z0-9]+-\d+\b").unwrap());

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct JiraIssueSummary {
    pub key: String,
    pub summary: String,
    pub priority: String,
    pub status: String,
    pub issue_type: String,
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

/// Extracts every Jira key found in `text`, preserving left-to-right order.
pub fn extract_all_jira_keys(text: &str) -> Vec<String> {
    JIRA_KEY_RE.find_iter(text).map(|m| m.as_str().to_string()).collect()
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
#[serde(rename_all = "camelCase")]
struct JiraSearchResponse {
    issues: Vec<JiraIssueResponse>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    is_last: Option<bool>,
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
    issuetype: Option<JiraIssueTypeField>,
    #[serde(rename = "fixVersions")]
    fix_versions: Option<Vec<JiraFixVersion>>,
}

#[derive(Debug, Deserialize)]
struct JiraIssueTypeField {
    name: Option<String>,
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
        issue_type: issue
            .fields
            .issuetype
            .as_ref()
            .and_then(|t| t.name.clone())
            .unwrap_or_default(),
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

// ── Checklist field discovery ─────────────────────────────────────────────────

// Bump this when the discovery logic changes to invalidate stale caches.
const CHECKLIST_CACHE_VERSION: &str = "v3";

static CHECKLIST_FIELD_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Deserialize)]
struct JiraField {
    id: String,
    name: String,
    #[serde(default)]
    custom: bool,
}

async fn discover_checklist_field(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<String> {
    {
        let cache_key = format!("{}::{}", CHECKLIST_CACHE_VERSION, settings.jira_base_url);
        let cache = CHECKLIST_FIELD_CACHE.lock();
        if let Some(cached) = cache.get(&cache_key) {
            return cached.clone();
        }
    }

    let url = format!("{}/rest/api/3/field", settings.jira_base_url);
    let resp = client
        .get(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await;

    let fields: Vec<JiraField> = match resp {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[zugit][jira] discover_checklist_field: failed to parse field list: {e}");
                return None;
            }
        },
        Err(e) => {
            eprintln!("[zugit][jira] discover_checklist_field: request failed: {e}");
            return None;
        }
    };

    let checklist_fields: Vec<&JiraField> = fields
        .iter()
        .filter(|f| f.custom && f.name.to_lowercase().contains("checklist"))
        .collect();

    // Pick the writable text field in priority order:
    // 1. Exact "Checklist Text" (no qualifier)
    // 2. Any field with "text" but not "view"
    // 3. First checklist field that isn't view-only
    // 4. Whatever is first
    let found = checklist_fields
        .iter()
        .find(|f| f.name.to_lowercase() == "checklist text")
        .or_else(|| checklist_fields.iter().find(|f| {
            let n = f.name.to_lowercase();
            n.contains("text") && !n.contains("view")
        }))
        .or_else(|| checklist_fields.iter().find(|f| !f.name.to_lowercase().contains("view")))
        .or_else(|| checklist_fields.first())
        .map(|f| f.id.clone());

    let cache_key = format!("{}::{}", CHECKLIST_CACHE_VERSION, settings.jira_base_url);
    CHECKLIST_FIELD_CACHE.lock().insert(cache_key, found.clone());
    found
}

// ── ADF helpers ───────────────────────────────────────────────────────────────

/// Extracts plain checklist text from a Jira field that may be:
/// - a plain string (view-only field / v2 API)
/// - an ADF paragraph wrapping our plain text (written by us)
/// - a structured ADF document where Herocoders converted lists:
///   orderedList  → section headers  → reconstructed as "# text"
///   bulletList   → checklist items  → reconstructed as "* text"
fn extract_checklist_text(value: &serde_json::Value) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }

    let mut lines: Vec<String> = Vec::new();

    if let Some(blocks) = value["content"].as_array() {
        for block in blocks {
            match block["type"].as_str() {
                Some("orderedList") => {
                    for item in adf_list_items(block) {
                        let text = adf_list_item_text(item);
                        if !text.trim().is_empty() {
                            lines.push(format!("# {}", text.trim()));
                        }
                    }
                }
                Some("bulletList") => {
                    for item in adf_list_items(block) {
                        let text = adf_list_item_text(item);
                        if !text.trim().is_empty() {
                            lines.push(format!("* {}", text.trim()));
                        }
                    }
                }
                Some("paragraph") => {
                    // Plain paragraph — either legacy or our own write
                    let text = adf_inline_text(&block["content"]);
                    // May contain multiple lines if Herocoders stored plain text here
                    for line in text.lines() {
                        lines.push(line.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    lines.join("\n")
}

fn adf_list_items(list_node: &serde_json::Value) -> &[serde_json::Value] {
    list_node["content"].as_array().map(|v| v.as_slice()).unwrap_or(&[])
}

fn adf_list_item_text(item: &serde_json::Value) -> String {
    // listItem → [ paragraph | other block ]* → collect all inline text
    item["content"]
        .as_array()
        .iter()
        .flat_map(|ps| ps.iter())
        .map(|p| adf_inline_text(&p["content"]))
        .collect::<Vec<_>>()
        .join(" ")
}

fn adf_inline_text(content: &serde_json::Value) -> String {
    content
        .as_array()
        .iter()
        .flat_map(|nodes| nodes.iter())
        .filter_map(|n| n["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}

/// Wraps a plain-text checklist string in an ADF paragraph document.
fn checklist_text_to_adf(text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "doc",
        "version": 1,
        "content": [{
            "type": "paragraph",
            "content": [{ "type": "text", "text": text }]
        }]
    })
}

// ── Checklist parse / serialize ───────────────────────────────────────────────

fn parse_checklist(raw: &str) -> Vec<ChecklistItem> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with(">>") || line.starts_with('#') {
                return None;
            }
            let rest = line.strip_prefix('*').map(|s| s.trim()).unwrap_or(line);

            // Herocoders bracket format: * [done] / * [open] / * [ ]
            if let Some(after) = rest.strip_prefix("[done]") {
                return Some(ChecklistItem { text: after.trim().to_string(), done: true });
            }
            if let Some(after) = rest.strip_prefix("[open]") {
                return Some(ChecklistItem { text: after.trim().to_string(), done: false });
            }
            if let Some(after) = rest.strip_prefix("[ ]") {
                return Some(ChecklistItem { text: after.trim().to_string(), done: false });
            }

            Some(ChecklistItem { text: rest.to_string(), done: false })
        })
        .collect()
}

fn serialize_checklist(items: &[ChecklistItem]) -> String {
    items
        .iter()
        .map(|item| {
            let status = if item.done { "[done]" } else { "[open]" };
            format!("* {} {}", status, item.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ── Public: fetch checklist ───────────────────────────────────────────────────

pub async fn fetch_checklist(
    issue_key: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<ChecklistItem> {
    let field_id = match discover_checklist_field(settings, client).await {
        Some(id) => id,
        None => {
            eprintln!("[zugit][jira] fetch_checklist {issue_key}: no checklist field found, skipping");
            return vec![];
        }
    };

    let url = format!(
        "{}/rest/api/3/issue/{}?fields={}",
        settings.jira_base_url, issue_key, field_id
    );
    let resp = match client
        .get(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[zugit][jira] fetch_checklist {issue_key}: request failed: {e}");
            return vec![];
        }
    };

    let status = resp.status();
    let value: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[zugit][jira] fetch_checklist {issue_key}: failed to parse response (HTTP {status}): {e}");
            return vec![];
        }
    };

    let raw = extract_checklist_text(&value["fields"][&field_id]);
    parse_checklist(&raw)
}

// ── Public: write checklist ───────────────────────────────────────────────────

pub async fn write_checklist(
    issue_key: &str,
    items: &[ChecklistItem],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let field_id = match discover_checklist_field(settings, client).await {
        Some(id) => id,
        None => {
            eprintln!("[zugit][jira] write_checklist {issue_key}: no checklist field, skipping");
            return Ok(());
        }
    };
    let payload = serialize_checklist(items);
    let put_url = format!("{}/rest/api/3/issue/{}", settings.jira_base_url, issue_key);
    client
        .put(&put_url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&serde_json::json!({ "fields": { field_id: checklist_text_to_adf(&payload) } }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Public: complete story (mark all done + transition) ───────────────────────

#[derive(Debug, Deserialize)]
struct JiraTransition {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct JiraTransitionsResponse {
    transitions: Vec<JiraTransition>,
}

#[derive(Serialize)]
struct TransitionPayload {
    transition: TransitionId,
}

#[derive(Serialize)]
struct TransitionId {
    id: String,
}

pub async fn complete_jira_story(
    issue_key: &str,
    items: &[ChecklistItem],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    // 1. Write checklist with all items marked done.
    if !items.is_empty() {
        let all_done: Vec<ChecklistItem> = items
            .iter()
            .map(|i| ChecklistItem { text: i.text.clone(), done: true })
            .collect();
        write_checklist(issue_key, &all_done, settings, client).await?;
    }

    // 2. Transition the issue.
    transition_issue(issue_key, &settings.jira_merge_transition.clone(), settings, client).await
}

/// Transitions a Jira issue to the given workflow state by name.
/// No checklist is touched — use `complete_jira_story` when checklist marking is needed.
pub async fn transition_issue(
    issue_key: &str,
    transition_name: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let transitions_url = format!(
        "{}/rest/api/3/issue/{}/transitions",
        settings.jira_base_url, issue_key
    );
    let get_resp = client
        .get(&transitions_url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let get_status = get_resp.status();
    if !get_status.is_success() {
        let body = get_resp.text().await.unwrap_or_default();
        return Err(format!("Failed to fetch transitions for {} ({get_status}): {body}", issue_key));
    }

    let resp: JiraTransitionsResponse = get_resp.json().await.map_err(|e| e.to_string())?;

    let available: Vec<&str> = resp.transitions.iter().map(|t| t.name.as_str()).collect();

    let target = transition_name.to_lowercase();
    let transition_id = resp
        .transitions
        .iter()
        .find(|t| t.name.to_lowercase() == target)
        .map(|t| t.id.clone())
        .ok_or_else(|| {
            format!("Jira transition '{}' not found in {:?}", transition_name, available)
        })?;

    let post_resp = client
        .post(&transitions_url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&TransitionPayload { transition: TransitionId { id: transition_id } })
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = post_resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body = post_resp.text().await.unwrap_or_default();
    Err(format!("Jira transition '{}' failed ({status}): {body}", transition_name))
}

// ── Release diff helpers ──────────────────────────────────────────────────────

/// Fetches all Jira issues for a given fixVersion AND any merged PR keys in one JQL call.
pub async fn fetch_release_issues(
    fix_version: &str,
    merged_keys: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<JiraIssueSummary>, String> {
    let escaped = fix_version.replace('"', "\\\"");
    let jql = if merged_keys.is_empty() {
        format!("fixVersion = \"{}\"", escaped)
    } else {
        let keys_list = merged_keys
            .iter()
            .map(|k| format!("\"{}\"", k))
            .collect::<Vec<_>>()
            .join(", ");
        format!("fixVersion = \"{}\" OR issueKey in ({})", escaped, keys_list)
    };

    let search_jql_url = format!("{}/rest/api/3/search/jql", settings.jira_base_url);
    let max_results = 100;
    let first_body = serde_json::json!({
        "jql": jql,
        "fields": ["summary", "status", "fixVersions", "issuetype"],
        "maxResults": max_results,
    });

    let resp = client
        .post(&search_jql_url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&first_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();

    // Fall back to the older search endpoint if jql endpoint not available.
    if status == 404 || status == 405 || status == 410 {
        let mut all = Vec::new();
        let mut start_at = 0;
        loop {
            let body2 = serde_json::json!({
                "jql": jql,
                "fields": ["summary", "status", "fixVersions", "issuetype"],
                "maxResults": max_results,
                "startAt": start_at,
            });
            let resp2 = client
                .post(format!("{}/rest/api/3/search", settings.jira_base_url))
                .basic_auth(&settings.jira_email, Some(&settings.jira_token))
                .json(&body2)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !resp2.status().is_success() {
                return Err(format!("Jira search failed ({})", resp2.status()));
            }
            let parsed: JiraSearchResponse = resp2.json().await.map_err(|e| e.to_string())?;
            let count = parsed.issues.len();
            all.extend(parsed.issues.iter().map(map_issue));
            if count < max_results {
                break;
            }
            start_at += max_results;
        }
        return Ok(all);
    }

    if !status.is_success() {
        return Err(format!("Jira search failed ({})", status));
    }

    let mut all = Vec::new();
    let mut parsed: JiraSearchResponse = resp.json().await.map_err(|e| e.to_string())?;
    loop {
        all.extend(parsed.issues.iter().map(map_issue));

        let Some(next_page_token) = parsed.next_page_token.clone() else {
            break;
        };
        if parsed.is_last == Some(true) {
            break;
        }

        let body = serde_json::json!({
            "jql": jql,
            "fields": ["summary", "status", "fixVersions", "issuetype"],
            "maxResults": max_results,
            "nextPageToken": next_page_token,
        });
        let resp = client
            .post(&search_jql_url)
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Jira search failed ({})", resp.status()));
        }
        parsed = resp.json().await.map_err(|e| e.to_string())?;
    }

    Ok(all)
}

/// Paginated response wrapper for `/rest/api/3/project/{key}/version`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraVersionPage {
    values: Vec<JiraVersionEntry>,
    #[serde(default)]
    is_last: bool,
}

#[derive(Debug, Deserialize)]
struct JiraVersionEntry {
    name: Option<String>,
    #[serde(rename = "releaseDate")]
    release_date: Option<String>,
    #[serde(default)]
    released: bool,
    #[serde(default)]
    archived: bool,
}

/// Returns unreleased fixVersion names for a Jira project, sorted by releaseDate ascending
/// (versions without a date go last). Uses the paginated `/version` endpoint with
/// `status=unreleased` so Jira does the filtering, and walks all pages.
pub async fn fetch_project_versions(
    project_key: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<String> {
    let base_url = format!(
        "{}/rest/api/3/project/{}/version",
        settings.jira_base_url, project_key
    );

    let mut all: Vec<JiraVersionEntry> = vec![];
    let mut start_at: u32 = 0;
    let max_results: u32 = 50;

    loop {
        let resp = client
            .get(&base_url)
            .query(&[
                ("status", "unreleased"),
                ("startAt", &start_at.to_string()),
                ("maxResults", &max_results.to_string()),
            ])
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .send()
            .await;

        let resp = match resp {
            Ok(r) if r.status().is_success() => r,
            Ok(_) => break,
            Err(_) => break,
        };

        let page: JiraVersionPage = match resp.json().await {
            Ok(p) => p,
            Err(_) => break,
        };

        let is_last = page.is_last || page.values.len() < max_results as usize;
        all.extend(page.values);
        if is_last { break; }
        start_at += max_results;
    }

    // Sort: versions with a releaseDate ascending, undated ones last.
    all.sort_by(|a, b| {
        let ad = a.release_date.as_deref().unwrap_or("9999");
        let bd = b.release_date.as_deref().unwrap_or("9999");
        ad.cmp(bd)
    });

    let versions: Vec<String> = all
        .into_iter()
        .filter(|v| !v.released && !v.archived)
        .filter_map(|v| v.name)
        .collect();

    versions
}

/// Updates the fixVersion of a Jira issue to exactly the given target version.
pub async fn move_fix_version(
    key: &str,
    target_version: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let url = format!("{}/rest/api/3/issue/{}", settings.jira_base_url, key);
    let body = serde_json::json!({
        "update": {
            "fixVersions": [{ "set": [{ "name": target_version }] }]
        }
    });

    let resp = client
        .put(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() || resp.status().as_u16() == 204 {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("Failed to move {key} to {target_version} ({status}): {text}"))
    }
}

/// Removes all fixVersions from the given Jira issue (drop from any release).
pub async fn drop_fix_version(
    key: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let url = format!("{}/rest/api/3/issue/{}", settings.jira_base_url, key);
    let body = serde_json::json!({
        "update": {
            "fixVersions": [{ "set": [] }]
        }
    });

    let resp = client
        .put(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() || resp.status().as_u16() == 204 {
        Ok(())
    } else {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("Failed to drop fix version for {key} ({status}): {text}"))
    }
}
