use std::collections::HashMap;
use parking_lot::Mutex;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::{ApiError, AppSettings, ChecklistItem, MatchStrategy};

static JIRA_KEY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b[A-Z][A-Z0-9]+-\d+\b").unwrap());

// ── Public types ──────────────────────────────────────────────────────────────

/// A single Jira fix version (name + optional release date). A Jira issue can
/// carry several of these — `JiraIssueSummary::releases` preserves the whole set.
#[derive(Debug, Clone)]
pub struct FixVersion {
    pub name: String,
    pub release_date: Option<String>,
}

/// The issue's parent story/epic — the field Italian Jira sites label
/// "Principale". `key` is absent when the value comes from a plain-text or
/// option custom field rather than an issue link.
#[derive(Debug, Clone)]
pub struct EpicRef {
    pub key: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct JiraIssueSummary {
    pub key: String,
    pub summary: String,
    pub priority: String,
    pub status: String,
    pub issue_type: String,
    /// All fix versions assigned to the issue, sorted "primary first" (the
    /// version with the most imminent release date; undated ones go last).
    pub releases: Vec<FixVersion>,
    pub assignee: Option<String>,
    /// Parent epic, when the epic field was requested and the issue has one.
    pub epic: Option<EpicRef>,
}

impl JiraIssueSummary {
    /// The primary fix version — the first entry, i.e. the most imminent release.
    pub fn primary(&self) -> Option<&FixVersion> {
        self.releases.first()
    }

    /// True when one of the issue's fix versions matches `name`.
    pub fn has_release(&self, name: &str) -> bool {
        self.releases.iter().any(|v| v.name == name)
    }

    /// Names of all fix versions, primary first.
    pub fn release_names(&self) -> Vec<String> {
        self.releases.iter().map(|v| v.name.clone()).collect()
    }
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

/// Removes every Jira key from `text`. Used when grouping Toggl descriptions by
/// "what kind of activity is this", where the key is noise.
pub fn strip_jira_keys(text: &str) -> String {
    JIRA_KEY_RE.replace_all(text, " ").to_string()
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
    #[serde(default)]
    parent: Option<serde_json::Value>,
    /// Everything else Jira returned — the epic field id is discovered at
    /// runtime, so it can't be named statically.
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
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

/// Reads an epic reference out of a raw Jira field value. Tolerant by design —
/// depending on the site the "Principale" field is an issue link (`{key, fields:
/// {summary}}`), a select option (`{value}`), or plain text.
fn epic_from_value(value: &serde_json::Value) -> Option<EpicRef> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => {
            let s = s.trim();
            (!s.is_empty()).then(|| EpicRef { key: None, name: s.to_string() })
        }
        serde_json::Value::Array(items) => items.iter().find_map(epic_from_value),
        serde_json::Value::Object(_) => {
            let key = value["key"].as_str().map(|s| s.to_string());
            let name = ["summary", "name", "value", "displayName", "text"]
                .iter()
                .find_map(|f| value["fields"][f].as_str().or_else(|| value[*f].as_str()))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            match (name, key) {
                (Some(name), key) => Some(EpicRef { key, name }),
                // An issue link with no summary requested: fall back to the key.
                (None, Some(key)) => Some(EpicRef { name: key.clone(), key: Some(key) }),
                (None, None) => None,
            }
        }
        _ => None,
    }
}

/// Picks the epic from the discovered field id, falling back to the standard
/// `parent` field (which is what "Principale" resolves to on Italian sites).
fn extract_epic(fields: &JiraFields, epic_field_id: Option<&str>) -> Option<EpicRef> {
    epic_field_id
        .filter(|id| *id != "parent")
        .and_then(|id| fields.extra.get(id))
        .and_then(epic_from_value)
        .or_else(|| fields.parent.as_ref().and_then(epic_from_value))
}

fn map_issue(issue: &JiraIssueResponse) -> JiraIssueSummary {
    map_issue_with_epic(issue, None)
}

fn map_issue_with_epic(issue: &JiraIssueResponse, epic_field_id: Option<&str>) -> JiraIssueSummary {
    // Keep every fix version, sorted "primary first": dated versions ascending
    // (most imminent release first), undated ones last. Mirrors the ordering
    // used by `fetch_project_versions`.
    let mut releases: Vec<FixVersion> = issue
        .fields
        .fix_versions
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| {
            v.name.as_ref().map(|name| FixVersion {
                name: name.clone(),
                release_date: v.release_date.clone(),
            })
        })
        .collect();
    releases.sort_by(|a, b| {
        let ad = a.release_date.as_deref().unwrap_or("9999");
        let bd = b.release_date.as_deref().unwrap_or("9999");
        ad.cmp(bd)
    });

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
        releases,
        assignee: issue
            .fields
            .assignee
            .as_ref()
            .and_then(|a| a.display_name.clone()),
        epic: extract_epic(&issue.fields, epic_field_id),
    }
}

