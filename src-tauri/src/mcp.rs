//! `zugit --mcp` — a Model Context Protocol server over stdio.
//!
//! It lets an AI assistant (Claude Code, Claude Desktop, Codex…) read the Toggl
//! day ZuGit sees and *propose* how to fill it, without ever holding a token:
//! credentials are read from the system keychain by this process, exactly as the
//! desktop app does, and never appear in a tool result.
//!
//! Nothing is written to Toggl from here. A proposal is saved next to the app's
//! data; ZuGit picks it up, shows it in the planner, and the user submits it.
//!
//! The transport is newline-delimited JSON-RPC 2.0 on stdin/stdout. Only the
//! parts of the protocol a tools-and-prompts server needs are implemented.
//! stdout carries protocol messages only — diagnostics go to stderr.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;

use chrono::{DateTime, Local, NaiveDate, Utc};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::models::AppSettings;
use crate::toggl::{LearnedRules, ProjectHint, TogglAccount};
use crate::toggl_day::{ProposedEntry, TogglDayContext, TogglProposal};

const LATEST_PROTOCOL: &str = "2025-06-18";

/// Same margin the planner panel uses: entries are read half a day around the
/// working range, because Toggl filters on the entry start.
const FETCH_MARGIN_MIN: i64 = 720;

/// Neighbouring signals closer than this are shown as one span of work.
const SPAN_GAP_MIN: i64 = 30;

const INSTRUCTIONS: &str = "ZuGit connects to the user's Toggl Track, Jira and Google Calendar. \
Use toggl_get_day to see a working day (booked entries, meetings, candidate stories, evidence of \
which story was worked on when, free time, learned project/tag suggestions). Use toggl_propose_day \
to hand ZuGit a plan for that day: it is NOT written to Toggl — the user reviews and submits it in \
ZuGit. Use toggl_get_entries to read what was booked over a period (stand-ups, weekly reviews). \
Credentials stay inside ZuGit; never ask the user for tokens.";

pub fn run() {
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[zugit-mcp] could not start the async runtime: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = runtime.block_on(serve()) {
        eprintln!("[zugit-mcp] {error}");
        std::process::exit(1);
    }
}

async fn serve() -> Result<(), String> {
    let data_dir = crate::storage::standalone_data_dir()?;
    let mut server = Server {
        data_dir,
        client: reqwest::Client::new(),
        client_name: "mcp".to_string(),
        account: None,
        google: None,
    };

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let replies: Vec<Value> = match serde_json::from_str::<Value>(&line) {
            Ok(Value::Array(batch)) => {
                let mut replies = Vec::new();
                for message in batch {
                    replies.extend(server.handle(message).await);
                }
                replies
            }
            Ok(message) => server.handle(message).await.into_iter().collect(),
            Err(error) => vec![rpc_error(Value::Null, -32700, &format!("Parse error: {error}"))],
        };
        for reply in replies {
            let mut text = serde_json::to_string(&reply).map_err(|e| e.to_string())?;
            text.push('\n');
            stdout.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
        }
        stdout.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool failure the model should read and react to — not a protocol error.
fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

fn tool_text(value: &Value) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(value).unwrap_or_default(),
        }],
    })
}

struct Server {
    data_dir: PathBuf,
    client: reqwest::Client,
    client_name: String,
    /// Toggl `/me` is rate-limited hard; one fetch per process and token.
    account: Option<(String, TogglAccount)>,
    google: Option<(String, std::time::Instant)>,
}

