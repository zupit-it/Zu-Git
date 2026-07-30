//! Google Calendar (read-only) via the OAuth 2.0 flow for installed apps.
//!
//! Toggl does not expose the calendar events it suggests in its own UI, so the
//! planner reads them straight from Google instead. The flow is the standard
//! loopback one: ZuGit opens the consent page in the system browser, listens on
//! `127.0.0.1:43117` for the redirect, swaps the code for tokens (PKCE + client
//! secret), and keeps only the refresh token — in the system keychain.
//!
//! Scope is `calendar.readonly`: ZuGit can list events and nothing else.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_API: &str = "https://www.googleapis.com/calendar/v3";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";

/// Fixed loopback port: it has to be registered as a redirect URI in the Google
/// Cloud console, so it cannot be picked at random.
pub const REDIRECT_PORT: u16 = 43117;

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}")
}

/// How long the consent page is given before the listener gives up.
const CONSENT_TIMEOUT_SECS: u64 = 180;

// ── Public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleConnection {
    /// Calendar id of the connected account — its email address, in practice.
    pub calendar_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub summary: String,
    /// RFC3339 with offset, as Google returns it.
    pub start: String,
    pub end: String,
    /// True when the viewer declined the invitation.
    pub declined: bool,
    /// Marked "free" rather than "busy" in Google Calendar.
    pub transparent: bool,
    /// "default" | "outOfOffice" | "focusTime" | …
    pub event_type: String,
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

fn random_token(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

// ── Loopback listener ────────────────────────────────────────────────────────

const CALLBACK_PAGE: &str = "<!doctype html><meta charset=\"utf-8\"><title>ZuGit</title>\
<body style=\"font:16px -apple-system,sans-serif;padding:48px;text-align:center\">\
<p>Calendario collegato a ZuGit.</p><p style=\"color:#666\">Puoi chiudere questa scheda.</p>";

/// Waits for Google to redirect back with the authorization code.
///
/// Only the request line is parsed — that's where the query string is — and any
/// request without a `code` (a favicon fetch, say) is answered and ignored.
async fn wait_for_code(listener: tokio::net::TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|e| format!("Loopback listener failed: {e}"))?;

        let mut buf = vec![0u8; 4096];
        let read = socket.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..read]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/")
            .to_string();

        let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|e| format!("Could not parse the redirect: {e}"))?;
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

        let body_and_result = if let Some(error) = params.get("error") {
            Some(Err(format!("Google refused the authorisation: {error}")))
        } else if let Some(code) = params.get("code") {
            if params.get("state").map(String::as_str) != Some(state) {
                // A mismatched state means the response isn't ours — refuse it.
                Some(Err("OAuth state mismatch — authorisation aborted.".to_string()))
            } else {
                Some(Ok(code.clone()))
            }
        } else {
            None
        };

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            CALLBACK_PAGE.len(),
            CALLBACK_PAGE
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;

        if let Some(result) = body_and_result {
            return result;
        }
    }
}

// ── Token exchange ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

async fn post_token(
    form: &[(&str, &str)],
    client: &reqwest::Client,
) -> Result<TokenResponse, String> {
    let response = client
        .post(TOKEN_ENDPOINT)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("Google token endpoint unreachable: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google token exchange failed ({status}): {}",
            detail.chars().take(200).collect::<String>()
        ));
    }

    response
        .json()
        .await
        .map_err(|e| format!("Could not parse the Google token response: {e}"))
}