fn cache_key(base_url: &str, issue_key: &str) -> String {
    format!("{}::{}", base_url, issue_key)
}

// ── API base resolution ───────────────────────────────────────────────────────

const ATLASSIAN_GATEWAY: &str = "https://api.atlassian.com/ex/jira";

/// Resolved REST base per (site, email, token fingerprint). Classic API tokens
/// talk to the site itself; tokens created "with scopes" are rejected there
/// (401) and only work through the platform gateway
/// `api.atlassian.com/ex/jira/{cloudId}` — still with email + token Basic auth.
static API_BASE_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn api_base_cache_key(settings: &AppSettings) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(settings.jira_token.as_bytes());
    let fingerprint: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("{}::{}::{}", settings.jira_base_url, settings.jira_email, fingerprint)
}

/// The site's Atlassian cloud id, read from the unauthenticated tenant endpoint.
async fn fetch_cloud_id(site: &str, client: &reqwest::Client) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TenantInfo {
        cloud_id: String,
    }
    let resp = client.get(format!("{site}/_edge/tenant_info")).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<TenantInfo>().await.ok().map(|info| info.cloud_id)
}

async fn probe_myself(base: &str, settings: &AppSettings, client: &reqwest::Client) -> Option<u16> {
    client
        .get(format!("{base}/rest/api/3/myself"))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
        .ok()
        .map(|resp| resp.status().as_u16())
}

/// Base URL for Jira REST calls (`{base}/rest/api/3/...`). Browse links keep
/// using `settings.jira_base_url`. The token type is detected on first use: a
/// 401 from the site that the gateway does not repeat means a scoped token.
/// Transient failures fall back to the site URL without caching, so the next
/// call retries the detection.
async fn api_base(settings: &AppSettings, client: &reqwest::Client) -> String {
    let site = settings.jira_base_url.as_str();
    // Scoped tokens exist only on Jira Cloud; self-hosted sites (and a gateway
    // URL entered by hand) are used as they are.
    let is_cloud_site = reqwest::Url::parse(site)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.ends_with(".atlassian.net")))
        .unwrap_or(false);
    if !is_cloud_site {
        return site.to_string();
    }
    let key = api_base_cache_key(settings);
    if let Some(cached) = API_BASE_CACHE.lock().get(&key) {
        return cached.clone();
    }

    let resolved = match probe_myself(site, settings, client).await {
        Some(401) => match fetch_cloud_id(site, client).await {
            Some(cloud_id) => {
                let gateway = format!("{ATLASSIAN_GATEWAY}/{cloud_id}");
                // A scoped token without `read:jira-user` gets 403 on /myself:
                // the gateway still accepted it, so it is the right base.
                match probe_myself(&gateway, settings, client).await {
                    Some(401) => Some(site.to_string()),
                    Some(_) => Some(gateway),
                    None => None,
                }
            }
            None => None,
        },
        Some(_) => Some(site.to_string()),
        None => None,
    };

    match resolved {
        Some(base) => {
            API_BASE_CACHE.lock().insert(key, base.clone());
            base
        }
        None => site.to_string(),
    }
}

// ── Public fetch ──────────────────────────────────────────────────────────────