impl Server {
    async fn handle(&mut self, message: Value) -> Option<Value> {
        let method = message.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        // Notifications carry no id and never get a reply.
        let id = message.get("id").cloned()?;

        let reply = match method.as_str() {
            "initialize" => {
                if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                    self.client_name = name.chars().take(60).collect();
                }
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(LATEST_PROTOCOL);
                rpc_result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {
                            "tools": { "listChanged": false },
                            "prompts": { "listChanged": false },
                        },
                        "serverInfo": {
                            "name": "zugit",
                            "title": "ZuGit",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                        "instructions": INSTRUCTIONS,
                    }),
                )
            }
            "ping" => rpc_result(id, json!({})),
            "tools/list" => rpc_result(id, json!({ "tools": tool_definitions() })),
            "prompts/list" => rpc_result(id, json!({ "prompts": prompt_definitions() })),
            "prompts/get" => match prompt(&params) {
                Ok(result) => rpc_result(id, result),
                Err(message) => rpc_error(id, -32602, &message),
            },
            "resources/list" => rpc_result(id, json!({ "resources": [] })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                let result = match name {
                    "toggl_get_day" => self.get_day(&arguments).await,
                    "toggl_propose_day" => self.propose_day(&arguments).await,
                    "toggl_get_entries" => self.get_entries(&arguments).await,
                    other => {
                        return Some(rpc_error(id, -32602, &format!("Unknown tool '{other}'.")));
                    }
                };
                rpc_result(id, result.unwrap_or_else(|message| tool_error(&message)))
            }
            other => rpc_error(id, -32601, &format!("Method not found: {other}")),
        };
        Some(reply)
    }

    fn settings(&self) -> Result<AppSettings, String> {
        let settings = crate::storage::load_settings_from(&self.data_dir);
        if !settings.toggl_enabled || settings.toggl_token.is_empty() {
            return Err("Toggl is not set up in ZuGit — enable it and add the token in ZuGit Settings.".into());
        }
        Ok(settings)
    }

    async fn account(&mut self, settings: &AppSettings) -> Result<TogglAccount, String> {
        if let Some((token, account)) = &self.account {
            if token == &settings.toggl_token {
                return Ok(account.clone());
            }
        }
        let account = crate::toggl::fetch_account(&settings.toggl_token, &self.client)
            .await
            .map_err(String::from)?;
        self.account = Some((settings.toggl_token.clone(), account.clone()));
        Ok(account)
    }

    async fn google_token(&mut self, settings: &AppSettings) -> Option<Result<String, String>> {
        if !settings.google_calendar_enabled {
            return None;
        }
        if let Some((token, expires_at)) = &self.google {
            if *expires_at > std::time::Instant::now() {
                return Some(Ok(token.clone()));
            }
        }
        let refresh = crate::secret_store::get_secret("googleRefreshToken");
        if refresh.is_empty() {
            return Some(Err("Google Calendar not connected in ZuGit.".into()));
        }
        let result = crate::google::refresh_access_token(
            &settings.google_client_id,
            &settings.google_client_secret,
            &refresh,
            &self.client,
        )
        .await
        .map(|(token, expires_in)| {
            let expires_at = std::time::Instant::now()
                + std::time::Duration::from_secs(expires_in.saturating_sub(60).max(30));
            self.google = Some((token.clone(), expires_at));
            token
        });
        Some(result)
    }

    async fn day_context(&mut self, day: NaiveDate) -> Result<(AppSettings, TogglDayContext), String> {
        let settings = self.settings()?;
        let account = self.account(&settings).await?;
        let workspace_id = crate::commands::toggl_workspace_id(&settings, &account)?;
        let google_token = self.google_token(&settings).await;
        let (start, end) = working_range(&settings);
        let range_start = local_at(day, start - FETCH_MARGIN_MIN).to_rfc3339();
        let range_end = local_at(day, end + FETCH_MARGIN_MIN).to_rfc3339();

        let context = crate::toggl_day::build_context(crate::toggl_day::DayRequest {
            settings: &settings,
            data_dir: &self.data_dir,
            client: &self.client,
            account,
            workspace_id,
            google_token,
            range_start,
            range_end,
            day,
            force_relearn: false,
        })
        .await?;
        Ok((settings, context))
    }

    // ── Tools ────────────────────────────────────────────────────────────────

    async fn get_day(&mut self, arguments: &Value) -> Result<Value, String> {
        let day = parse_day(arguments.get("date"))?;
        let (settings, context) = self.day_context(day).await?;
        let pending = crate::storage::load_toggl_proposal(&self.data_dir, &day.to_string()).is_some();
        Ok(tool_text(&day_view(day, &settings, &context, pending)))
    }

    async fn propose_day(&mut self, arguments: &Value) -> Result<Value, String> {
        let day = parse_day(arguments.get("date"))?;
        let mut entries: Vec<ProposedEntry> = serde_json::from_value(
            arguments.get("entries").cloned().unwrap_or(Value::Null),
        )
        .map_err(|e| format!("Invalid entries: {e}"))?;
        crate::toggl_day::validate_entries(&mut entries)?;

        let settings = self.settings()?;
        let account = self.account(&settings).await?;
        for entry in &entries {
            if let Some(project_id) = entry.project_id {
                if !account.projects.iter().any(|project| project.id == project_id) {
                    return Err(format!(
                        "Unknown projectId {project_id} for \"{}\" — use an id from toggl_get_day.projects, or omit it to let ZuGit fill it from history.",
                        entry.description
                    ));
                }
            }
        }

        // Rows on top of what is already booked could not be submitted anyway.
        let (start, end) = (local_at(day, -FETCH_MARGIN_MIN), local_at(day, 1440 + FETCH_MARGIN_MIN));
        let booked = crate::toggl::fetch_time_entries(
            &settings.toggl_token,
            &start.to_rfc3339(),
            &end.to_rfc3339(),
            &self.client,
        )
        .await
        .map_err(String::from)?;
        for entry in &entries {
            let from = crate::toggl_day::parse_hhmm(&entry.start).unwrap_or(0) as i64;
            let to = crate::toggl_day::parse_hhmm(&entry.end).unwrap_or(0) as i64;
            for existing in &booked {
                let Some((b_from, b_to)) = entry_minutes(existing, day) else { continue };
                if from < b_to && b_from < to {
                    return Err(format!(
                        "\"{}\" ({}–{}) overlaps \"{}\", already booked {}–{}. Only propose entries for free time.",
                        entry.description,
                        entry.start,
                        entry.end,
                        existing.description,
                        hhmm(b_from),
                        hhmm(b_to)
                    ));
                }
            }
        }

        let total: i64 = entries
            .iter()
            .map(|entry| {
                crate::toggl_day::parse_hhmm(&entry.end).unwrap_or(0) as i64
                    - crate::toggl_day::parse_hhmm(&entry.start).unwrap_or(0) as i64
            })
            .sum();
        let count = entries.len();
        let proposal = TogglProposal {
            date: day.to_string(),
            created_at: Utc::now().to_rfc3339(),
            source: self.client_name.clone(),
            note: arguments
                .get("note")
                .and_then(Value::as_str)
                .map(|note| note.chars().take(500).collect()),
            entries,
        };
        crate::storage::save_toggl_proposal(&self.data_dir, &proposal)?;

        Ok(tool_text(&json!({
            "saved": true,
            "date": day.to_string(),
            "entries": count,
            "total": duration(total),
            "next": "Nothing was sent to Toggl. ZuGit shows this plan in its Toggl planner (it opens by itself when the app is running); the user reviews and submits it there. Calling this tool again for the same date replaces the proposal.",
        })))
    }

    async fn get_entries(&mut self, arguments: &Value) -> Result<Value, String> {
        let from = parse_day(arguments.get("from"))?;
        let to = match arguments.get("to") {
            Some(value) if !value.is_null() => parse_day(Some(value))?,
            _ => from,
        };
        if to < from {
            return Err("'to' is before 'from'.".into());
        }
        if (to - from).num_days() > 31 {
            return Err("At most 31 days per call.".into());
        }

        let settings = self.settings()?;
        let account = self.account(&settings).await?;
        let entries = crate::toggl::fetch_time_entries(
            &settings.toggl_token,
            &from.to_string(),
            &to.succ_opt().unwrap_or(to).to_string(),
            &self.client,
        )
        .await
        .map_err(String::from)?;

        let project_name = |id: Option<i64>| -> Value {
            id.and_then(|id| account.projects.iter().find(|p| p.id == id))
                .map(|p| json!(p.name))
                .unwrap_or(Value::Null)
        };

        let mut days: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut per_task: HashMap<String, i64> = HashMap::new();
        for entry in &entries {
            let Some(start) = parse_local(&entry.start) else { continue };
            let minutes = if entry.duration >= 0 {
                entry.duration / 60
            } else {
                (Utc::now().timestamp() + entry.duration) / 60
            };
            let stop = entry.stop.as_deref().and_then(parse_local);
            let task = crate::jira::extract_all_jira_keys(&entry.description)
                .into_iter()
                .next()
                .unwrap_or_else(|| entry.description.trim().to_string());
            *per_task.entry(task).or_default() += minutes;
            days.entry(start.format("%Y-%m-%d").to_string()).or_default().push(json!({
                "start": start.format("%H:%M").to_string(),
                "end": stop.map(|s| s.format("%H:%M").to_string()),
                "duration": duration(minutes),
                "description": entry.description,
                "project": project_name(entry.project_id),
                "tags": entry.tags,
                "running": entry.duration < 0,
            }));
        }
        for list in days.values_mut() {
            list.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
        }
        let mut totals: Vec<(String, i64)> = per_task.into_iter().collect();
        totals.sort_by_key(|total| std::cmp::Reverse(total.1));

        Ok(tool_text(&json!({
            "from": from.to_string(),
            "to": to.to_string(),
            "days": days,
            "totalsByTask": totals
                .into_iter()
                .map(|(task, minutes)| json!({ "task": task, "total": duration(minutes) }))
                .collect::<Vec<_>>(),
        })))
    }
}