/// Runs the full consent flow and returns `(refresh_token, connection)`.
pub async fn authorize(
    client_id: &str,
    client_secret: &str,
    app: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<(String, GoogleConnection), String> {
    let verifier = random_token(48);
    let challenge = code_challenge(&verifier);
    let state = random_token(16);
    let redirect = redirect_uri();

    // Bind before opening the browser, so the redirect can never arrive first.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .await
        .map_err(|e| {
            format!("Could not listen on {redirect} — is another ZuGit window connecting? ({e})")
        })?;

    let auth_url = url::Url::parse_with_params(
        AUTH_ENDPOINT,
        &[
            ("client_id", client_id),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("access_type", "offline"),
            // Without this Google skips the refresh token on re-authorisation.
            ("prompt", "consent"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
        ],
    )
    .map_err(|e| format!("Could not build the consent URL: {e}"))?;

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| format!("Could not open the browser: {e}"))?;

    let code = tokio::time::timeout(
        std::time::Duration::from_secs(CONSENT_TIMEOUT_SECS),
        wait_for_code(listener, &state),
    )
    .await
    .map_err(|_| "Timed out waiting for the Google consent page.".to_string())??;

    let tokens = post_token(
        &[
            ("code", &code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", &redirect),
            ("grant_type", "authorization_code"),
            ("code_verifier", &verifier),
        ],
        client,
    )
    .await?;

    let refresh_token = tokens.refresh_token.ok_or_else(|| {
        "Google did not return a refresh token. Revoke ZuGit's access in your Google account and connect again.".to_string()
    })?;

    let connection = fetch_primary_calendar(&tokens.access_token, client).await?;
    Ok((refresh_token, connection))
}

/// Swaps the stored refresh token for a short-lived access token.
/// Returns the token and its lifetime in seconds.
pub async fn refresh_access_token(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
    client: &reqwest::Client,
) -> Result<(String, u64), String> {
    let tokens = post_token(
        &[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ],
        client,
    )
    .await?;
    Ok((tokens.access_token, tokens.expires_in.unwrap_or(3600)))
}

// ── Calendar reads ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawCalendar {
    id: String,
    #[serde(default)]
    summary: Option<String>,
}

pub async fn fetch_primary_calendar(
    access_token: &str,
    client: &reqwest::Client,
) -> Result<GoogleConnection, String> {
    let response = client
        .get(format!("{CALENDAR_API}/calendars/primary"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Google Calendar unreachable: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Google Calendar rejected the request ({status})"));
    }

    let calendar: RawCalendar = response
        .json()
        .await
        .map_err(|e| format!("Could not parse the calendar: {e}"))?;

    Ok(GoogleConnection {
        summary: calendar.summary.clone().unwrap_or_else(|| calendar.id.clone()),
        calendar_id: calendar.id,
    })
}

#[derive(Debug, Deserialize)]
struct RawEventList {
    #[serde(default)]
    items: Vec<RawEvent>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEvent {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    start: Option<RawEventTime>,
    #[serde(default)]
    end: Option<RawEventTime>,
    #[serde(default)]
    transparency: Option<String>,
    #[serde(default)]
    event_type: Option<String>,
    #[serde(default)]
    attendees: Vec<RawAttendee>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEventTime {
    #[serde(default)]
    date_time: Option<String>,
    /// Set instead of `dateTime` on all-day events.
    #[serde(default)]
    date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAttendee {
    #[serde(default, rename = "self")]
    is_self: bool,
    #[serde(default)]
    response_status: Option<String>,
}

/// Timed events overlapping `[time_min, time_max]`, expanded from recurrences.
///
/// All-day entries and Google's synthetic "working location" events are dropped:
/// they describe the shape of the day, not work done in it. Declined and
/// free-marked events are kept but flagged, so the planner can ignore them while
/// still being able to show why.
pub async fn fetch_events(
    access_token: &str,
    calendar_id: &str,
    time_min: &str,
    time_max: &str,
    client: &reqwest::Client,
) -> Result<Vec<CalendarEvent>, String> {
    let encoded_id = url::form_urlencoded::byte_serialize(calendar_id.as_bytes()).collect::<String>();
    let response = client
        .get(format!("{CALENDAR_API}/calendars/{encoded_id}/events"))
        .query(&[
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "50"),
        ])
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Google Calendar unreachable: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!(
            "Google Calendar rejected the request ({status}): {}",
            detail.chars().take(200).collect::<String>()
        ));
    }

    let list: RawEventList = response
        .json()
        .await
        .map_err(|e| format!("Could not parse the calendar events: {e}"))?;

    Ok(list
        .items
        .into_iter()
        .filter(|event| event.status.as_deref() != Some("cancelled"))
        .filter(|event| event.event_type.as_deref() != Some("workingLocation"))
        // All-day entries carry `date` instead of `dateTime`: they describe the
        // shape of the day, not a slot of work inside it.
        .filter(|event| event.start.as_ref().and_then(|s| s.date.as_ref()).is_none())
        .filter_map(|event| {
            let start = event.start.as_ref()?.date_time.clone()?;
            let end = event.end.as_ref()?.date_time.clone()?;
            let declined = event.attendees.iter().any(|attendee| {
                attendee.is_self && attendee.response_status.as_deref() == Some("declined")
            });
            Some(CalendarEvent {
                id: event.id.unwrap_or_default(),
                summary: event.summary.unwrap_or_else(|| "(senza titolo)".to_string()),
                start,
                end,
                declined,
                transparent: event.transparency.as_deref() == Some("transparent"),
                event_type: event.event_type.unwrap_or_else(|| "default".to_string()),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_the_rfc7636_example() {
        // Verifier and expected challenge from RFC 7636 appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_url_safe_and_unique() {
        let a = random_token(32);
        let b = random_token(32);
        assert_ne!(a, b);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn redirect_uri_is_the_registered_loopback() {
        assert_eq!(redirect_uri(), "http://127.0.0.1:43117");
    }
}