/// Lightweight credential probe: `GET /rest/api/3/myself` validates the email +
/// token pair without depending on any particular issue existing. Used by the
/// dashboard to detect an expired/invalid Jira token (HTTP 401) up front, so the
/// user gets a clear re-authenticate prompt instead of silently-missing enrichment.
pub async fn verify_credentials(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), ApiError> {
    let url = format!("{}/rest/api/3/myself", api_base(settings, client).await);
    let response = client
        .get(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;

    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    Err(ApiError::from_status(
        status.as_u16(),
        format!("Jira authentication failed ({status})"),
    ))
}

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

    // Always fetch fresh: issue fields (fixVersions above all) change on the Jira
    // side, and serving them from the cache would keep a story grouped under its
    // old release until the cache happens to be cleared. The cache is only a
    // fallback for keys Jira could not answer for this time.
    for chunk in unique_keys.chunks(50) {
        if let Err(e) = fetch_chunk(chunk, settings, cache, client, &mut result).await {
            // Log but don't fail the whole dashboard.
            eprintln!("[zugit][jira] chunk fetch error: {}", e);
        }
    }

    for key in &unique_keys {
        if result.contains_key(key) {
            continue;
        }
        let ck = cache_key(&settings.jira_base_url, key);
        if let Some(cached) = cache.lock().get(&ck).cloned() {
            result.insert(key.clone(), cached);
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
        .post(format!("{}/rest/api/3/search/jql", api_base(settings, client).await))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();

    // Fall back to individual fetches for tenants that don't support JQL search.
    if status == 404 || status == 405 || status == 410 {
        for key in keys {
            if let Some(individual) = fetch_single_issue(key, settings, cache, client).await {
                result.insert(key.clone(), individual);
            }
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

/// Outer `None` means Jira could not answer (network/HTTP error), so the caller
/// may fall back to the cache; `Some(None)` means the issue does not exist.
async fn fetch_single_issue(
    key: &str,
    settings: &AppSettings,
    cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
) -> Option<Option<JiraIssueSummary>> {
    let url = format!(
        "{}/rest/api/3/issue/{}?fields=summary,priority,status,fixVersions,assignee",
        api_base(settings, client).await, key
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
        return Some(None);
    }

    if !response.status().is_success() {
        return None;
    }

    let issue: JiraIssueResponse = response.json().await.ok()?;
    let summary = map_issue(&issue);
    let ck = cache_key(&settings.jira_base_url, key);
    cache.lock().insert(ck, Some(summary.clone()));
    Some(Some(summary))
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

    let url = format!("{}/rest/api/3/field", api_base(settings, client).await);
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

// ── Epic ("Principale") field discovery ───────────────────────────────────────

static EPIC_FIELD_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Resolves the field that holds the story's epic. Italian Jira sites label the
/// built-in `parent` field "Principale", but a site may also define a custom
/// field with that name — so we match by name first and only then fall back to
/// `parent`, which is always present.
pub async fn discover_epic_field(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<String> {
    {
        let cache = EPIC_FIELD_CACHE.lock();
        if let Some(cached) = cache.get(&settings.jira_base_url) {
            return cached.clone();
        }
    }

    let url = format!("{}/rest/api/3/field", api_base(settings, client).await);
    let fields: Vec<JiraField> = match client
        .get(&url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[zugit][jira] discover_epic_field: failed to parse field list: {e}");
                return Some("parent".to_string());
            }
        },
        Err(e) => {
            eprintln!("[zugit][jira] discover_epic_field: request failed: {e}");
            return Some("parent".to_string());
        }
    };

    // Preference order: the exact site label, its longer variant, the English
    // equivalents, then the built-in parent field.
    let by_name = |wanted: &str| -> Option<String> {
        fields
            .iter()
            .find(|f| f.name.trim().eq_ignore_ascii_case(wanted))
            .map(|f| f.id.clone())
    };
    let found = by_name("Principale")
        .or_else(|| by_name("Elemento principale"))
        .or_else(|| by_name("Parent"))
        .or_else(|| by_name("Epic Link"))
        .or_else(|| by_name("Collegamento epica"))
        .or(Some("parent".to_string()));

    EPIC_FIELD_CACHE
        .lock()
        .insert(settings.jira_base_url.clone(), found.clone());
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
        api_base(settings, client).await, issue_key, field_id
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
    let put_url = format!("{}/rest/api/3/issue/{}", api_base(settings, client).await, issue_key);
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
        // Give Jira a moment to settle the checklist write before transitioning.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
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
        api_base(settings, client).await, issue_key
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

    // Release notes group by epic, so the "Principale" field travels with every issue.
    let epic_field = discover_epic_field(settings, client).await;
    let epic_field_id = epic_field.as_deref();
    let mut requested_fields = vec!["summary", "status", "fixVersions", "issuetype", "parent"];
    if let Some(id) = epic_field_id.filter(|id| *id != "parent") {
        requested_fields.push(id);
    }
    let map = |issue: &JiraIssueResponse| map_issue_with_epic(issue, epic_field_id);

    let search_jql_url = format!("{}/rest/api/3/search/jql", api_base(settings, client).await);
    let max_results = 100;
    let first_body = serde_json::json!({
        "jql": jql,
        "fields": requested_fields,
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
                "fields": requested_fields,
                "maxResults": max_results,
                "startAt": start_at,
            });
            let resp2 = client
                .post(format!("{}/rest/api/3/search", api_base(settings, client).await))
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
            all.extend(parsed.issues.iter().map(map));
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
        all.extend(parsed.issues.iter().map(map));

        let Some(next_page_token) = parsed.next_page_token.clone() else {
            break;
        };
        if parsed.is_last == Some(true) {
            break;
        }

        let body = serde_json::json!({
            "jql": jql,
            "fields": requested_fields,
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
        api_base(settings, client).await, project_key
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

/// Moves a Jira issue from `from` to `to`, preserving any other fix versions.
///
/// When `from` is given (and differs from `to`) the issue's other versions are
/// kept: only `from` is removed and `to` is added. When `from` is `None` (e.g.
/// adopting an Extra story into a release) `to` is simply added alongside the
/// existing versions. A `remove` for a version the issue doesn't have is a
/// harmless no-op on Jira's side.
pub async fn move_fix_version(
    key: &str,
    from: Option<&str>,
    to: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let url = format!("{}/rest/api/3/issue/{}", api_base(settings, client).await, key);
    let mut ops = Vec::new();
    if let Some(from) = from {
        if from != to {
            ops.push(serde_json::json!({ "remove": { "name": from } }));
        }
    }
    ops.push(serde_json::json!({ "add": { "name": to } }));
    let body = serde_json::json!({
        "update": {
            "fixVersions": ops
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
        Err(format!("Failed to move {key} to {to} ({status}): {text}"))
    }
}

// ── Active work (Toggl) ───────────────────────────────────────────────────────

/// A story the viewer is currently working on, with the moment it entered its
/// current status — that timestamp is what lets the day be split between "the
/// story I closed this morning" and "the one I picked up after".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub issue_type: String,
    pub url: String,
    /// RFC3339 timestamp of the last status transition, when the changelog has one.
    pub status_changed_at: Option<String>,
    /// "in-progress" | "merge-request" | "other" — drives the default priority.
    pub stage: String,
}

/// Result of the active-work lookup, plus whether the open-sprint filter was
/// actually applied — the panel warns when it wasn't.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveIssues {
    pub issues: Vec<ActiveIssue>,
    pub sprint_scoped: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraChangelogPage {
    #[serde(default)]
    values: Vec<JiraChangelogEntry>,
    #[serde(default)]
    total: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraChangelogEntry {
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    author: Option<JiraChangelogAuthor>,
    #[serde(default)]
    items: Vec<JiraChangelogItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraChangelogAuthor {
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct JiraChangelogItem {
    #[serde(default)]
    field: Option<String>,
    #[serde(default, rename = "toString")]
    to_status: Option<String>,
}

impl JiraChangelogEntry {
    fn status_item(&self) -> Option<&JiraChangelogItem> {
        self.items
            .iter()
            .find(|item| item.field.as_deref() == Some("status"))
    }
}

const CHANGELOG_PAGE: u32 = 100;

/// The newest page of an issue's changelog (oldest-first within the page).
///
/// Long-lived stories easily pass 100 changes, and the first page alone would
/// then miss exactly the recent transitions the planner cares about — so when
/// the total says there is more, the last page is fetched instead.
async fn fetch_changelog_tail(
    key: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<Vec<JiraChangelogEntry>> {
    let api = api_base(settings, client).await;
    let fetch = |start_at: u32| {
        let url = format!(
            "{api}/rest/api/3/issue/{key}/changelog?maxResults={CHANGELOG_PAGE}&startAt={start_at}"
        );
        client
            .get(url)
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .send()
    };

    let resp = fetch(0).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let page: JiraChangelogPage = resp.json().await.ok()?;
    let total = page.total.unwrap_or(0);
    if total <= CHANGELOG_PAGE {
        return Some(page.values);
    }

    let resp = fetch(total - CHANGELOG_PAGE).await.ok()?;
    if !resp.status().is_success() {
        return Some(page.values);
    }
    resp.json::<JiraChangelogPage>()
        .await
        .ok()
        .map(|tail| tail.values)
        .or(Some(page.values))
}

/// Timestamp of the most recent status transition for an issue, or `None` when
/// the changelog is empty or unreadable (the caller degrades to "unknown since").
async fn fetch_last_status_change(
    key: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<String> {
    let entries = fetch_changelog_tail(key, settings, client).await?;
    entries
        .iter()
        .filter(|entry| entry.status_item().is_some())
        .filter_map(|entry| entry.created.clone())
        .next_back()
}

/// The viewer's Atlassian account id — changelog authors are identified by it.
async fn fetch_my_account_id(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, ApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Myself {
        account_id: String,
    }

    let resp = client
        .get(format!("{}/rest/api/3/myself", api_base(settings, client).await))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(ApiError::from_status(
            status.as_u16(),
            format!("Jira /myself failed ({status})"),
        ));
    }
    resp.json::<Myself>()
        .await
        .map(|me| me.account_id)
        .map_err(|e| ApiError::Other(e.to_string()))
}

/// A status change the viewer made by hand during the planned day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyTransition {
    pub key: String,
    /// RFC3339, as Jira returns it.
    pub at: String,
    /// Name of the status the story was moved into ("Developed", "Merge Request"…).
    pub to_status: String,
}

/// Every story whose status the viewer changed during `[from, to)`, with the
/// transitions themselves.
///
/// This is what catches the stories that never show up as "in progress": the
/// one moved straight to Developed, the one dragged out of To Do at the end of
/// the day, the merge request that got a quick fix and went back. Deliberately
/// not limited to `assignee = currentUser()`: moving a story to Developed often
/// hands it over to QA, and it would vanish from the search at that very moment.
pub async fn fetch_my_transitions(
    from: chrono::DateTime<chrono::Local>,
    to: chrono::DateTime<chrono::Local>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(Vec<JiraIssueSummary>, Vec<MyTransition>), ApiError> {
    // JQL dates are minute-precise and read in the Jira profile's timezone,
    // which is the local one for practically everyone.
    let jql = format!(
        "status CHANGED BY currentUser() DURING (\"{}\", \"{}\") ORDER BY updated DESC",
        from.format("%Y/%m/%d %H:%M"),
        to.format("%Y/%m/%d %H:%M"),
    );
    let (issues, me) = futures::future::join(
        search_issues(&jql, settings, client),
        fetch_my_account_id(settings, client),
    )
    .await;
    let issues = issues?;
    let me = me?;

    let changelogs = futures::future::join_all(
        issues
            .iter()
            .map(|issue| fetch_changelog_tail(&issue.key, settings, client)),
    )
    .await;

    let from_utc = from.with_timezone(&chrono::Utc);
    let to_utc = to.with_timezone(&chrono::Utc);
    let mut transitions = Vec::new();
    for (issue, changelog) in issues.iter().zip(changelogs) {
        for entry in changelog.unwrap_or_default() {
            let Some(item) = entry.status_item() else { continue };
            let by_me = entry
                .author
                .as_ref()
                .and_then(|author| author.account_id.as_deref())
                == Some(me.as_str());
            let Some(created) = entry.created.as_deref() else { continue };
            let Some(at) = parse_jira_datetime(created) else { continue };
            if by_me && at >= from_utc && at < to_utc {
                transitions.push(MyTransition {
                    key: issue.key.clone(),
                    at: at.to_rfc3339(),
                    to_status: item.to_status.clone().unwrap_or_default(),
                });
            }
        }
    }

    Ok((issues, transitions))
}

/// Jira writes offsets without the colon ("2026-10-01T11:02:33.120+0200"),
/// which strict RFC3339 parsing rejects.
pub fn parse_jira_datetime(value: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .or_else(|_| chrono::DateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

// ── Story points (gap filling) ────────────────────────────────────────────────

/// A story with its estimate, for filling the time no evidence explains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointedIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    /// Jira status category: "new" | "indeterminate" | "done".
    pub status_category: String,
    pub issue_type: String,
    pub points: Option<f64>,
}

/// Ids of the story-point fields. The name depends on the project type —
/// "Story Points" on company-managed boards, "Story point estimate" on
/// team-managed ones — and a tenant often has both.
async fn story_point_fields(settings: &AppSettings, client: &reqwest::Client) -> Vec<String> {
    #[derive(Deserialize)]
    struct Field {
        id: String,
        #[serde(default)]
        name: String,
    }
    let Ok(resp) = client
        .get(format!("{}/rest/api/3/field", api_base(settings, client).await))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .send()
        .await
    else {
        return vec![];
    };
    let fields: Vec<Field> = resp.json().await.unwrap_or_default();
    fields
        .into_iter()
        .filter(|field| {
            let name = field.name.trim().to_lowercase();
            name == "story points" || name == "story point estimate"
        })
        .map(|field| field.id)
        .collect()
}

/// A JQL search returning raw issues, for field sets the typed search does not cover.
async fn search_raw(
    jql: &str,
    fields: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<serde_json::Value>, ApiError> {
    let body = serde_json::json!({ "jql": jql, "fields": fields, "maxResults": 100 });
    let api = api_base(settings, client).await;
    let send = |path: &str| {
        client
            .post(format!("{api}{path}"))
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .json(&body)
            .send()
    };
    let mut resp = send("/rest/api/3/search/jql")
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;
    if matches!(resp.status().as_u16(), 404 | 405 | 410) {
        resp = send("/rest/api/3/search")
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(ApiError::from_status(status.as_u16(), format!("Jira search failed ({status})")));
    }
    let payload: serde_json::Value = resp.json().await.map_err(|e| ApiError::Other(e.to_string()))?;
    Ok(payload["issues"].as_array().cloned().unwrap_or_default())
}

fn pointed_issue(raw: &serde_json::Value, point_fields: &[String]) -> Option<PointedIssue> {
    let fields = &raw["fields"];
    let text = |value: &serde_json::Value| value.as_str().unwrap_or("").to_string();
    Some(PointedIssue {
        key: raw["key"].as_str()?.to_string(),
        summary: text(&fields["summary"]),
        status: text(&fields["status"]["name"]),
        status_category: text(&fields["status"]["statusCategory"]["key"]),
        issue_type: text(&fields["issuetype"]["name"]),
        points: point_fields
            .iter()
            .find_map(|id| fields[id.as_str()].as_f64())
            .filter(|points| *points > 0.0),
    })
}

fn pointed_field_list(point_fields: &[String]) -> Vec<String> {
    let mut fields: Vec<String> = ["summary", "status", "issuetype"].iter().map(|f| f.to_string()).collect();
    fields.extend(point_fields.iter().cloned());
    fields
}

/// The viewer's stories in the open sprints, with their estimates.
pub async fn fetch_sprint_issues(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<PointedIssue>, ApiError> {
    let point_fields = story_point_fields(settings, client).await;
    let issues = search_raw(
        "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC",
        &pointed_field_list(&point_fields),
        settings,
        client,
    )
    .await?;
    Ok(issues.iter().filter_map(|raw| pointed_issue(raw, &point_fields)).collect())
}

/// Estimates for arbitrary keys (from Toggl history). A key Jira does not know
/// fails the whole `issueKey in (…)` query, so a failing chunk is retried one
/// key at a time — this runs once a week, with the history relearn.
pub async fn fetch_points_for(
    keys: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<PointedIssue> {
    let point_fields = story_point_fields(settings, client).await;
    if point_fields.is_empty() {
        return vec![];
    }
    let fields = pointed_field_list(&point_fields);
    let query = |keys: &[String]| {
        format!(
            "issueKey in ({})",
            keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", ")
        )
    };

    let mut found = Vec::new();
    for chunk in keys.chunks(40) {
        match search_raw(&query(chunk), &fields, settings, client).await {
            Ok(issues) => found.extend(issues.iter().filter_map(|raw| pointed_issue(raw, &point_fields))),
            Err(_) => {
                for key in chunk {
                    if let Ok(issues) = search_raw(&query(std::slice::from_ref(key)), &fields, settings, client).await {
                        found.extend(issues.iter().filter_map(|raw| pointed_issue(raw, &point_fields)));
                    }
                }
            }
        }
    }
    found
}

/// Summaries for keys found in local activity (branches, commits) that are not
/// among the active stories. Keys Jira does not know are simply left out —
/// that is what filters "FEAT-2" out of a branch called `feat-2-cleanup`.
pub async fn fetch_issue_summaries(
    keys: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<JiraIssueSummary> {
    if keys.is_empty() {
        return vec![];
    }
    let cache = Mutex::new(HashMap::new());
    let mut found: Vec<JiraIssueSummary> = fetch_jira_issues(keys, settings, &cache, client)
        .await
        .into_values()
        .flatten()
        .collect();
    found.sort_by(|a, b| a.key.cmp(&b.key));
    found
}

/// Runs a JQL search for the active-work queries, falling back to the legacy
/// endpoint on tenants that don't expose `/search/jql`.
async fn search_issues(
    jql: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<JiraIssueSummary>, ApiError> {
    let fields = ["summary", "status", "issuetype"];
    let body = serde_json::json!({
        "jql": jql,
        "fields": fields,
        "maxResults": 50,
    });

    let resp = client
        .post(format!("{}/rest/api/3/search/jql", api_base(settings, client).await))
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;

    let status = resp.status();
    let parsed: JiraSearchResponse = if status == 404 || status == 405 || status == 410 {
        let legacy = client
            .post(format!("{}/rest/api/3/search", api_base(settings, client).await))
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .json(&body)
            .send()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))?;
        let legacy_status = legacy.status();
        if !legacy_status.is_success() {
            return Err(ApiError::from_status(
                legacy_status.as_u16(),
                format!("Jira search failed ({legacy_status})"),
            ));
        }
        legacy.json().await.map_err(|e| ApiError::Other(e.to_string()))?
    } else if !status.is_success() {
        return Err(ApiError::from_status(
            status.as_u16(),
            format!("Jira search failed ({status})"),
        ));
    } else {
        resp.json().await.map_err(|e| ApiError::Other(e.to_string()))?
    };

    Ok(parsed.issues.iter().map(map_issue).collect())
}

/// Without a sprint to scope by, a status alone is not evidence of current work:
/// stories forgotten in "In Progress" or "Merge Request" by QA or a PM sit there
/// for months. Only stories touched within this many days count.
const UNSCOPED_RECENT: &str = "updated >= -14d";

/// Issues assigned to the viewer in one specific status, restricted to the open
/// sprint when the tenant has sprints.
///
/// The sprint clause is dropped when Jira rejects it — projects without Jira
/// Software have no `sprint` field, and a hard failure there would leave the
/// planner with no stories at all.
async fn search_my_issues_in_status(
    status_name: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(Vec<JiraIssueSummary>, bool), ApiError> {
    let escaped = status_name.replace('"', "\\\"");
    let base = format!("assignee = currentUser() AND status = \"{escaped}\"");
    let scoped = format!("{base} AND sprint in openSprints() ORDER BY updated DESC");

    match search_issues(&scoped, settings, client).await {
        Ok(issues) => Ok((issues, true)),
        Err(error) if error.is_auth() => Err(error),
        Err(_) => search_issues(&format!("{base} AND {UNSCOPED_RECENT} ORDER BY updated DESC"), settings, client)
            .await
            .map(|issues| (issues, false)),
    }
}

/// Stories the viewer is working on: in progress, or waiting in the merge-request
/// status (the configured `jiraMergeTransition`).
///
/// One query per status, so the stage comes from the query that matched rather
/// than from the status name — Jira returns names in the user's language, and
/// "In corso" cannot be pattern-matched against "In Progress".
pub async fn fetch_my_active_issues(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<ActiveIssues, ApiError> {
    let (in_progress, merge_request) = futures::future::join(
        search_my_issues_in_status("In Progress", settings, client),
        search_my_issues_in_status(&settings.jira_merge_transition, settings, client),
    )
    .await;

    let (in_progress, in_progress_scoped) = in_progress?;
    let (merge_request, merge_scoped) = merge_request?;
    let sprint_scoped = in_progress_scoped && merge_scoped;

    // No active story in the open sprint has two very different meanings. If
    // the viewer has stories in the sprint (all Developed, Verified…), nothing
    // is active right now and that is the answer: falling back to every story
    // ever assigned would resurrect months-old ones left in "In Progress" or
    // "Merge Request". Only when the sprint holds nothing of theirs — the board
    // doesn't use sprints the way the filter assumes — fall back, and let the
    // panel say so rather than show an empty planner.
    let empty_sprint = sprint_scoped && in_progress.is_empty() && merge_request.is_empty();
    let uses_sprints = empty_sprint
        && search_issues(
            "assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC",
            settings,
            client,
        )
        .await
        .is_ok_and(|issues| !issues.is_empty());
    let (in_progress, merge_request, sprint_scoped) =
        if empty_sprint && !uses_sprints {
            let base = |status: &str| {
                format!(
                    "assignee = currentUser() AND status = \"{}\" AND {UNSCOPED_RECENT} ORDER BY updated DESC",
                    status.replace('"', "\\\"")
                )
            };
            let (a, b) = futures::future::join(
                search_issues(&base("In Progress"), settings, client),
                search_issues(&base(&settings.jira_merge_transition), settings, client),
            )
            .await;
            (a.unwrap_or_default(), b.unwrap_or_default(), false)
        } else {
            (in_progress, merge_request, sprint_scoped)
        };

    let staged: Vec<(JiraIssueSummary, &str)> = in_progress
        .into_iter()
        .map(|issue| (issue, "in-progress"))
        .chain(
            merge_request
                .into_iter()
                .map(|issue| (issue, "merge-request")),
        )
        .collect();

    // One changelog call per story — there are only ever a handful of them.
    let changes = futures::future::join_all(
        staged
            .iter()
            .map(|(issue, _)| fetch_last_status_change(&issue.key, settings, client)),
    )
    .await;

    Ok(ActiveIssues {
        issues: staged
            .into_iter()
            .zip(changes)
            .map(|((issue, stage), status_changed_at)| ActiveIssue {
                stage: stage.to_string(),
                url: format!("{}/browse/{}", settings.jira_base_url, issue.key),
                key: issue.key,
                summary: issue.summary,
                status: issue.status,
                issue_type: issue.issue_type,
                status_changed_at,
            })
            .collect(),
        sprint_scoped,
    })
}

/// Drops a Jira issue from a release. With `version = Some(v)` only that single
/// version is removed (other fixVersions are preserved); with `version = None`
/// every fixVersion is cleared (full unschedule).
pub async fn drop_fix_version(
    key: &str,
    version: Option<&str>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let url = format!("{}/rest/api/3/issue/{}", api_base(settings, client).await, key);
    let ops = match version {
        Some(v) => serde_json::json!([{ "remove": { "name": v } }]),
        None => serde_json::json!([{ "set": [] }]),
    };
    let body = serde_json::json!({
        "update": {
            "fixVersions": ops
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