// ── Day view ─────────────────────────────────────────────────────────────────

fn working_range(settings: &AppSettings) -> (i64, i64) {
    let start = crate::toggl_day::parse_hhmm(&settings.toggl_day_start).unwrap_or(480) as i64;
    let mut end = crate::toggl_day::parse_hhmm(&settings.toggl_day_end).unwrap_or(840) as i64;
    if end <= start {
        end += 1440; // overnight shift
    }
    (start, end)
}

fn local_at(day: NaiveDate, minutes: i64) -> DateTime<Local> {
    let midnight = day
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| naive.and_local_timezone(Local).earliest())
        .unwrap_or_else(Local::now);
    midnight + chrono::Duration::minutes(minutes)
}

/// RFC3339 or Jira's colon-less offset ("…+0200").
fn parse_local(value: &str) -> Option<DateTime<Local>> {
    crate::jira::parse_jira_datetime(value).map(|dt| dt.with_timezone(&Local))
}

/// Minutes from the day's local midnight (negative before, past 1440 after).
fn minutes_on(day: NaiveDate, value: &str) -> Option<i64> {
    let at = parse_local(value)?;
    Some((at - local_at(day, 0)).num_minutes())
}

fn entry_minutes(entry: &crate::toggl::TogglTimeEntry, day: NaiveDate) -> Option<(i64, i64)> {
    let from = minutes_on(day, &entry.start)?;
    let to = match entry.stop.as_deref() {
        Some(stop) => minutes_on(day, stop)?,
        None => (Local::now() - local_at(day, 0)).num_minutes(),
    };
    (to > from).then_some((from, to))
}

