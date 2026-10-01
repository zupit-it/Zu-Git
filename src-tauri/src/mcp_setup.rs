//! Whether each assistant is set up to launch `zugit --mcp`.
//!
//! Read only, on purpose: these files belong to other apps, which rewrite them
//! and change their shape on their own schedule. The user registers ZuGit by
//! pasting the commands from Settings (or by letting the assistant do it); all
//! ZuGit does is tell whether that worked — and, above all, notice when the
//! entry points at a ZuGit that is no longer there, which otherwise fails
//! silently after the app is moved or reinstalled.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientStatus {
    /// "claude" | "codex" | "desktop"
    pub client: String,
    /// "connected" — points at this executable;
    /// "missing" — no ZuGit entry (or no config file at all);
    /// "stale" — points at a file that does not exist any more;
    /// "elsewhere" — points at another copy of ZuGit (a dev build, an old install);
    /// "unreadable" — the config file exists but could not be parsed.
    pub state: String,
    /// The command the config points at, when there is an entry.
    pub configured: Option<String>,
    /// Parse error, for "unreadable".
    pub error: Option<String>,
}

/// Server name the commands in Settings register.
const SERVER_NAME: &str = "zugit";

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Claude Code keeps user-scoped servers in `~/.claude.json`, or in
/// `$CLAUDE_CONFIG_DIR/.claude.json` when that is set.
fn claude_code_config() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(|dir| PathBuf::from(dir).join(".claude.json"))
        .or_else(|| home().map(|h| h.join(".claude.json")))
}

fn codex_config() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|h| h.join(".codex")))
        .map(|dir| dir.join("config.toml"))
}

/// `~/Library/Application Support/Claude` on macOS, `%APPDATA%\Claude` on
/// Windows, `~/.config/Claude` on Linux.
fn claude_desktop_config() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("Claude").join("claude_desktop_config.json"))
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The command registered for ZuGit among `(name, command)` server entries: the
/// one named "zugit", or failing that any entry that runs this executable (the
/// user may have picked another name).
fn find_command<'a>(servers: impl Iterator<Item = (&'a str, &'a str)>, current: &Path) -> Option<String> {
    let servers: Vec<(&str, &str)> = servers.collect();
    servers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(SERVER_NAME))
        .or_else(|| servers.iter().find(|(_, command)| same_file(Path::new(command), current)))
        .map(|(_, command)| command.to_string())
}

fn classify(client: &str, configured: Option<String>, current: &Path) -> McpClientStatus {
    let state = match configured.as_deref() {
        None => "missing",
        Some(command) if same_file(Path::new(command), current) => "connected",
        Some(command) if !Path::new(command).exists() => "stale",
        Some(_) => "elsewhere",
    };
    McpClientStatus {
        client: client.to_string(),
        state: state.to_string(),
        configured,
        error: None,
    }
}

fn unreadable(client: &str, error: String) -> McpClientStatus {
    McpClientStatus {
        client: client.to_string(),
        state: "unreadable".to_string(),
        configured: None,
        error: Some(error),
    }
}

/// `mcpServers` of a Claude Code or Claude Desktop config.
fn json_command(text: &str, current: &Path) -> Result<Option<String>, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let Some(servers) = value.get("mcpServers").and_then(|s| s.as_object()) else {
        return Ok(None);
    };
    Ok(find_command(
        servers
            .iter()
            .filter_map(|(name, server)| Some((name.as_str(), server.get("command")?.as_str()?))),
        current,
    ))
}

/// `[mcp_servers.*]` of a Codex config.
fn toml_command(text: &str, current: &Path) -> Result<Option<String>, String> {
    let value: toml::Table = text.parse().map_err(|e: toml::de::Error| e.message().to_string())?;
    let Some(servers) = value.get("mcp_servers").and_then(|s| s.as_table()) else {
        return Ok(None);
    };
    Ok(find_command(
        servers
            .iter()
            .filter_map(|(name, server)| Some((name.as_str(), server.get("command")?.as_str()?))),
        current,
    ))
}

fn status_of(
    client: &str,
    path: Option<PathBuf>,
    current: &Path,
    parse: fn(&str, &Path) -> Result<Option<String>, String>,
) -> McpClientStatus {
    // No config file is the same as no entry: the assistant is not set up (or
    // not installed) — nothing to report beyond "not connected".
    let Some(text) = path.and_then(|p| std::fs::read_to_string(p).ok()) else {
        return classify(client, None, current);
    };
    match parse(&text, current) {
        Ok(configured) => classify(client, configured, current),
        Err(error) => unreadable(client, error),
    }
}

pub fn statuses(current: &Path) -> Vec<McpClientStatus> {
    vec![
        status_of("claude", claude_code_config(), current, json_command),
        status_of("codex", codex_config(), current, toml_command),
        status_of("desktop", claude_desktop_config(), current, json_command),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current() -> PathBuf {
        std::env::current_exe().unwrap()
    }

    #[test]
    fn json_entries_are_found_by_name_or_by_command() {
        let exe = current();
        let exe_str = exe.to_string_lossy();

        let named = r#"{"mcpServers":{"zugit":{"command":"/gone/zugit","args":["--mcp"]}}}"#;
        assert_eq!(json_command(named, &exe).unwrap().as_deref(), Some("/gone/zugit"));

        let renamed = serde_json::json!({"mcpServers": {"toggl": {"command": exe_str, "args": ["--mcp"]}}}).to_string();
        assert_eq!(json_command(&renamed, &exe).unwrap().as_deref(), Some(exe_str.as_ref()));

        assert_eq!(json_command(r#"{"projects":{}}"#, &exe).unwrap(), None);
        assert!(json_command("{ not json", &exe).is_err());
    }

    #[test]
    fn codex_tables_are_read() {
        let exe = current();
        let config = "model = \"o3\"\n\n[mcp_servers.zugit]\ncommand = '/Applications/ZuGit.app/Contents/MacOS/zugit'\nargs = [\"--mcp\"]\n";
        assert_eq!(
            toml_command(config, &exe).unwrap().as_deref(),
            Some("/Applications/ZuGit.app/Contents/MacOS/zugit")
        );
        assert_eq!(toml_command("model = \"o3\"\n", &exe).unwrap(), None);
        assert!(toml_command("[mcp_servers.zugit\n", &exe).is_err());
    }

    #[test]
    fn entries_are_classified_against_this_executable() {
        let exe = current();
        let here = exe.to_string_lossy().to_string();
        // Any file that exists and is not this executable: another copy.
        let other = std::env::temp_dir().to_string_lossy().to_string();

        assert_eq!(classify("claude", Some(here), &exe).state, "connected");
        assert_eq!(classify("claude", Some("/no/such/zugit".into()), &exe).state, "stale");
        assert_eq!(classify("claude", Some(other), &exe).state, "elsewhere");
        assert_eq!(classify("claude", None, &exe).state, "missing");
    }
}
