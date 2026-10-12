//! Sprint board: the team's active sprint as the Jira board shows it, and the
//! quick actions of the Sprint tab — transition, assign, estimate, comment.
//!
//! Everything goes through the Agile API (`/rest/agile/1.0`) for boards and
//! sprints, and the platform API (`/rest/api/3`) for issues. Responses are read
//! as `serde_json::Value` and mapped by small pure functions, tested below.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::jira::{api_base, epic_from_value};
use crate::models::{ApiError, AppSettings};

// ── Types sent to the frontend ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardRef {
    pub id: u64,
    pub name: String,
    pub project_key: String,
    /// "scrum" or "simple" — kanban boards have no sprints and are left out.
    pub board_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SprintRef {
    pub id: u64,
    pub name: String,
    pub state: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub goal: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardColumn {
    pub name: String,
    pub status_ids: Vec<String>,
    /// Jira status category of the column: "new", "indeterminate" or "done".
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JiraPerson {
    pub account_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SprintIssue {
    pub key: String,
    pub summary: String,
    pub status_id: String,
    pub status_name: String,
    pub status_category: String,
    pub issue_type: String,
    pub assignee: Option<JiraPerson>,
    pub points: Option<f64>,
    pub priority: Option<String>,
    /// Flagged as an impediment on the board.
    pub flagged: bool,
    pub epic: Option<String>,
    pub fix_versions: Vec<String>,
    pub labels: Vec<String>,
    pub subtasks_total: u32,
    pub subtasks_done: u32,
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SprintPermissions {
    pub transition: bool,
    pub assign: bool,
    pub edit: bool,
    pub comment: bool,
}

impl Default for SprintPermissions {
    /// Unknown permissions are assumed granted: Jira still refuses what is not.
    fn default() -> Self {
        Self { transition: true, assign: true, edit: true, comment: true }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SprintBoard {
    pub boards: Vec<BoardRef>,
    pub board: Option<BoardRef>,
    pub sprints: Vec<SprintRef>,
    pub sprint: Option<SprintRef>,
    pub columns: Vec<BoardColumn>,
    pub issues: Vec<SprintIssue>,
    pub me: Option<JiraPerson>,
    pub permissions: SprintPermissions,
    /// Field holding the estimate, as the board is configured — written when
    /// points are edited.
    pub points_field: Option<String>,
    /// Site URL for browse links (`{site}/browse/KEY`).
    pub site_url: String,
    /// Why the board is empty, when it is: nothing configured, no active sprint…
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransitionOption {
    pub id: String,
    pub name: String,
    pub to_status_id: String,
    pub to_status_name: String,
    pub to_category: String,
    /// The transition has a screen with required fields ZuGit cannot fill.
    pub needs_input: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: String,
    pub author: Option<JiraPerson>,
    pub created: Option<String>,
    /// Atlassian Document Format, rendered by the frontend.
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskRef {
    pub key: String,
    pub summary: String,
    pub status_name: String,
    pub status_category: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
    pub created: Option<String>,
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub key: String,
    pub summary: String,
    pub issue_type: String,
    pub reporter: Option<JiraPerson>,
    pub created: Option<String>,
    pub description: Value,
    pub subtasks: Vec<SubtaskRef>,
    pub comments: Vec<IssueComment>,
    pub comment_total: u32,
    pub attachments: Vec<AttachmentRef>,
    /// Media node id (in the description and comments ADF) → attachment id.
    /// ADF only knows the media-services id of an image; the attachment it
    /// shows is read from the HTML Jira renders for the same document.
    pub media: HashMap<String, String>,
}

/// One change from an issue's history, as the standup summary reads it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub key: String,
    pub at: String,
    pub author: Option<String>,
    /// "status", "sprint", "flag" or "assignee".
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
    pub from_string: Option<String>,
    pub to_string: Option<String>,
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/// Jira explains a refusal in `errorMessages` and `errors` — far more useful
/// than the status line ("Field 'resolution' is required").
pub fn jira_error_message(status: u16, body: &str, what: &str) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut parts: Vec<String> = parsed["errorMessages"]
        .as_array()
        .map(|list| list.iter().filter_map(|m| m.as_str()).map(String::from).collect())
        .unwrap_or_default();
    if let Some(errors) = parsed["errors"].as_object() {
        parts.extend(errors.iter().filter_map(|(field, msg)| msg.as_str().map(|m| format!("{field}: {m}"))));
    }
    let reason = match status {
        401 => "token Jira non valido o scaduto".to_string(),
        403 => "permesso negato da Jira".to_string(),
        404 => "non trovato su Jira".to_string(),
        _ => format!("HTTP {status}"),
    };
    if parts.is_empty() {
        format!("{what}: {reason}")
    } else {
        format!("{what}: {}", parts.join(" · "))
    }
}

async fn request_json(
    method: reqwest::Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<&Value>,
    what: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Value, ApiError> {
    let url = format!("{}{}", api_base(settings, client).await, path);
    let mut request = client
        .request(method, url)
        .basic_auth(&settings.jira_email, Some(&settings.jira_token))
        .query(query);
    if let Some(body) = body {
        request = request.json(body);
    }
    let resp = request.send().await.map_err(|e| ApiError::Other(format!("{what}: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::from_status(status.as_u16(), jira_error_message(status.as_u16(), &text, what)));
    }
    // 204 No Content (transitions, assignee, edits) is a success with no body.
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

async fn get_json(
    path: &str,
    query: &[(&str, String)],
    what: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Value, ApiError> {
    request_json(reqwest::Method::GET, path, query, None, what, settings, client).await
}

// ── Mapping (pure) ───────────────────────────────────────────────────────────

fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_string()
}

fn opt_text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Jira ids come as strings on the platform API and as numbers on the Agile one.
fn id_text(value: &Value) -> String {
    match value {
        Value::Number(n) => n.to_string(),
        other => text(other),
    }
}

pub fn parse_person(value: &Value) -> Option<JiraPerson> {
    let account_id = opt_text(&value["accountId"])?;
    Some(JiraPerson {
        account_id,
        display_name: opt_text(&value["displayName"]).unwrap_or_else(|| "?".to_string()),
        // 48px for a crisp 20px avatar on retina screens.
        avatar_url: opt_text(&value["avatarUrls"]["48x48"]).or_else(|| opt_text(&value["avatarUrls"]["32x32"])),
    })
}

pub fn parse_boards(payload: &Value, fallback_project: &str) -> Vec<BoardRef> {
    payload["values"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|board| {
                    let board_type = text(&board["type"]);
                    if board_type == "kanban" {
                        return None;
                    }
                    Some(BoardRef {
                        id: board["id"].as_u64()?,
                        name: text(&board["name"]),
                        project_key: opt_text(&board["location"]["projectKey"])
                            .unwrap_or_else(|| fallback_project.to_string()),
                        board_type,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_sprints(payload: &Value) -> Vec<SprintRef> {
    payload["values"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|sprint| {
                    Some(SprintRef {
                        id: sprint["id"].as_u64()?,
                        name: text(&sprint["name"]),
                        state: text(&sprint["state"]),
                        start_date: opt_text(&sprint["startDate"]),
                        end_date: opt_text(&sprint["endDate"]),
                        goal: opt_text(&sprint["goal"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Columns of the board configuration, with the category their statuses share.
/// Columns without statuses (an unmapped "Backlog") cannot hold an issue and
/// are left out.
pub fn parse_columns(config: &Value, categories: &HashMap<String, String>) -> Vec<BoardColumn> {
    config["columnConfig"]["columns"]
        .as_array()
        .map(|columns| {
            columns
                .iter()
                .filter_map(|column| {
                    let status_ids: Vec<String> = column["statuses"]
                        .as_array()?
                        .iter()
                        .map(|status| id_text(&status["id"]))
                        .filter(|id| !id.is_empty())
                        .collect();
                    if status_ids.is_empty() {
                        return None;
                    }
                    let known: Vec<&str> = status_ids
                        .iter()
                        .filter_map(|id| categories.get(id).map(String::as_str))
                        .collect();
                    let category = if !known.is_empty() && known.iter().all(|c| *c == "done") {
                        "done"
                    } else if !known.is_empty() && known.iter().all(|c| *c == "new") {
                        "new"
                    } else {
                        "indeterminate"
                    };
                    Some(BoardColumn {
                        name: text(&column["name"]),
                        status_ids,
                        category: category.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The estimation field of the board, when it estimates with a field (not by
/// issue count).
pub fn parse_points_field(config: &Value) -> Option<String> {
    let estimation = &config["estimation"];
    if estimation["type"].as_str() != Some("field") {
        return None;
    }
    opt_text(&estimation["field"]["fieldId"])
}

/// Field ids of a site worth knowing for the board.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SiteFields {
    pub points: Vec<String>,
    pub flagged: Option<String>,
    pub epic: Option<String>,
}

pub fn parse_site_fields(payload: &Value) -> SiteFields {
    let mut fields = SiteFields::default();
    let Some(list) = payload.as_array() else { return fields };
    let by_name = |wanted: &str| {
        list.iter()
            .find(|field| text(&field["name"]).trim().eq_ignore_ascii_case(wanted))
            .map(|field| text(&field["id"]))
    };
    for field in list {
        let name = text(&field["name"]).trim().to_lowercase();
        if name == "story points" || name == "story point estimate" {
            fields.points.push(text(&field["id"]));
        }
    }
    fields.flagged = by_name("Flagged").or_else(|| by_name("Contrassegnato"));
    // An "Epic Link" custom field on older company-managed projects; otherwise
    // the epic is the issue's parent.
    fields.epic = by_name("Epic Link").or_else(|| by_name("Collegamento epica"));
    fields
}

fn is_flagged(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Array(items) => !items.is_empty(),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn parse_issue(raw: &Value, points_fields: &[String], site: &SiteFields) -> Option<SprintIssue> {
    let fields = &raw["fields"];
    let key = opt_text(&raw["key"])?;
    let subtasks = fields["subtasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let epic = site
        .epic
        .as_deref()
        .and_then(|id| epic_from_value(&fields[id]))
        .or_else(|| {
            // A parent one level up the hierarchy is the epic; a story's own
            // parent never reaches here (sub-tasks are filtered out).
            let parent = &fields["parent"];
            if parent.is_null() {
                return None;
            }
            epic_from_value(parent)
        })
        .map(|epic| epic.name);

    Some(SprintIssue {
        key,
        summary: text(&fields["summary"]),
        status_id: id_text(&fields["status"]["id"]),
        status_name: text(&fields["status"]["name"]),
        status_category: text(&fields["status"]["statusCategory"]["key"]),
        issue_type: text(&fields["issuetype"]["name"]),
        assignee: parse_person(&fields["assignee"]),
        points: points_fields
            .iter()
            .find_map(|id| fields[id.as_str()].as_f64())
            .filter(|points| *points >= 0.0),
        priority: opt_text(&fields["priority"]["name"]),
        flagged: site.flagged.as_deref().is_some_and(|id| is_flagged(&fields[id])),
        epic,
        fix_versions: fields["fixVersions"]
            .as_array()
            .map(|list| list.iter().filter_map(|v| opt_text(&v["name"])).collect())
            .unwrap_or_default(),
        labels: fields["labels"]
            .as_array()
            .map(|list| list.iter().filter_map(opt_text).collect())
            .unwrap_or_default(),
        subtasks_total: subtasks.len() as u32,
        subtasks_done: subtasks
            .iter()
            .filter(|task| task["fields"]["status"]["statusCategory"]["key"].as_str() == Some("done"))
            .count() as u32,
        updated: opt_text(&fields["updated"]),
    })
}

pub fn parse_transitions(payload: &Value) -> Vec<TransitionOption> {
    payload["transitions"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|t| t["isAvailable"].as_bool() != Some(false))
                .map(|t| TransitionOption {
                    id: id_text(&t["id"]),
                    name: text(&t["name"]),
                    to_status_id: id_text(&t["to"]["id"]),
                    to_status_name: text(&t["to"]["name"]),
                    to_category: text(&t["to"]["statusCategory"]["key"]),
                    needs_input: t["fields"].as_object().is_some_and(|fields| {
                        fields.values().any(|field| {
                            field["required"].as_bool() == Some(true)
                                && field["hasDefaultValue"].as_bool() != Some(true)
                        })
                    }),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_comment(value: &Value) -> Option<IssueComment> {
    Some(IssueComment {
        id: opt_text(&value["id"])?,
        author: parse_person(&value["author"]),
        created: opt_text(&value["created"]),
        body: value["body"].clone(),
    })
}

pub fn parse_attachments(value: &Value) -> Vec<AttachmentRef> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|att| {
                    Some(AttachmentRef {
                        id: Some(id_text(&att["id"])).filter(|id| !id.is_empty())?,
                        filename: text(&att["filename"]),
                        mime_type: text(&att["mimeType"]),
                        size: att["size"].as_u64().unwrap_or(0),
                        created: opt_text(&att["created"]),
                        author: opt_text(&att["author"]["displayName"]),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A media node of an ADF document: its media-services id, and the file name
/// when the editor recorded one.
#[derive(Debug, Clone, PartialEq)]
struct MediaNode {
    id: String,
    name: Option<String>,
}

fn media_nodes(node: &Value, out: &mut Vec<MediaNode>) {
    match node {
        Value::Object(map) => {
            let kind = map.get("type").and_then(Value::as_str);
            if matches!(kind, Some("media") | Some("mediaInline")) {
                let attrs = &node["attrs"];
                if let Some(id) = opt_text(&attrs["id"]) {
                    out.push(MediaNode { id, name: opt_text(&attrs["alt"]).or_else(|| opt_text(&attrs["__fileName"])) });
                }
            }
            if let Some(content) = map.get("content") {
                media_nodes(content, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| media_nodes(item, out)),
        _ => {}
    }
}

static ATTACHMENT_LINK: Lazy<regex::Regex> = Lazy::new(|| {
    regex::Regex::new(r"/(?:rest/api/[23]/attachment/(?:content|thumbnail)|secure/(?:attachment|thumbnail))/(\d+)").unwrap()
});

/// Attachment ids in the order the rendered HTML shows them. An image linked
/// to its own full size names the same id twice in a row: counted once.
fn rendered_attachment_ids(html: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for capture in ATTACHMENT_LINK.captures_iter(html) {
        let id = capture[1].to_string();
        if ids.last() != Some(&id) {
            ids.push(id);
        }
    }
    ids
}

/// Pairs the media nodes of one document with the attachments they show:
/// by position when the rendered HTML names as many attachments as there
/// are nodes, else by file name when it names a single attachment.
fn map_media(adf: &Value, rendered: &str, attachments: &[AttachmentRef], out: &mut HashMap<String, String>) {
    let mut nodes = Vec::new();
    media_nodes(adf, &mut nodes);
    if nodes.is_empty() {
        return;
    }
    let rendered_ids = rendered_attachment_ids(rendered);
    if rendered_ids.len() == nodes.len() {
        for (node, id) in nodes.iter().zip(rendered_ids) {
            out.insert(node.id.clone(), id);
        }
        return;
    }
    for node in &nodes {
        let Some(name) = node.name.as_deref() else { continue };
        let mut named = attachments.iter().filter(|att| att.filename == name);
        if let (Some(att), None) = (named.next(), named.next()) {
            out.insert(node.id.clone(), att.id.clone());
        }
    }
    // One image in the text and one image attached: they are the same.
    let images: Vec<&AttachmentRef> = attachments.iter().filter(|att| att.mime_type.starts_with("image/")).collect();
    if nodes.len() == 1 && images.len() == 1 && !out.contains_key(&nodes[0].id) {
        out.insert(nodes[0].id.clone(), images[0].id.clone());
    }
}

pub fn parse_detail(raw: &Value) -> Option<IssueDetail> {
    let fields = &raw["fields"];
    let rendered = &raw["renderedFields"];
    let comments: Vec<IssueComment> = fields["comment"]["comments"]
        .as_array()
        .map(|list| list.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();
    let attachments = parse_attachments(&fields["attachment"]);
    let mut media = HashMap::new();
    map_media(&fields["description"], rendered["description"].as_str().unwrap_or(""), &attachments, &mut media);
    let rendered_comments = rendered["comment"]["comments"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for (index, comment) in fields["comment"]["comments"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
        let html = rendered_comments.get(index).and_then(|c| c["body"].as_str()).unwrap_or("");
        map_media(&comment["body"], html, &attachments, &mut media);
    }
    Some(IssueDetail {
        attachments,
        media,
        key: opt_text(&raw["key"])?,
        summary: text(&fields["summary"]),
        issue_type: text(&fields["issuetype"]["name"]),
        reporter: parse_person(&fields["reporter"]),
        created: opt_text(&fields["created"]),
        description: fields["description"].clone(),
        subtasks: fields["subtasks"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|task| {
                        Some(SubtaskRef {
                            key: opt_text(&task["key"])?,
                            summary: text(&task["fields"]["summary"]),
                            status_name: text(&task["fields"]["status"]["name"]),
                            status_category: text(&task["fields"]["status"]["statusCategory"]["key"]),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        comment_total: fields["comment"]["total"].as_u64().map(|n| n as u32).unwrap_or(comments.len() as u32),
        comments,
    })
}

/// The changes worth a line in the standup summary, from issues fetched with
/// `expand=changelog`. Only changes at or after `since` are kept.
pub fn parse_change_events(issues: &[Value], since: chrono::DateTime<chrono::Utc>) -> Vec<ChangeEvent> {
    let mut events = Vec::new();
    for issue in issues {
        let Some(key) = opt_text(&issue["key"]) else { continue };
        let Some(histories) = issue["changelog"]["histories"].as_array() else { continue };
        for history in histories {
            let Some(at) = opt_text(&history["created"]) else { continue };
            let Ok(when) = chrono::DateTime::parse_from_str(&at, "%Y-%m-%dT%H:%M:%S%.f%z") else { continue };
            if when.with_timezone(&chrono::Utc) < since {
                continue;
            }
            let author = opt_text(&history["author"]["displayName"]);
            for item in history["items"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                let field_name = text(&item["field"]).to_lowercase();
                let field = match (field_name.as_str(), item["fieldId"].as_str()) {
                    ("status", _) | (_, Some("status")) => "status",
                    ("assignee", _) | (_, Some("assignee")) => "assignee",
                    ("sprint", _) => "sprint",
                    ("flagged", _) | ("contrassegnato", _) => "flag",
                    ("story points", _) | ("story point estimate", _) => "points",
                    _ => continue,
                };
                events.push(ChangeEvent {
                    key: key.clone(),
                    at: at.clone(),
                    author: author.clone(),
                    field: field.to_string(),
                    from: opt_text(&item["from"]),
                    to: opt_text(&item["to"]),
                    from_string: opt_text(&item["fromString"]),
                    to_string: opt_text(&item["toString"]),
                });
            }
        }
    }
    events.sort_by(|a, b| a.at.cmp(&b.at));
    events
}

/// A plain-text comment as ADF: one paragraph per block, single newlines kept
/// as hard breaks.
pub fn text_to_adf(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .trim()
        .split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut content = Vec::new();
            for (i, line) in block.trim().lines().enumerate() {
                if i > 0 {
                    content.push(serde_json::json!({ "type": "hardBreak" }));
                }
                if !line.is_empty() {
                    content.push(serde_json::json!({ "type": "text", "text": line }));
                }
            }
            serde_json::json!({ "type": "paragraph", "content": content })
        })
        .collect();
    serde_json::json!({ "type": "doc", "version": 1, "content": paragraphs })
}

// ── Session caches ───────────────────────────────────────────────────────────

static STATUS_CATEGORIES: Lazy<Mutex<HashMap<String, HashMap<String, String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SITE_FIELDS: Lazy<Mutex<HashMap<String, SiteFields>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static MYSELF: Lazy<Mutex<HashMap<String, JiraPerson>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static ASSIGNABLE: Lazy<Mutex<HashMap<String, Vec<JiraPerson>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn site_key(settings: &AppSettings) -> String {
    format!("{}::{}", settings.jira_base_url, settings.jira_email)
}

async fn status_categories(settings: &AppSettings, client: &reqwest::Client) -> HashMap<String, String> {
    let key = site_key(settings);
    if let Some(hit) = STATUS_CATEGORIES.lock().get(&key) {
        return hit.clone();
    }
    let Ok(payload) = get_json("/rest/api/3/status", &[], "Stati Jira", settings, client).await else {
        return HashMap::new();
    };
    let map: HashMap<String, String> = payload
        .as_array()
        .map(|list| {
            list.iter()
                .map(|status| (id_text(&status["id"]), text(&status["statusCategory"]["key"])))
                .collect()
        })
        .unwrap_or_default();
    STATUS_CATEGORIES.lock().insert(key, map.clone());
    map
}

async fn site_fields(settings: &AppSettings, client: &reqwest::Client) -> SiteFields {
    let key = site_key(settings);
    if let Some(hit) = SITE_FIELDS.lock().get(&key) {
        return hit.clone();
    }
    let Ok(payload) = get_json("/rest/api/3/field", &[], "Campi Jira", settings, client).await else {
        return SiteFields::default();
    };
    let fields = parse_site_fields(&payload);
    SITE_FIELDS.lock().insert(key, fields.clone());
    fields
}

async fn myself(settings: &AppSettings, client: &reqwest::Client) -> Option<JiraPerson> {
    let key = site_key(settings);
    if let Some(hit) = MYSELF.lock().get(&key) {
        return Some(hit.clone());
    }
    let payload = get_json("/rest/api/3/myself", &[], "Utente Jira", settings, client).await.ok()?;
    let me = parse_person(&payload)?;
    MYSELF.lock().insert(key, me.clone());
    Some(me)
}

async fn permissions(project_key: &str, settings: &AppSettings, client: &reqwest::Client) -> SprintPermissions {
    let query = [
        ("projectKey", project_key.to_string()),
        ("permissions", "TRANSITION_ISSUES,ASSIGN_ISSUES,EDIT_ISSUES,ADD_COMMENTS".to_string()),
    ];
    let Ok(payload) = get_json("/rest/api/3/mypermissions", &query, "Permessi Jira", settings, client).await else {
        return SprintPermissions::default();
    };
    let has = |name: &str| payload["permissions"][name]["havePermission"].as_bool().unwrap_or(true);
    SprintPermissions {
        transition: has("TRANSITION_ISSUES"),
        assign: has("ASSIGN_ISSUES"),
        edit: has("EDIT_ISSUES"),
        comment: has("ADD_COMMENTS"),
    }
}

// ── Board ────────────────────────────────────────────────────────────────────

/// Project keys whose boards the tab offers: the repo → board mapping of the
/// settings, plus prefixes the frontend saw on PRs.
fn project_keys(settings: &AppSettings, hints: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = settings
        .jira_repo_boards
        .values()
        .chain(hints.iter())
        .map(|key| key.trim().to_uppercase())
        .filter(|key| !key.is_empty())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

async fn boards_for(project: &str, settings: &AppSettings, client: &reqwest::Client) -> Vec<BoardRef> {
    let query = [("projectKeyOrId", project.to_string()), ("maxResults", "50".to_string())];
    match get_json("/rest/agile/1.0/board", &query, "Board Jira", settings, client).await {
        Ok(payload) => parse_boards(&payload, project),
        Err(err) => {
            eprintln!("[zugit][sprint] boards for {project}: {err}");
            vec![]
        }
    }
}

async fn sprint_issues(
    board_id: u64,
    sprint_id: u64,
    points_fields: &[String],
    site: &SiteFields,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<SprintIssue>, ApiError> {
    let mut wanted: Vec<String> = [
        "summary", "status", "issuetype", "assignee", "priority", "parent", "fixVersions", "labels", "subtasks",
        "updated",
    ]
    .iter()
    .map(|f| f.to_string())
    .collect();
    wanted.extend(points_fields.iter().cloned());
    wanted.extend(site.flagged.iter().cloned());
    wanted.extend(site.epic.iter().cloned());
    wanted.dedup();
    let fields = wanted.join(",");

    let path = format!("/rest/agile/1.0/board/{board_id}/sprint/{sprint_id}/issue");
    let mut issues = Vec::new();
    let mut start_at = 0usize;
    // A page is at most 100 issues; 10 pages is far beyond any real sprint.
    for _ in 0..10 {
        let query = [
            ("jql", "issuetype not in subTaskIssueTypes()".to_string()),
            ("fields", fields.clone()),
            ("maxResults", "100".to_string()),
            ("startAt", start_at.to_string()),
        ];
        let payload = get_json(&path, &query, "Storie dello sprint", settings, client).await?;
        let page = payload["issues"].as_array().cloned().unwrap_or_default();
        let total = payload["total"].as_u64().unwrap_or(0) as usize;
        start_at += page.len();
        issues.extend(page.iter().filter_map(|raw| parse_issue(raw, points_fields, site)));
        if page.is_empty() || start_at >= total {
            break;
        }
    }
    Ok(issues)
}

pub async fn fetch_board(
    board_id: Option<u64>,
    sprint_id: Option<u64>,
    hints: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<SprintBoard, ApiError> {
    let mut result = SprintBoard {
        site_url: settings.jira_base_url.trim_end_matches('/').to_string(),
        ..Default::default()
    };

    let projects = project_keys(settings, hints);
    if projects.is_empty() {
        result.notice = Some(
            "Nessun progetto Jira da mostrare: in Settings → Jira associa i repository alle board (es. repo = PENT)."
                .to_string(),
        );
        return Ok(result);
    }

    let found = futures::future::join_all(projects.iter().map(|p| boards_for(p, settings, client))).await;
    let mut boards: Vec<BoardRef> = Vec::new();
    for board in found.into_iter().flatten() {
        if !boards.iter().any(|b| b.id == board.id) {
            boards.push(board);
        }
    }
    // Scrum boards first: they are the ones built around sprints.
    boards.sort_by_key(|b| (b.board_type != "scrum", b.project_key.clone(), b.id));
    result.boards = boards.clone();

    let Some(board) = board_id
        .and_then(|id| boards.iter().find(|b| b.id == id))
        .or_else(|| boards.first())
        .cloned()
    else {
        result.notice = Some(format!(
            "Nessuna board con sprint trovata per {}: serve una board Scrum del progetto che il tuo utente Jira possa vedere.",
            projects.join(", ")
        ));
        return Ok(result);
    };
    result.board = Some(board.clone());

    let config_path = format!("/rest/agile/1.0/board/{}/configuration", board.id);
    let sprints_path = format!("/rest/agile/1.0/board/{}/sprint", board.id);
    let sprint_query = [("state", "active".to_string())];
    let (config, sprints, categories, site, me, perms) = tokio::join!(
        get_json(&config_path, &[], "Configurazione della board", settings, client),
        get_json(&sprints_path, &sprint_query, "Sprint attivi", settings, client),
        status_categories(settings, client),
        site_fields(settings, client),
        myself(settings, client),
        permissions(&board.project_key, settings, client),
    );
    let config = config?;
    result.me = me;
    result.permissions = perms;
    result.columns = parse_columns(&config, &categories);

    let sprints = match sprints {
        Ok(payload) => parse_sprints(&payload),
        Err(err) => {
            result.notice = Some(format!("Questa board non ha sprint leggibili ({err})."));
            return Ok(result);
        }
    };
    result.sprints = sprints.clone();
    let Some(sprint) = sprint_id
        .and_then(|id| sprints.iter().find(|s| s.id == id))
        .or_else(|| sprints.first())
        .cloned()
    else {
        result.notice = Some(format!("Nessuno sprint attivo su «{}».", board.name));
        return Ok(result);
    };
    result.sprint = Some(sprint.clone());

    let mut points_fields: Vec<String> = parse_points_field(&config).into_iter().collect();
    for id in &site.points {
        if !points_fields.contains(id) {
            points_fields.push(id.clone());
        }
    }
    result.points_field = points_fields.first().cloned();
    result.issues = sprint_issues(board.id, sprint.id, &points_fields, &site, settings, client).await?;
    Ok(result)
}

// ── Actions ──────────────────────────────────────────────────────────────────

pub async fn transitions(key: &str, settings: &AppSettings, client: &reqwest::Client) -> Result<Vec<TransitionOption>, ApiError> {
    let path = format!("/rest/api/3/issue/{key}/transitions");
    let query = [("expand", "transitions.fields".to_string())];
    let payload = get_json(&path, &query, &format!("Transizioni di {key}"), settings, client).await?;
    Ok(parse_transitions(&payload))
}

pub async fn transition(key: &str, transition_id: &str, settings: &AppSettings, client: &reqwest::Client) -> Result<(), ApiError> {
    let path = format!("/rest/api/3/issue/{key}/transitions");
    let body = serde_json::json!({ "transition": { "id": transition_id } });
    request_json(reqwest::Method::POST, &path, &[], Some(&body), &format!("Spostamento di {key}"), settings, client)
        .await
        .map(|_| ())
}

pub async fn assign(key: &str, account_id: Option<&str>, settings: &AppSettings, client: &reqwest::Client) -> Result<(), ApiError> {
    let path = format!("/rest/api/3/issue/{key}/assignee");
    let body = serde_json::json!({ "accountId": account_id });
    request_json(reqwest::Method::PUT, &path, &[], Some(&body), &format!("Assegnazione di {key}"), settings, client)
        .await
        .map(|_| ())
}

pub async fn set_points(
    key: &str,
    field: &str,
    points: Option<f64>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), ApiError> {
    let path = format!("/rest/api/3/issue/{key}");
    let body = serde_json::json!({ "fields": { field: points } });
    request_json(reqwest::Method::PUT, &path, &[], Some(&body), &format!("Punti di {key}"), settings, client)
        .await
        .map(|_| ())
}

pub async fn assignable_users(project: &str, settings: &AppSettings, client: &reqwest::Client) -> Result<Vec<JiraPerson>, ApiError> {
    let cache_key = format!("{}::{project}", site_key(settings));
    if let Some(hit) = ASSIGNABLE.lock().get(&cache_key) {
        return Ok(hit.clone());
    }
    let query = [("project", project.to_string()), ("maxResults", "200".to_string())];
    let payload = get_json("/rest/api/3/user/assignable/search", &query, "Persone assegnabili", settings, client).await?;
    let mut people: Vec<JiraPerson> = payload
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|user| user["active"].as_bool() != Some(false))
                .filter(|user| user["accountType"].as_str().map_or(true, |kind| kind == "atlassian"))
                .filter_map(parse_person)
                .collect()
        })
        .unwrap_or_default();
    people.sort_by_key(|p| p.display_name.to_lowercase());
    ASSIGNABLE.lock().insert(cache_key, people.clone());
    Ok(people)
}

pub async fn issue_detail(key: &str, settings: &AppSettings, client: &reqwest::Client) -> Result<IssueDetail, ApiError> {
    let path = format!("/rest/api/3/issue/{key}");
    let query = [
        ("fields", "summary,issuetype,reporter,created,description,subtasks,comment,attachment".to_string()),
        // The rendered HTML is what ties the description's images to attachments.
        ("expand", "renderedFields".to_string()),
    ];
    let payload = get_json(&path, &query, &format!("Dettaglio di {key}"), settings, client).await?;
    parse_detail(&payload).ok_or_else(|| ApiError::Other(format!("Dettaglio di {key}: risposta non valida")))
}

pub async fn add_comment(key: &str, body: &str, settings: &AppSettings, client: &reqwest::Client) -> Result<IssueComment, ApiError> {
    let path = format!("/rest/api/3/issue/{key}/comment");
    let payload = serde_json::json!({ "body": text_to_adf(body) });
    let created = request_json(reqwest::Method::POST, &path, &[], Some(&payload), &format!("Commento su {key}"), settings, client).await?;
    parse_comment(&created).ok_or_else(|| ApiError::Other("Commento inviato, risposta non valida".to_string()))
}

/// Attachments never change: what was downloaded is kept, up to a budget.
#[derive(Default)]
struct AttachmentCache {
    /// Total size of `files`, checked against the budget.
    bytes: usize,
    files: HashMap<String, Vec<u8>>,
}

static ATTACHMENT_BYTES: Lazy<Mutex<AttachmentCache>> = Lazy::new(|| Mutex::new(AttachmentCache::default()));
const ATTACHMENT_CACHE_BUDGET: usize = 96 * 1024 * 1024;
/// Larger files are opened in the browser rather than shown in the panel.
const ATTACHMENT_MAX_BYTES: u64 = 30 * 1024 * 1024;

/// The bytes of an attachment, through the token: the webview cannot send it.
/// `thumbnail` asks Jira for its scaled-down picture — lighter, but soft enough
/// to make a screenshot unreadable: the panel only uses it when the original
/// is out of reach. It falls back to the file itself when Jira has none.
pub async fn attachment_bytes(
    id: &str,
    thumbnail: bool,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<u8>, ApiError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::Other(format!("Allegato non valido: '{id}'")));
    }
    let cache_key = format!("{}::{id}::{}", site_key(settings), if thumbnail { "thumb" } else { "full" });
    if let Some(hit) = ATTACHMENT_BYTES.lock().files.get(&cache_key) {
        return Ok(hit.clone());
    }

    let api = api_base(settings, client).await;
    let fetch = |path: String, query: Vec<(&'static str, &'static str)>| {
        client
            .get(format!("{api}{path}"))
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .query(&query)
            .send()
    };
    let mut resp = None;
    if thumbnail {
        let thumb = fetch(
            format!("/rest/api/3/attachment/thumbnail/{id}"),
            vec![("redirect", "false"), ("fallbackToDefault", "false"), ("width", "900"), ("height", "1400")],
        )
        .await
        .map_err(|e| ApiError::Other(format!("Allegato {id}: {e}")))?;
        if thumb.status().is_success() {
            resp = Some(thumb);
        }
    }
    let resp = match resp {
        Some(resp) => resp,
        None => fetch(format!("/rest/api/3/attachment/content/{id}"), vec![("redirect", "false")])
            .await
            .map_err(|e| ApiError::Other(format!("Allegato {id}: {e}")))?,
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ApiError::from_status(status.as_u16(), jira_error_message(status.as_u16(), &body, &format!("Allegato {id}"))));
    }
    if resp.content_length().is_some_and(|len| len > ATTACHMENT_MAX_BYTES) {
        return Err(ApiError::Other(format!("Allegato {id}: troppo grande per l'anteprima")));
    }
    let bytes = resp.bytes().await.map_err(|e| ApiError::Other(format!("Allegato {id}: {e}")))?.to_vec();

    let mut cache = ATTACHMENT_BYTES.lock();
    if cache.bytes + bytes.len() > ATTACHMENT_CACHE_BUDGET {
        cache.files.clear();
        cache.bytes = 0;
    }
    cache.bytes += bytes.len();
    cache.files.insert(cache_key, bytes.clone());
    Ok(bytes)
}

async fn search(jql: &str, fields: &str, expand: Option<&str>, settings: &AppSettings, client: &reqwest::Client) -> Result<Vec<Value>, ApiError> {
    let mut query = vec![
        ("jql", jql.to_string()),
        ("fields", fields.to_string()),
        ("maxResults", "100".to_string()),
    ];
    if let Some(expand) = expand {
        query.push(("expand", expand.to_string()));
    }
    let api = api_base(settings, client).await;
    let send = |path: &str| {
        client
            .get(format!("{api}{path}"))
            .basic_auth(&settings.jira_email, Some(&settings.jira_token))
            .query(&query)
            .send()
    };
    let mut resp = send("/rest/api/3/search/jql")
        .await
        .map_err(|e| ApiError::Other(format!("Ricerca Jira: {e}")))?;
    // Sites without the enhanced search still answer on the classic endpoint.
    if matches!(resp.status().as_u16(), 404 | 405 | 410) {
        resp = send("/rest/api/3/search")
            .await
            .map_err(|e| ApiError::Other(format!("Ricerca Jira: {e}")))?;
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(ApiError::from_status(status.as_u16(), jira_error_message(status.as_u16(), &body, "Ricerca Jira")));
    }
    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    Ok(payload["issues"].as_array().cloned().unwrap_or_default())
}

/// Issues by key, for a category whose stories are no longer in the sprint.
/// An unknown key fails the whole `key in (…)` query, so a failing chunk is
/// retried one key at a time.
pub async fn issues_by_keys(keys: &[String], settings: &AppSettings, client: &reqwest::Client) -> Vec<SprintIssue> {
    let site = site_fields(settings, client).await;
    let mut fields: Vec<String> = ["summary", "status", "issuetype", "assignee", "priority", "parent", "fixVersions", "labels", "subtasks", "updated"]
        .iter()
        .map(|f| f.to_string())
        .collect();
    fields.extend(site.points.iter().cloned());
    let fields = fields.join(",");
    let jql = |keys: &[String]| format!("key in ({})", keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(", "));

    let mut found = Vec::new();
    for chunk in keys.chunks(50) {
        match search(&jql(chunk), &fields, None, settings, client).await {
            Ok(raw) => found.extend(raw.iter().filter_map(|issue| parse_issue(issue, &site.points, &site))),
            Err(_) => {
                for key in chunk {
                    if let Ok(raw) = search(&jql(std::slice::from_ref(key)), &fields, None, settings, client).await {
                        found.extend(raw.iter().filter_map(|issue| parse_issue(issue, &site.points, &site)));
                    }
                }
            }
        }
    }
    found
}

/// Status, sprint, flag and assignee changes made to the sprint's issues since
/// `since` — the Jira half of the standup summary.
pub async fn change_events(
    sprint_id: u64,
    since: chrono::DateTime<chrono::Utc>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<ChangeEvent>, ApiError> {
    // Relative minutes sidestep the user's Jira time zone, which absolute JQL
    // dates would be read in.
    let minutes = (chrono::Utc::now() - since).num_minutes().max(1) + 1;
    let jql = format!("sprint = {sprint_id} AND updated >= -{minutes}m");
    let mut issues = search(&jql, "summary,status", Some("changelog"), settings, client).await?;

    // The search embeds one page of each changelog: a story with a long
    // history would lose exactly its latest moves. Its last page is read too.
    let truncated: Vec<(usize, String, u64)> = issues
        .iter()
        .enumerate()
        .filter_map(|(index, issue)| {
            let total = issue["changelog"]["total"].as_u64()?;
            let shown = issue["changelog"]["histories"].as_array().map_or(0, |list| list.len() as u64);
            let key = opt_text(&issue["key"])?;
            (total > shown).then_some((index, key, total))
        })
        .collect();
    let tails = futures::future::join_all(truncated.iter().map(|(_, key, total)| {
        let path = format!("/rest/api/3/issue/{key}/changelog");
        let query = [("startAt", total.saturating_sub(100).to_string()), ("maxResults", "100".to_string())];
        async move { get_json(&path, &query, &format!("Cronologia di {key}"), settings, client).await }
    }))
    .await;
    for ((index, _, _), tail) in truncated.iter().zip(tails) {
        if let Some(values) = tail.ok().and_then(|page| page["values"].as_array().cloned()) {
            issues[*index]["changelog"]["histories"] = Value::Array(values);
        }
    }
    Ok(parse_change_events(&issues, since))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn columns_take_the_category_their_statuses_share() {
        let config = json!({ "columnConfig": { "columns": [
            { "name": "Backlog", "statuses": [] },
            { "name": "To Do", "statuses": [{ "id": "1" }] },
            { "name": "In Progress", "statuses": [{ "id": "3" }, { "id": "10" }] },
            { "name": "Done", "statuses": [{ "id": "4" }, { "id": "5" }] },
        ] } });
        let categories: HashMap<String, String> = [("1", "new"), ("3", "indeterminate"), ("10", "new"), ("4", "done"), ("5", "done")]
            .iter()
            .map(|(id, cat)| (id.to_string(), cat.to_string()))
            .collect();
        let columns = parse_columns(&config, &categories);
        assert_eq!(columns.len(), 3, "a column without statuses is dropped");
        assert_eq!(columns[0].category, "new");
        assert_eq!(columns[1].category, "indeterminate", "mixed statuses count as in progress");
        assert_eq!(columns[1].status_ids, vec!["3", "10"]);
        assert_eq!(columns[2].category, "done");
    }

    #[test]
    fn points_field_only_when_the_board_estimates_with_a_field() {
        let by_field = json!({ "estimation": { "type": "field", "field": { "fieldId": "customfield_10016" } } });
        assert_eq!(parse_points_field(&by_field).as_deref(), Some("customfield_10016"));
        let by_count = json!({ "estimation": { "type": "issueCount" } });
        assert_eq!(parse_points_field(&by_count), None);
    }

    #[test]
    fn kanban_boards_are_left_out() {
        let payload = json!({ "values": [
            { "id": 7, "name": "PENT board", "type": "scrum", "location": { "projectKey": "PENT" } },
            { "id": 8, "name": "PENT flow", "type": "kanban", "location": { "projectKey": "PENT" } },
            { "id": 9, "name": "Team board", "type": "simple" },
        ] });
        let boards = parse_boards(&payload, "ZUME");
        assert_eq!(boards.iter().map(|b| b.id).collect::<Vec<_>>(), vec![7, 9]);
        assert_eq!(boards[1].project_key, "ZUME", "a board without location keeps the queried project");
    }

    #[test]
    fn issue_reads_points_flag_epic_and_subtasks() {
        let site = SiteFields { points: vec!["customfield_10016".into()], flagged: Some("customfield_10021".into()), epic: None };
        let raw = json!({
            "key": "PENT-12",
            "fields": {
                "summary": "Login page",
                "status": { "id": "3", "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story" },
                "assignee": { "accountId": "abc", "displayName": "Sara C.", "avatarUrls": { "48x48": "https://a/48.png" } },
                "customfield_10016": 3.0,
                "customfield_10021": [{ "value": "Impediment" }],
                "parent": { "key": "PENT-1", "fields": { "summary": "Onboarding" } },
                "subtasks": [
                    { "fields": { "status": { "statusCategory": { "key": "done" } } } },
                    { "fields": { "status": { "statusCategory": { "key": "new" } } } },
                ],
                "labels": ["frontend"],
            }
        });
        let issue = parse_issue(&raw, &site.points, &site).unwrap();
        assert_eq!(issue.points, Some(3.0));
        assert!(issue.flagged);
        assert_eq!(issue.epic.as_deref(), Some("Onboarding"));
        assert_eq!((issue.subtasks_done, issue.subtasks_total), (1, 2));
        assert_eq!(issue.assignee.unwrap().avatar_url.as_deref(), Some("https://a/48.png"));
        assert_eq!(issue.labels, vec!["frontend"]);
    }

    #[test]
    fn transitions_flag_required_fields_without_default() {
        let payload = json!({ "transitions": [
            { "id": "11", "name": "Start", "to": { "id": "3", "name": "In Progress", "statusCategory": { "key": "indeterminate" } } },
            { "id": "31", "name": "Done", "to": { "id": "4", "name": "Done", "statusCategory": { "key": "done" } },
              "fields": { "resolution": { "required": true, "hasDefaultValue": false } } },
            { "id": "41", "name": "Hidden", "isAvailable": false, "to": { "id": "5" } },
        ] });
        let list = parse_transitions(&payload);
        assert_eq!(list.len(), 2);
        assert!(!list[0].needs_input);
        assert!(list[1].needs_input);
        assert_eq!(list[1].to_category, "done");
    }

    #[test]
    fn change_events_keep_recent_relevant_items() {
        let issues = vec![json!({
            "key": "PENT-5",
            "changelog": { "histories": [
                { "created": "2026-10-08T10:00:00.000+0200", "author": { "displayName": "Luca" },
                  "items": [{ "field": "status", "fieldId": "status", "from": "1", "to": "3", "fromString": "To Do", "toString": "In Progress" }] },
                { "created": "2026-10-09T11:00:00.000+0200", "author": { "displayName": "Sara" },
                  "items": [
                    { "field": "status", "fieldId": "status", "from": "3", "to": "4", "fromString": "In Progress", "toString": "Done" },
                    { "field": "description", "fieldId": "description" },
                    { "field": "Flagged", "fieldId": "customfield_10021", "toString": "Impediment" },
                    { "field": "Story point estimate", "fieldId": "customfield_10016", "fromString": "3", "toString": "5" },
                  ] },
            ] }
        })];
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-09T07:30:00Z").unwrap().with_timezone(&chrono::Utc);
        let events = parse_change_events(&issues, since);
        assert_eq!(events.len(), 3, "the older move and the description edit are dropped");
        assert_eq!(events[0].field, "status");
        assert_eq!(events[0].to.as_deref(), Some("4"));
        assert_eq!(events[1].field, "flag");
        assert_eq!(events[1].author.as_deref(), Some("Sara"));
        assert_eq!(events[2].field, "points");
        assert_eq!((events[2].from_string.as_deref(), events[2].to_string.as_deref()), (Some("3"), Some("5")));
    }

    #[test]
    fn error_message_prefers_jira_reasons() {
        let body = r#"{"errorMessages":[],"errors":{"resolution":"Resolution is required."}}"#;
        assert_eq!(jira_error_message(400, body, "Spostamento di PENT-1"), "Spostamento di PENT-1: resolution: Resolution is required.");
        assert_eq!(jira_error_message(403, "", "Assegnazione"), "Assegnazione: permesso negato da Jira");
    }

    fn attachment(id: &str, filename: &str, mime: &str) -> AttachmentRef {
        AttachmentRef { id: id.into(), filename: filename.into(), mime_type: mime.into(), size: 10, created: None, author: None }
    }

    #[test]
    fn media_follow_the_rendered_order() {
        let adf = json!({ "type": "doc", "content": [
            { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "uuid-a", "type": "file" } }] },
            { "type": "paragraph", "content": [{ "type": "text", "text": "tra le due" }] },
            { "type": "mediaGroup", "content": [{ "type": "media", "attrs": { "id": "uuid-b", "type": "file" } }] },
        ] });
        let html = r#"<p><span class="image-wrap"><a href="/secure/attachment/10044/shot.png"><img src="/rest/api/3/attachment/content/10044" alt="shot.png"></a></span></p>
            <p>tra le due</p><span class="nobr"><a href="/rest/api/3/attachment/content/10051">spec.pdf<img src="/images/icons/link_attachment_7.gif"></a></span>"#;
        let attachments = [attachment("10044", "shot.png", "image/png"), attachment("10051", "spec.pdf", "application/pdf")];
        let mut media = HashMap::new();
        map_media(&adf, html, &attachments, &mut media);
        assert_eq!(media.get("uuid-a").map(String::as_str), Some("10044"), "an image linked to itself counts once");
        assert_eq!(media.get("uuid-b").map(String::as_str), Some("10051"));
    }

    #[test]
    fn media_fall_back_to_the_file_name() {
        let adf = json!({ "type": "doc", "content": [
            { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "uuid-a", "alt": "diagram.png" } }] },
            { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "uuid-b", "alt": "copy.png" } }] },
        ] });
        let attachments = [attachment("1", "diagram.png", "image/png"), attachment("2", "copy.png", "image/png"), attachment("3", "copy.png", "image/png")];
        let mut media = HashMap::new();
        map_media(&adf, "", &attachments, &mut media);
        assert_eq!(media.get("uuid-a").map(String::as_str), Some("1"));
        assert_eq!(media.get("uuid-b"), None, "a name shared by two attachments proves nothing");
    }

    #[test]
    fn one_image_in_the_text_and_one_attached_are_the_same() {
        let adf = json!({ "type": "doc", "content": [{ "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "uuid-a" } }] }] });
        let attachments = [attachment("7", "image-20261009.png", "image/png"), attachment("8", "notes.txt", "text/plain")];
        let mut media = HashMap::new();
        map_media(&adf, "<p>nothing rendered</p>", &attachments, &mut media);
        assert_eq!(media.get("uuid-a").map(String::as_str), Some("7"));
    }

    #[test]
    fn detail_reads_attachments_and_comment_media() {
        let raw = json!({
            "key": "PENT-1",
            "fields": {
                "summary": "S",
                "attachment": [{ "id": "10044", "filename": "shot.png", "mimeType": "image/png", "size": 2048, "author": { "displayName": "Sara" } }],
                "comment": { "total": 1, "comments": [{ "id": "c1", "body": { "type": "doc", "content": [
                    { "type": "mediaSingle", "content": [{ "type": "media", "attrs": { "id": "uuid-c" } }] }
                ] } }] }
            },
            "renderedFields": { "comment": { "comments": [{ "body": "<img src=\"/rest/api/3/attachment/content/10044\">" }] } }
        });
        let detail = parse_detail(&raw).unwrap();
        assert_eq!(detail.attachments.len(), 1);
        assert_eq!(detail.attachments[0].size, 2048);
        assert_eq!(detail.attachments[0].author.as_deref(), Some("Sara"));
        assert_eq!(detail.media.get("uuid-c").map(String::as_str), Some("10044"));
    }

    #[test]
    fn comment_text_becomes_paragraphs_with_breaks() {
        let adf = text_to_adf("Prima riga\nseconda\n\nNuovo paragrafo");
        let content = adf["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["content"][1]["type"], "hardBreak");
        assert_eq!(content[1]["content"][0]["text"], "Nuovo paragrafo");
    }
}