/// "HH:MM" for a minute offset; days other than the planned one are spelled out.
fn hhmm(minutes: i64) -> String {
    let day_offset = minutes.div_euclid(1440);
    let within = minutes.rem_euclid(1440);
    let clock = format!("{:02}:{:02}", within / 60, within % 60);
    match day_offset {
        0 => clock,
        1 if within == 0 => "24:00".to_string(),
        n => format!("{clock} ({n:+}d)"),
    }
}

/// A length of time — "25h12m", "45m" — never confused with a clock time.
fn duration(minutes: i64) -> String {
    let minutes = minutes.max(0);
    match (minutes / 60, minutes % 60) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h{m:02}m"),
    }
}

fn parse_day(value: Option<&Value>) -> Result<NaiveDate, String> {
    match value.and_then(Value::as_str).map(str::trim) {
        None | Some("") | Some("today") => Ok(Local::now().date_naive()),
        Some("yesterday") => Ok(Local::now().date_naive() - chrono::Duration::days(1)),
        Some(text) => NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .map_err(|_| format!("Invalid date '{text}', expected YYYY-MM-DD.")),
    }
}

fn suggestion(hint: Option<&ProjectHint>, account: &TogglAccount) -> Value {
    let Some(hint) = hint else { return Value::Null };
    json!({
        "description": hint.description,
        "projectId": hint.project_id,
        "project": hint
            .project_id
            .and_then(|id| account.projects.iter().find(|p| p.id == id))
            .map(|p| p.name.clone()),
        "tags": hint.tags.iter().take(1).collect::<Vec<_>>(),
        "billable": hint.billable,
        "basedOnEntries": hint.uses,
    })
}

