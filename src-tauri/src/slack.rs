//! Who is who on Slack, so a reviewer can be nudged in a direct message.
//!
//! ZuGit never talks to Slack: it keeps a table of GitHub login → Slack member
//! id (plus the workspace id) and opens the desktop app on that person's DM
//! with a `slack://user` deep link. The message is put on the clipboard; the
//! user pastes and sends it.
//!
//! The table is filled once. An assistant with a Slack connector looks people
//! up and hands ZuGit a *proposal* through `zugit --mcp`; the user reviews it
//! in Settings and only what they save is used.

use serde::{Deserialize, Serialize};

/// How a row of the table was found.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchKind {
    /// The GitHub email is the Slack email.
    Email,
    /// Only the name matches: worth a look before saving.
    Name,
    /// Typed or corrected by the user.
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackPerson {
    pub login: String,
    pub member_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack_name: Option<String>,
    #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
    pub match_kind: Option<MatchKind>,
    /// The assistant's evidence for this row, shown next to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The saved table: what the nudge button reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackDirectory {
    #[serde(default)]
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    #[serde(default)]
    pub people: Vec<SlackPerson>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unmatched {
    pub login: String,
    #[serde(default)]
    pub reason: String,
}

/// What an assistant handed over, waiting for the user in Settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SlackProposal {
    pub created_at: String,
    pub source: String,
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    pub people: Vec<SlackPerson>,
    #[serde(default)]
    pub unmatched: Vec<Unmatched>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

const MAX_TEXT: usize = 200;

/// A workspace id: `T…` (or `E…` for an Enterprise Grid org), upper-case
/// letters and digits.
pub fn valid_team_id(id: &str) -> bool {
    slack_id(id, &['T', 'E'])
}

/// A member id: `U…`, or `W…` on Enterprise Grid.
pub fn valid_member_id(id: &str) -> bool {
    slack_id(id, &['U', 'W'])
}

fn slack_id(id: &str, prefixes: &[char]) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else { return false };
    (3..=24).contains(&id.len())
        && prefixes.contains(&first)
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// GitHub's rule: letters, digits and single hyphens, at most 39 characters,
/// not starting or ending with a hyphen.
pub fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && !login.starts_with('-')
        && !login.ends_with('-')
        && !login.contains("--")
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn clip(text: Option<String>) -> Option<String> {
    let text = text?.trim().to_string();
    (!text.is_empty()).then(|| text.chars().take(MAX_TEXT).collect())
}

fn clean_person(person: SlackPerson) -> Result<SlackPerson, String> {
    let login = person.login.trim().to_string();
    if !valid_login(&login) {
        return Err(format!("'{login}' is not a GitHub login."));
    }
    let member_id = person.member_id.trim().to_uppercase();
    if !valid_member_id(&member_id) {
        return Err(format!(
            "'{member_id}' for {login} is not a Slack member id (it starts with U or W, e.g. U01AB2CD3EF)."
        ));
    }
    Ok(SlackPerson {
        login,
        member_id,
        slack_name: clip(person.slack_name),
        match_kind: person.match_kind,
        note: clip(person.note),
    })
}

/// One row per login (the last one wins), logins compared without case.
fn clean_people(people: Vec<SlackPerson>) -> Result<Vec<SlackPerson>, String> {
    let mut clean: Vec<SlackPerson> = Vec::new();
    for person in people {
        let person = clean_person(person)?;
        clean.retain(|p| !p.login.eq_ignore_ascii_case(&person.login));
        clean.push(person);
    }
    clean.sort_by_key(|p| p.login.to_lowercase());
    Ok(clean)
}

fn clean_team_id(team_id: &str) -> Result<String, String> {
    let team_id = team_id.trim().to_uppercase();
    if !valid_team_id(&team_id) {
        return Err(format!(
            "'{team_id}' is not a Slack workspace id (it starts with T, e.g. T01AB2CD3EF)."
        ));
    }
    Ok(team_id)
}

/// The table as the user saves it: every row checked again, since it comes
/// from a form.
pub fn clean_directory(directory: SlackDirectory) -> Result<SlackDirectory, String> {
    let people = clean_people(directory.people)?;
    // An empty table needs no workspace: it just switches nudges off.
    let team_id = if people.is_empty() && directory.team_id.trim().is_empty() {
        String::new()
    } else {
        clean_team_id(&directory.team_id)?
    };
    Ok(SlackDirectory {
        team_id,
        team_name: clip(directory.team_name),
        people,
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

pub fn clean_proposal(proposal: SlackProposal) -> Result<SlackProposal, String> {
    let team_id = clean_team_id(&proposal.team_id)?;
    let people = clean_people(proposal.people)?;
    let mut unmatched: Vec<Unmatched> = Vec::new();
    for item in proposal.unmatched {
        let login = item.login.trim().to_string();
        if !valid_login(&login) {
            return Err(format!("'{login}' in unmatched is not a GitHub login."));
        }
        if people.iter().any(|p| p.login.eq_ignore_ascii_case(&login))
            || unmatched.iter().any(|u| u.login.eq_ignore_ascii_case(&login))
        {
            continue;
        }
        unmatched.push(Unmatched {
            login,
            reason: clip(Some(item.reason)).unwrap_or_default(),
        });
    }
    if people.is_empty() && unmatched.is_empty() {
        return Err("The proposal is empty: add people, or list in unmatched who you could not find.".into());
    }
    Ok(SlackProposal {
        team_id,
        team_name: clip(proposal.team_name),
        people,
        unmatched,
        note: clip(proposal.note),
        ..proposal
    })
}

impl SlackDirectory {
    pub fn member(&self, login: &str) -> Option<&SlackPerson> {
        self.people.iter().find(|p| p.login.eq_ignore_ascii_case(login))
    }
}

// ── Sharing the table ────────────────────────────────────────────────────────
// One person fills it, the others import their file: it holds GitHub logins,
// Slack names and ids, nothing secret.

pub const EXPORT_FORMAT: &str = "zugit-slack-people";
pub const EXPORT_FILE: &str = "zugit-slack-people.json";
/// A team's table is a few kilobytes; anything far bigger is not one.
pub const MAX_IMPORT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    #[serde(default)]
    pub exported_at: String,
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    pub people: Vec<SlackPerson>,
}

pub fn export_file(directory: &SlackDirectory) -> Result<ExportFile, String> {
    if directory.people.is_empty() || directory.team_id.is_empty() {
        return Err("La tabella salvata è vuota: compilala e salvala prima di esportarla.".into());
    }
    Ok(ExportFile {
        format: EXPORT_FORMAT.into(),
        version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        team_id: directory.team_id.clone(),
        team_name: directory.team_name.clone(),
        people: directory.people.clone(),
    })
}

/// A shared file, as a proposal to review: an import is checked like what an
/// assistant hands over, and used only once the user saves it.
pub fn import_proposal(content: &str, file_name: &str) -> Result<SlackProposal, String> {
    if content.len() > MAX_IMPORT_BYTES {
        return Err("Il file è troppo grande per essere una tabella di ZuGit.".into());
    }
    let file: ExportFile = serde_json::from_str(content)
        .map_err(|_| "Il file non è una tabella Slack esportata da ZuGit.".to_string())?;
    if file.format != EXPORT_FORMAT {
        return Err("Il file non è una tabella Slack esportata da ZuGit.".into());
    }
    if file.version != 1 {
        return Err(format!(
            "Il file è della versione {} della tabella: aggiorna ZuGit per importarlo.",
            file.version
        ));
    }
    let name: String = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    clean_proposal(SlackProposal {
        created_at: chrono::Utc::now().to_rfc3339(),
        source: if name.is_empty() { "file".into() } else { format!("file {name}") },
        team_id: file.team_id,
        team_name: file.team_name,
        people: file.people,
        unmatched: vec![],
        note: None,
    })
}

/// The DM with that member in the Slack desktop app. Both ids are checked, so
/// nothing else can be smuggled into the URL.
pub fn dm_url(team_id: &str, member_id: &str) -> Result<String, String> {
    if !valid_team_id(team_id) {
        return Err("The Slack workspace id is missing: set it in Settings → Slack.".into());
    }
    if !valid_member_id(member_id) {
        return Err(format!("'{member_id}' is not a Slack member id."));
    }
    Ok(format!("slack://user?team={team_id}&id={member_id}"))
}

/// A first guess at a person's name from a login like `mario-rossi-zupit`:
/// the internal marker and hyphens dropped.
pub fn name_hint(login: &str, marker: &str) -> String {
    let marker = marker.trim();
    let base = if !marker.is_empty() && login.to_lowercase().ends_with(&marker.to_lowercase()) {
        login.get(..login.len().saturating_sub(marker.len())).unwrap_or(login)
    } else {
        login
    };
    base.split(['-', '_', '.'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(login: &str, member_id: &str) -> SlackPerson {
        SlackPerson {
            login: login.into(),
            member_id: member_id.into(),
            slack_name: None,
            match_kind: Some(MatchKind::Email),
            note: None,
        }
    }

    #[test]
    fn ids_follow_slacks_shapes() {
        assert!(valid_team_id("T01AB2CD3EF"));
        assert!(valid_team_id("E0ABC"));
        assert!(!valid_team_id("U01AB2CD3EF"));
        assert!(!valid_team_id("T01&id=U1"));
        assert!(!valid_team_id("t01ab"));
        assert!(valid_member_id("U01AB2CD3EF"));
        assert!(valid_member_id("W0ABC"));
        assert!(!valid_member_id("C01AB2CD3EF"));
        assert!(!valid_member_id("U1"));
    }

    #[test]
    fn logins_follow_githubs_rule() {
        assert!(valid_login("mario-rossi-zupit"));
        assert!(!valid_login("-mario"));
        assert!(!valid_login("mario--rossi"));
        assert!(!valid_login("../etc"));
        assert!(!valid_login(&"a".repeat(40)));
    }

    #[test]
    fn the_deep_link_is_built_from_checked_ids_only() {
        assert_eq!(dm_url("T01AB", "U02CD").unwrap(), "slack://user?team=T01AB&id=U02CD");
        assert!(dm_url("", "U02CD").is_err());
        assert!(dm_url("T01AB", "U02CD&x=1").is_err());
    }

    #[test]
    fn saving_normalises_ids_and_keeps_one_row_per_login() {
        let directory = clean_directory(SlackDirectory {
            team_id: " t01ab ".into(),
            team_name: Some("  Zupit ".into()),
            people: vec![person("Luca-zupit", "u0old"), person("anna", "U0ANNA"), person("luca-zupit", "u0new")],
            updated_at: None,
        })
        .unwrap();
        assert_eq!(directory.team_id, "T01AB");
        assert_eq!(directory.team_name.as_deref(), Some("Zupit"));
        let rows: Vec<(&str, &str)> = directory.people.iter().map(|p| (p.login.as_str(), p.member_id.as_str())).collect();
        assert_eq!(rows, vec![("anna", "U0ANNA"), ("luca-zupit", "U0NEW")]);
        assert_eq!(directory.member("LUCA-ZUPIT").unwrap().member_id, "U0NEW");
    }

    #[test]
    fn an_empty_table_needs_no_workspace_but_rows_do() {
        assert!(clean_directory(SlackDirectory::default()).is_ok());
        let missing = SlackDirectory { people: vec![person("anna", "U0ANNA")], ..Default::default() };
        assert!(clean_directory(missing).is_err());
    }

    #[test]
    fn proposals_are_checked_and_unmatched_found_people_dropped() {
        let proposal = SlackProposal {
            created_at: "now".into(),
            source: "claude-code".into(),
            team_id: "T01AB".into(),
            team_name: None,
            people: vec![person("anna", "U0ANNA")],
            unmatched: vec![
                Unmatched { login: "anna".into(), reason: "dup".into() },
                Unmatched { login: "piero".into(), reason: "no Slack account with this name".into() },
            ],
            note: None,
        };
        let clean = clean_proposal(proposal.clone()).unwrap();
        assert_eq!(clean.unmatched.len(), 1);
        assert_eq!(clean.unmatched[0].login, "piero");

        let bad = SlackProposal { people: vec![person("anna", "C0CHANNEL")], ..proposal.clone() };
        assert!(clean_proposal(bad).is_err());
        let empty = SlackProposal { people: vec![], unmatched: vec![], ..proposal };
        assert!(clean_proposal(empty).is_err());
    }

    #[test]
    fn names_are_guessed_from_logins() {
        assert_eq!(name_hint("mario-rossi-zupit", "-zupit"), "mario rossi");
        assert_eq!(name_hint("anna.bianchi", "-zupit"), "anna bianchi");
        assert_eq!(name_hint("luca", ""), "luca");
    }

    #[test]
    fn an_exported_table_comes_back_as_a_proposal() {
        let directory = SlackDirectory {
            team_id: "T0ZUPIT".into(),
            team_name: Some("Zupit".into()),
            people: vec![person("anna", "U0ANNA"), SlackPerson { match_kind: Some(MatchKind::Manual), ..person("luca", "U0LUCA") }],
            updated_at: None,
        };
        let content = serde_json::to_string(&export_file(&directory).unwrap()).unwrap();
        let proposal = import_proposal(&content, "/Users/x/Downloads/zugit-slack-people.json").unwrap();
        assert_eq!(proposal.source, "file zugit-slack-people.json");
        assert_eq!(proposal.team_id, "T0ZUPIT");
        assert_eq!(proposal.team_name.as_deref(), Some("Zupit"));
        assert_eq!(proposal.people, directory.people);
        assert!(proposal.unmatched.is_empty());
    }

    #[test]
    fn only_zugit_tables_with_valid_ids_are_imported() {
        assert!(export_file(&SlackDirectory::default()).is_err());
        assert!(import_proposal("not json", "x.json").is_err());
        assert!(import_proposal(r#"{"format":"other","version":1,"teamId":"T0","people":[]}"#, "x.json").is_err());
        let newer = r#"{"format":"zugit-slack-people","version":2,"teamId":"T0ZUPIT","people":[{"login":"anna","memberId":"U0ANNA"}]}"#;
        assert!(import_proposal(newer, "x.json").unwrap_err().contains("versione 2"));
        let channel = r#"{"format":"zugit-slack-people","version":1,"teamId":"T0ZUPIT","people":[{"login":"anna","memberId":"C0CHAN"}]}"#;
        assert!(import_proposal(channel, "x.json").is_err());
        assert!(import_proposal(&" ".repeat(MAX_IMPORT_BYTES + 1), "x.json").is_err());
    }

    #[test]
    fn the_match_kind_is_written_as_match() {
        let json = serde_json::to_value(person("anna", "U0ANNA")).unwrap();
        assert_eq!(json["match"], "email");
        assert_eq!(json["memberId"], "U0ANNA");
    }
}