fn event_hint<'a>(rules: &'a LearnedRules, event: &crate::google::CalendarEvent) -> Option<&'a ProjectHint> {
    crate::toggl::event_keys(event.recurring_event_id.as_deref(), &event.summary)
        .iter()
        .find_map(|key| rules.by_event.get(key))
        .or_else(|| {
            let normalized = crate::toggl::normalize_description(&event.summary);
            rules
                .recurring
                .iter()
                .find(|rule| rule.normalized == normalized)
                .map(|rule| &rule.hint)
        })
}

fn story_hint<'a>(rules: &'a LearnedRules, key: &str) -> Option<&'a ProjectHint> {
    rules.by_key.get(key).or_else(|| {
        key.split_once('-')
            .and_then(|(prefix, _)| rules.by_prefix.get(prefix))
    })
}

/// Activity collapsed into spans per story: "PENT-12 worked 09:10–10:40 (3
/// commits, Claude Code)" reads far better than forty timestamps.
fn activity_spans(context: &TogglDayContext, day: NaiveDate) -> Vec<Value> {
    let mut by_key: BTreeMap<&str, Vec<(i64, &crate::activity::ActivityEvent)>> = BTreeMap::new();
    for event in &context.activity {
        if let Some(minute) = minutes_on(day, &event.at) {
            by_key.entry(&event.key).or_default().push((minute, event));
        }
    }

    let mut spans = Vec::new();
    for (key, mut events) in by_key {
        events.sort_by_key(|(minute, _)| *minute);
        let mut group: Vec<(i64, &crate::activity::ActivityEvent)> = Vec::new();
        let flush = |group: &mut Vec<(i64, &crate::activity::ActivityEvent)>, spans: &mut Vec<Value>| {
            if group.is_empty() {
                return;
            }
            let from = group.first().map(|(m, _)| *m).unwrap_or(0);
            let to = group.last().map(|(m, _)| *m).unwrap_or(0);
            let sources: BTreeSet<&str> = group.iter().map(|(_, e)| e.source.as_str()).collect();
            let details: BTreeSet<&str> = group
                .iter()
                .filter(|(_, e)| e.source != "ai-session")
                .map(|(_, e)| e.detail.as_str())
                .collect();
            let tools: BTreeSet<&str> = group
                .iter()
                .filter(|(_, e)| e.source == "ai-session")
                .map(|(_, e)| e.detail.as_str())
                .collect();
            spans.push(json!({
                "key": key,
                "from": hhmm(from),
                "to": hhmm(to),
                "signals": group.len(),
                "sources": sources,
                "aiTools": tools,
                "details": details.into_iter().take(6).collect::<Vec<_>>(),
            }));
            group.clear();
        };
        for (minute, event) in events {
            if group.last().is_some_and(|(last, _)| minute - last > SPAN_GAP_MIN) {
                flush(&mut group, &mut spans);
            }
            group.push((minute, event));
        }
        flush(&mut group, &mut spans);
    }
    spans.sort_by(|a, b| a["from"].as_str().cmp(&b["from"].as_str()));
    spans
}

fn day_view(day: NaiveDate, settings: &AppSettings, context: &TogglDayContext, pending: bool) -> Value {
    let account = &context.account;
    let (range_from, range_to) = working_range(settings);
    let slot = settings.toggl_slot_minutes as i64;

    let mut busy: Vec<(i64, i64)> = Vec::new();
    let booked: Vec<Value> = context
        .existing
        .iter()
        .filter_map(|entry| {
            let (from, to) = entry_minutes(entry, day)?;
            if to <= range_from - 240 || from >= range_to + 240 {
                return None;
            }
            busy.push((from, to));
            Some(json!({
                "start": hhmm(from),
                "end": hhmm(to),
                "description": entry.description,
                "project": entry
                    .project_id
                    .and_then(|id| account.projects.iter().find(|p| p.id == id))
                    .map(|p| p.name.clone()),
                "running": entry.duration < 0,
            }))
        })
        .collect();

    let meetings: Vec<Value> = context
        .events
        .iter()
        .filter_map(|event| {
            let from = minutes_on(day, &event.start)?;
            let to = minutes_on(day, &event.end)?;
            if to <= range_from || from >= range_to {
                return None;
            }
            let counts = !event.declined && !event.transparent;
            if counts {
                busy.push((from, to));
            }
            Some(json!({
                "start": hhmm(from),
                "end": hhmm(to),
                "title": event.summary,
                "declined": event.declined,
                "markedFree": event.transparent,
                "alreadyBooked": context.existing.iter().any(|entry| {
                    entry_minutes(entry, day).is_some_and(|(a, b)| a < to && from < b)
                }),
                "suggestion": suggestion(event_hint(&context.rules, event), account),
            }))
        })
        .collect();

    busy.sort();
    let mut free = Vec::new();
    let mut cursor = range_from;
    for (from, to) in busy {
        if to <= cursor || from >= range_to {
            continue;
        }
        if from > cursor && from - cursor >= slot {
            free.push(json!({ "from": hhmm(cursor), "to": hhmm(from.min(range_to)) }));
        }
        cursor = cursor.max(to);
    }
    if range_to - cursor >= slot {
        free.push(json!({ "from": hhmm(cursor), "to": hhmm(range_to) }));
    }

    let stories: Vec<Value> = context
        .issues
        .iter()
        .map(|issue| {
            json!({
                "key": issue.key,
                "summary": issue.summary,
                "status": issue.status,
                "stage": issue.stage,
                "statusChangedAt": issue
                    .status_changed_at
                    .as_deref()
                    .and_then(parse_local)
                    .map(|at| at.format("%Y-%m-%d %H:%M").to_string()),
                "suggestion": suggestion(story_hint(&context.rules, &issue.key), account),
            })
        })
        .collect();

    json!({
        "date": day.to_string(),
        "workingRange": { "from": hhmm(range_from), "to": hhmm(range_to) },
        "roundingMinutes": slot,
        "booked": booked,
        "meetings": meetings,
        "freeTime": free,
        "stories": stories,
        "activity": activity_spans(context, day),
        "projects": account
            .projects
            .iter()
            .filter(|p| p.active)
            .map(|p| json!({ "id": p.id, "name": p.name, "client": p.client_name }))
            .collect::<Vec<_>>(),
        "tags": account.tags.iter().map(|t| t.name.clone()).collect::<BTreeSet<_>>(),
        "gapFilling": if settings.toggl_fill_gaps {
            json!({
                "enabled": true,
                "minutesPerPoint": context.rules.minutes_per_point.map(|pace| pace.round()),
                "pointsSample": context.rules.points_sample,
                "stories": context.fill.iter().map(|story| json!({
                    "key": story.key,
                    "points": story.points,
                    "pointsAssumed": story.points_assumed,
                    "booked": duration(story.booked_minutes),
                    "budget": story.budget_minutes.map(duration),
                    "weight": (story.weight * 10.0).round() / 10.0,
                })).collect::<Vec<_>>(),
            })
        } else {
            json!({ "enabled": false })
        },
        "pendingProposal": pending,
        "warnings": context.warnings,
        "howToRead": {
            "stage": "in-progress / merge-request = current Jira status; touched = moved by the user that day or seen in commits/AI sessions; sprint = only in the open sprint, eligible for gap filling only",
            "gapFilling": "when enabled, free time no evidence explains is shared between gapFilling.stories in proportion to weight (minutes their estimate still leaves unbooked), in blocks of at least one hour, using as few stories as possible",
            "activity": "spans of evidence per story: ai-session = an AI coding session on the story's branch; commit = commits authored by the user (work happened before them); jira = status changes made by the user ('→ Developed' ends work, '→ In Progress' starts it)",
            "suggestion": "project/tags/description the user used for this story or meeting in the past — reuse them unless told otherwise",
        },
    })
}

// ── Definitions ──────────────────────────────────────────────────────────────

fn tool_definitions() -> Value {
    json!([
        {
            "name": "toggl_get_day",
            "title": "Read a Toggl day",
            "description": "Everything needed to fill one working day on Toggl: entries already booked, calendar meetings (with the project/description used for them before), candidate Jira stories, evidence of which story was worked on when (AI sessions, commits, Jira status changes), the free time left, and the Toggl projects and tags. Times are local HH:MM.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "date": { "type": "string", "description": "YYYY-MM-DD, 'today' or 'yesterday'. Defaults to today." }
                },
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": true }
        },
        {
            "name": "toggl_propose_day",
            "title": "Propose a Toggl day to ZuGit",
            "description": "Hands ZuGit a plan for the free time of one day. Nothing is written to Toggl: ZuGit shows the plan in its planner and the user reviews and submits it. Cover only free time (see toggl_get_day.freeTime), use local HH:MM times aligned to the rounding, never overlap entries. Put the Jira key first in story descriptions (e.g. 'PENT-12 Login page'). Omit projectId/tags/billable to let ZuGit fill them from history. Calling it again for the same date replaces the previous proposal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "date": { "type": "string", "description": "YYYY-MM-DD, 'today' or 'yesterday'." },
                    "note": { "type": "string", "description": "One or two sentences for the user on how the day was split." },
                    "entries": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "start": { "type": "string", "description": "Local HH:MM" },
                                "end": { "type": "string", "description": "Local HH:MM (24:00 allowed)" },
                                "description": { "type": "string" },
                                "issueKey": { "type": "string", "description": "Jira key when the entry is about a story" },
                                "projectId": { "type": "integer" },
                                "tags": { "type": "array", "items": { "type": "string" } },
                                "billable": { "type": "boolean" },
                                "reason": { "type": "string", "description": "Short evidence for this slot, shown to the user" }
                            },
                            "required": ["start", "end", "description"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["date", "entries"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true }
        },
        {
            "name": "toggl_get_entries",
            "title": "Read booked Toggl entries",
            "description": "Entries booked on Toggl over a period (max 31 days), grouped by day, with totals per story/activity. Useful for stand-ups and weekly reviews.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "YYYY-MM-DD, 'today' or 'yesterday'." },
                    "to": { "type": "string", "description": "YYYY-MM-DD, inclusive. Defaults to 'from'." }
                },
                "required": ["from"],
                "additionalProperties": false
            },
            "annotations": { "readOnlyHint": true, "openWorldHint": true }
        }
    ])
}

fn prompt_definitions() -> Value {
    json!([
        {
            "name": "fill_toggl_day",
            "title": "Fill a Toggl day",
            "description": "Plan the free time of a day from the evidence ZuGit collects and what you know from this conversation, then hand it to ZuGit for review.",
            "arguments": [
                { "name": "date", "description": "YYYY-MM-DD; today when omitted", "required": false }
            ]
        }
    ])
}

fn prompt(params: &Value) -> Result<Value, String> {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if name != "fill_toggl_day" {
        return Err(format!("Unknown prompt '{name}'."));
    }
    let date = params
        .pointer("/arguments/date")
        .and_then(Value::as_str)
        .filter(|d| !d.trim().is_empty())
        .unwrap_or("today");
    let text = format!(
        "Fill my Toggl day for {date}.\n\n\
1. Call toggl_get_day for {date}.\n\
2. Meetings that are not declined, not marked free and not already booked get their own entry, \
using the suggestion (description/project) when there is one.\n\
3. Split the remaining freeTime between the stories in proportion to the evidence: activity spans \
(AI sessions mean the story was being worked on right then; commits and '→ Developed'/'→ Merge Request' \
mean work happened before them; '→ In Progress' means work after; '(in blocco)' moves were made \
together with others and say little; '(senza tuoi commit o sessioni)' moves past merge request are \
likely a review/merge of someone else's work, not time spent on the story). Use blocks of at least one hour, as few as possible; never \
split every gap in half. Stories with no evidence get time only if nothing else explains the gap; \
if gapFilling is enabled, share that unexplained time by gapFilling weight instead. Ignore \
experimental work outside the stories listed.\n\
4. Use what you know from our conversation too: if we worked on something together today, that counts.\n\
5. If something is genuinely ambiguous, ask me before proposing.\n\
6. Call toggl_propose_day with the plan and a short note, then tell me to review it in ZuGit."
    );
    Ok(json!({
        "description": "Plan a Toggl day and hand it to ZuGit for review",
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server {
            data_dir: std::env::temp_dir(),
            client: reqwest::Client::new(),
            client_name: "test".into(),
            account: None,
            google: None,
        }
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn initialize_echoes_the_protocol_and_remembers_the_client() {
        let mut server = server();
        let reply = block_on(server.handle(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "clientInfo": { "name": "claude-code", "version": "1" }, "capabilities": {} }
        })))
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(reply["result"]["serverInfo"]["name"], "zugit");
        assert_eq!(server.client_name, "claude-code");
    }

    #[test]
    fn notifications_get_no_reply_and_unknown_methods_an_error() {
        let mut server = server();
        assert!(block_on(server.handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))).is_none());
        let reply = block_on(server.handle(json!({ "jsonrpc": "2.0", "id": 7, "method": "nope" }))).unwrap();
        assert_eq!(reply["error"]["code"], -32601);
        assert_eq!(reply["id"], 7);
    }

    #[test]
    fn tools_are_listed_with_schemas() {
        let mut server = server();
        let reply = block_on(server.handle(json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" }))).unwrap();
        let names: Vec<&str> = reply["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["toggl_get_day", "toggl_propose_day", "toggl_get_entries"]);
        assert!(reply["result"]["tools"][1]["inputSchema"]["required"].is_array());
    }

    #[test]
    fn invalid_proposals_come_back_as_tool_errors() {
        let mut server = server();
        let reply = block_on(server.handle(json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "toggl_propose_day", "arguments": {
                "date": "2026-10-01",
                "entries": [{ "start": "10:00", "end": "09:00", "description": "x" }]
            } }
        })))
        .unwrap();
        assert_eq!(reply["result"]["isError"], true);
    }

    #[test]
    fn durations_are_not_clock_times() {
        assert_eq!(duration(1512), "25h12m");
        assert_eq!(duration(45), "45m");
        assert_eq!(duration(120), "2h");
    }

    #[test]
    fn clock_labels_cover_overnight_ranges() {
        assert_eq!(hhmm(8 * 60 + 5), "08:05");
        assert_eq!(hhmm(1440), "24:00");
        assert_eq!(hhmm(1440 + 60), "01:00 (+1d)");
        assert_eq!(hhmm(-30), "23:30 (-1d)");
    }

    #[test]
    fn the_prompt_names_the_requested_day() {
        let result = prompt(&json!({ "name": "fill_toggl_day", "arguments": { "date": "2026-10-01" } })).unwrap();
        let text = result["messages"][0]["content"]["text"].as_str().unwrap();
        assert!(text.contains("2026-10-01"));
        assert!(prompt(&json!({ "name": "other" })).is_err());
    }
}
