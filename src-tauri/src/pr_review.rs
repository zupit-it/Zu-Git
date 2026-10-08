//! AI review proposals: comments an agent hands ZuGit through `zugit --mcp`,
//! shown in the PR diff view.
//!
//! How the agent got the code is its own business; ZuGit only checks that
//! each comment points at a line the diff shows. Proposals stay on this
//! machine — the user keeps, edits or discards every comment in ZuGit, and
//! nothing reaches GitHub from here.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::models::PrFileDiff;

/// Proposals older than this are dropped: by then the PR has moved on.
pub const KEEP_DAYS: i64 = 30;

const MAX_COMMENTS: usize = 150;
const MAX_BODY_CHARS: usize = 6000;
/// GitHub's own limit for a review comment.
const MAX_USER_BODY_CHARS: usize = 65_536;
/// A comment's code snippet past this is dropped rather than cut: half a hunk misreads.
const MAX_HUNK_CHARS: usize = 20_000;
const MAX_SUMMARY_CHARS: usize = 4000;
const MAX_GROUPS: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// The head file — added and context lines.
    #[default]
    New,
    /// The base file — removed and context lines.
    Old,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Bug,
    Suggestion,
    Nit,
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    /// Anchored to a line the diff shows.
    #[default]
    Inline,
    /// About the PR, a whole file, or a line outside the diff.
    General,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CommentStatus {
    #[default]
    Pending,
    Kept,
    Discarded,
}

/// A comment as the agent sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposedComment {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub side: Side,
    pub severity: Severity,
    pub body: String,
    #[serde(default)]
    pub suggestion: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiComment {
    pub id: String,
    pub path: Option<String>,
    /// First line of the range.
    pub line: Option<u32>,
    /// Last line, for multi-line comments; the view anchors the card there.
    pub end_line: Option<u32>,
    pub side: Side,
    pub severity: Severity,
    pub body: String,
    pub suggestion: Option<String>,
    pub placement: Placement,
    /// Kept means the user took it: it lives on in their comments.
    #[serde(default)]
    pub status: CommentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGroup {
    pub title: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReview {
    pub repo: String,
    pub number: u64,
    /// The commit the agent reviewed. Behind the PR's head, the proposal is outdated.
    pub head_sha: String,
    /// MCP client that proposed it ("claude-code", "codex-mcp-client"…).
    pub source: String,
    pub created_at: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub order: Vec<ReviewGroup>,
    pub comments: Vec<AiComment>,
}

/// One proposal in the dashboard's list: enough for a badge on the PR row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiReviewSummary {
    pub repo: String,
    pub number: u64,
    pub source: String,
    pub head_sha: String,
    pub created_at: String,
    pub pending: usize,
}

impl AiReview {
    pub fn summary(&self) -> AiReviewSummary {
        AiReviewSummary {
            repo: self.repo.clone(),
            number: self.number,
            source: self.source.clone(),
            head_sha: self.head_sha.clone(),
            created_at: self.created_at.clone(),
            pending: self
                .comments
                .iter()
                .filter(|c| c.status == CommentStatus::Pending)
                .count(),
        }
    }
}

// ── The user's comments ──────────────────────────────────────────────────────

/// A comment of the user's own: written on lines they selected in the diff, or
/// an AI comment they kept. It stays on this machine like the proposals, but a
/// new proposal from the agent never touches it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserComment {
    pub id: String,
    pub path: Option<String>,
    /// First line of the range.
    pub line: Option<u32>,
    /// Last line, for multi-line comments; the view anchors the card there.
    pub end_line: Option<u32>,
    pub side: Side,
    pub body: String,
    /// Set on a kept AI comment only.
    #[serde(default)]
    pub severity: Option<Severity>,
    #[serde(default)]
    pub suggestion: Option<String>,
    pub placement: Placement,
    /// The commit the lines belong to: behind the PR's head, they may have moved.
    pub head_sha: String,
    /// The code it was written on, as a diff hunk ending on its last line — GitHub's
    /// `diffHunk`. On a newer commit it tells whether that code is still the same.
    #[serde(default)]
    pub diff_hunk: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub kept_from: Option<KeptFrom>,
}

/// The AI comment a user comment was kept from. The proposal's creation time
/// is part of it: a new proposal from the same agent numbers its comments from
/// c1 again, so the id alone could point at another comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptFrom {
    pub source: String,
    pub created_at: String,
    pub id: String,
}

/// A reply to one of GitHub's conversations, waiting for the review it goes
/// out with — as a reply added to a review on GitHub waits for its submit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserReply {
    pub id: String,
    /// GitHub's id of the conversation (a `PullRequestReviewThread`).
    pub thread_id: String,
    pub body: String,
    pub created_at: String,
}

/// The user's review of one PR in the making: comments, replies to GitHub's
/// conversations, and the text that heads it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserReview {
    pub repo: String,
    pub number: u64,
    pub comments: Vec<UserComment>,
    #[serde(default)]
    pub replies: Vec<UserReply>,
    /// The review's own text, written ahead of publishing.
    #[serde(default)]
    pub summary: Option<String>,
}

/// Lines the user selected in the diff, and what they wrote on them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewComment {
    pub path: String,
    pub line: u32,
    #[serde(default)]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub side: Side,
    pub head_sha: String,
    #[serde(default)]
    pub diff_hunk: Option<String>,
    pub body: String,
}

/// What a keep or a delete changed: the user's comments, plus the proposal
/// whose comment moved, when there is one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentChange {
    pub mine: UserReview,
    pub review: Option<AiReview>,
}

/// A commit id, full or abbreviated — what goes into a GitHub URL, and nothing else.
pub fn is_sha(text: &str) -> bool {
    (7..=40).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether the commit the reviewer looked at is the PR's latest: a verdict on
/// anything newer would be on code they have not seen.
pub fn same_commit(viewed: &str, latest: &str) -> bool {
    let viewed = viewed.trim().to_lowercase();
    is_sha(&viewed) && latest.trim().to_lowercase().starts_with(&viewed)
}

fn snippet(diff_hunk: Option<&str>) -> Option<String> {
    diff_hunk.filter(|h| h.starts_with("@@") && h.len() <= MAX_HUNK_CHARS).map(str::to_string)
}

fn user_body(body: &str) -> Result<String, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("The comment is empty.".into());
    }
    if body.chars().count() > MAX_USER_BODY_CHARS {
        return Err(format!("The comment is over {MAX_USER_BODY_CHARS} characters."));
    }
    Ok(body.to_string())
}

impl UserReview {
    pub fn new(repo: &str, number: u64) -> Self {
        Self { repo: repo.to_string(), number, comments: vec![], replies: vec![], summary: None }
    }

    /// Nothing written yet: no file is kept for it.
    pub fn is_empty(&self) -> bool {
        self.comments.is_empty() && self.replies.is_empty() && self.summary.is_none()
    }

    /// "r1", "r2"…: one past the highest reply id in use.
    fn next_reply_id(&self) -> String {
        let last = self
            .replies
            .iter()
            .filter_map(|r| r.id.strip_prefix('r')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        format!("r{}", last + 1)
    }

    pub fn add_reply(&mut self, thread_id: &str, body: &str, now: &str) -> Result<(), String> {
        let thread_id = thread_id.trim();
        if thread_id.is_empty() || thread_id.len() > 200 {
            return Err("This conversation is not known to ZuGit.".into());
        }
        let reply = UserReply {
            id: self.next_reply_id(),
            thread_id: thread_id.to_string(),
            body: user_body(body)?,
            created_at: now.to_string(),
        };
        self.replies.push(reply);
        Ok(())
    }

    pub fn edit_reply(&mut self, id: &str, body: &str) -> Result<(), String> {
        let body = user_body(body)?;
        let reply = self.replies.iter_mut().find(|r| r.id == id).ok_or("This reply is gone.")?;
        reply.body = body;
        Ok(())
    }

    pub fn remove_reply(&mut self, id: &str) -> bool {
        let before = self.replies.len();
        self.replies.retain(|r| r.id != id);
        self.replies.len() != before
    }

    pub fn set_summary(&mut self, text: &str) -> Result<(), String> {
        let text = text.trim();
        if text.chars().count() > MAX_USER_BODY_CHARS {
            return Err(format!("The summary is over {MAX_USER_BODY_CHARS} characters."));
        }
        self.summary = (!text.is_empty()).then(|| text.to_string());
        Ok(())
    }

    /// Drops what GitHub now has: the comments and replies `ids` names, as
    /// they were in `sent` when they went out, and with the main review the
    /// summary that headed it. What was written meanwhile is not out, and
    /// stays: a reworded summary, a new comment given the id of one deleted.
    pub fn published(&mut self, ids: &[String], sent: &UserReview, summary_too: bool) {
        let out = |id: &str, created_at: &str| {
            ids.iter().any(|i| i == id)
                && (sent.comments.iter().any(|c| c.id == id && c.created_at == created_at)
                    || sent.replies.iter().any(|r| r.id == id && r.created_at == created_at))
        };
        self.comments.retain(|c| !out(&c.id, &c.created_at));
        self.replies.retain(|r| !out(&r.id, &r.created_at));
        if summary_too && self.summary == sent.summary {
            self.summary = None;
        }
    }

    /// "u1", "u2"…: one past the highest id in use.
    fn next_id(&self) -> String {
        let last = self
            .comments
            .iter()
            .filter_map(|c| c.id.strip_prefix('u')?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        format!("u{}", last + 1)
    }

    pub fn add(&mut self, new: NewComment, now: &str) -> Result<(), String> {
        let path = new.path.trim().to_string();
        if path.is_empty() || new.line == 0 {
            return Err("A comment needs a file and a line.".into());
        }
        let end_line = match new.end_line {
            Some(end) if end < new.line => return Err(format!("Line {end} is before line {}.", new.line)),
            Some(end) if end > new.line => Some(end),
            _ => None,
        };
        let head_sha = new.head_sha.trim().to_lowercase();
        if !is_sha(&head_sha) {
            return Err("A comment needs the commit its lines belong to.".into());
        }
        let comment = UserComment {
            id: self.next_id(),
            path: Some(path),
            line: Some(new.line),
            end_line,
            side: new.side,
            body: user_body(&new.body)?,
            severity: None,
            suggestion: None,
            placement: Placement::Inline,
            head_sha,
            diff_hunk: snippet(new.diff_hunk.as_deref()),
            created_at: now.to_string(),
            kept_from: None,
        };
        self.comments.push(comment);
        Ok(())
    }

    pub fn edit(&mut self, id: &str, body: &str) -> Result<(), String> {
        let body = user_body(body)?;
        let comment = self.comments.iter_mut().find(|c| c.id == id).ok_or("This comment is gone.")?;
        comment.body = body;
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Option<UserComment> {
        let at = self.comments.iter().position(|c| c.id == id)?;
        Some(self.comments.remove(at))
    }
}

/// Makes an AI comment the user's, reworded when `body` is given. The AI
/// comment stays in its proposal as kept, so the agent's counts still add up.
/// `diff_hunk` is its code as the view shows it, when the view is on the
/// commit the agent reviewed.
pub fn keep_comment(
    review: &mut AiReview,
    id: &str,
    body: Option<&str>,
    diff_hunk: Option<&str>,
    mine: &mut UserReview,
    now: &str,
) -> Result<(), String> {
    let from = KeptFrom { source: review.source.clone(), created_at: review.created_at.clone(), id: id.to_string() };
    // Kept already (a double click): nothing to add.
    if mine.comments.iter().any(|c| c.kept_from.as_ref() == Some(&from)) {
        return Ok(());
    }
    let head_sha = review.head_sha.clone();
    let comment = review
        .comments
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or("This comment is gone — the agent may have replaced its review.")?;
    let body = match body {
        Some(text) => user_body(text)?,
        None => comment.body.clone(),
    };
    let kept = UserComment {
        id: mine.next_id(),
        path: comment.path.clone(),
        line: comment.line,
        end_line: comment.end_line,
        side: comment.side,
        body,
        severity: Some(comment.severity),
        suggestion: comment.suggestion.clone(),
        placement: comment.placement,
        head_sha,
        diff_hunk: snippet(diff_hunk),
        created_at: now.to_string(),
        kept_from: Some(from),
    };
    mine.comments.push(kept);
    comment.status = CommentStatus::Kept;
    Ok(())
}

/// A deleted user comment that was kept from this proposal goes back to it as
/// discarded, where Undo can still bring it back. False when it came from
/// another proposal: after a replacement, the same id is another comment.
pub fn release_kept(review: &mut AiReview, from: &KeptFrom) -> bool {
    if review.source != from.source || review.created_at != from.created_at {
        return false;
    }
    match review.comments.iter_mut().find(|c| c.id == from.id && c.status == CommentStatus::Kept) {
        Some(comment) => {
            comment.status = CommentStatus::Discarded;
            true
        }
        None => false,
    }
}

// ── Diff lines ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone)]
struct PatchLine {
    kind: LineKind,
    old: Option<u32>,
    new: Option<u32>,
    text: String,
}

#[derive(Debug, Clone)]
struct Hunk {
    old_start: u32,
    old_count: u32,
    new_count: u32,
    lines: Vec<PatchLine>,
}

/// "-12,9" or "+12" → (12, 9) or (12, 1): a count left out means one line.
fn hunk_range(range: &str) -> Option<(u32, u32)> {
    let range = range.trim_start_matches(['-', '+']);
    let (start, count) = range.split_once(',').unwrap_or((range, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}

/// The hunks of a unified-diff patch, each line numbered on both sides.
fn parse_hunks(patch: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = Vec::new();
    let (mut o, mut n) = (0u32, 0u32);
    let mut in_hunk = false;
    for row in patch.lines() {
        if let Some(header) = row.strip_prefix("@@ ") {
            // "@@ -12,9 +12,14 @@ section"
            let mut ranges = header.split(' ');
            in_hunk = match (ranges.next().and_then(hunk_range), ranges.next().and_then(hunk_range)) {
                (Some((old_start, old_count)), Some((new_start, new_count))) => {
                    (o, n) = (old_start, new_start);
                    hunks.push(Hunk { old_start, old_count, new_count, lines: vec![] });
                    true
                }
                _ => false,
            };
            continue;
        }
        // "\ No newline at end of file" describes the line above, it is not code.
        if !in_hunk || row.starts_with('\\') {
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        let text = row.get(1..).unwrap_or("").to_string();
        let line = match row.as_bytes().first() {
            Some(b'+') => {
                n += 1;
                PatchLine { kind: LineKind::Added, old: None, new: Some(n - 1), text }
            }
            Some(b'-') => {
                o += 1;
                PatchLine { kind: LineKind::Removed, old: Some(o - 1), new: None, text }
            }
            _ => {
                o += 1;
                n += 1;
                PatchLine { kind: LineKind::Context, old: Some(o - 1), new: Some(n - 1), text }
            }
        };
        hunk.lines.push(line);
    }
    hunks
}

/// One file's lines in the diff, per side: their hunk and their code.
#[derive(Debug, Default)]
struct FileLines {
    old: BTreeMap<u32, (usize, String)>,
    new: BTreeMap<u32, (usize, String)>,
}

impl FileLines {
    fn of(patch: &str) -> Self {
        let mut lines = Self::default();
        for (h, hunk) in parse_hunks(patch).into_iter().enumerate() {
            for l in hunk.lines {
                if let Some(o) = l.old {
                    lines.old.insert(o, (h, l.text.clone()));
                }
                if let Some(n) = l.new {
                    lines.new.insert(n, (h, l.text));
                }
            }
        }
        lines
    }

    fn side(&self, side: Side) -> &BTreeMap<u32, (usize, String)> {
        match side {
            Side::Old => &self.old,
            Side::New => &self.new,
        }
    }
}

/// The lines each file shows in the diff, per side — the only lines GitHub
/// accepts an inline review comment on — with their hunk and their code.
#[derive(Debug, Default)]
pub struct DiffIndex {
    files: HashMap<String, FileLines>,
}

impl DiffIndex {
    pub fn new(files: &[PrFileDiff]) -> Self {
        let files = files
            .iter()
            .map(|f| (f.filename.clone(), f.patch.as_deref().map(FileLines::of).unwrap_or_default()))
            .collect();
        Self { files }
    }

    pub fn has_file(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    fn line(&self, path: &str, side: Side, line: u32) -> Option<&(usize, String)> {
        self.files.get(path)?.side(side).get(&line)
    }

    fn shows(&self, path: &str, side: Side, line: u32) -> bool {
        self.line(path, side, line).is_some()
    }

    /// GitHub takes a range only within one hunk.
    fn same_hunk(&self, path: &str, side: Side, first: u32, last: u32) -> bool {
        matches!((self.line(path, side, first), self.line(path, side, last)), (Some((a, _)), Some((b, _))) if a == b)
    }

    /// Whether a comment's code (`diff_hunk`) reads the same at the same lines here.
    fn same_code(&self, path: &str, side: Side, first: u32, last: u32, diff_hunk: &str) -> bool {
        let then = FileLines::of(diff_hunk);
        (first..=last).all(|n| match (then.side(side).get(&n), self.line(path, side, n)) {
            (Some((_, was)), Some((_, is))) => was == is,
            _ => false,
        })
    }
}

/// (base lines, head lines) a unified-diff patch shows.
#[cfg(test)]
fn patch_lines(patch: &str) -> (BTreeSet<u32>, BTreeSet<u32>) {
    let lines = FileLines::of(patch);
    (lines.old.keys().copied().collect(), lines.new.keys().copied().collect())
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Comments placed on the diff, plus notes for the agent on anything moved.
/// Hard errors are only for input it must fix: an empty body, too many comments.
pub fn place_comments(
    proposed: Vec<ProposedComment>,
    index: &DiffIndex,
) -> Result<(Vec<AiComment>, Vec<String>), String> {
    if proposed.len() > MAX_COMMENTS {
        return Err(format!(
            "{} comments — at most {MAX_COMMENTS}. Keep the ones a reviewer would act on.",
            proposed.len()
        ));
    }
    let mut notes = Vec::new();
    let mut out = Vec::with_capacity(proposed.len());

    for (i, c) in proposed.into_iter().enumerate() {
        let n = i + 1;
        let body = c.body.trim().to_string();
        if body.is_empty() {
            return Err(format!("Comment {n} has an empty body."));
        }
        if body.chars().count() > MAX_BODY_CHARS {
            return Err(format!("Comment {n} is over {MAX_BODY_CHARS} characters."));
        }
        let path = c.path.map(|p| p.trim().trim_start_matches("./").to_string()).filter(|p| !p.is_empty());
        let end_line = match (c.line, c.end_line) {
            (Some(start), Some(end)) if end > start => Some(end),
            (Some(start), Some(end)) if end < start => {
                return Err(format!("Comment {n}: endLine {end} is before line {start}."));
            }
            _ => None,
        };

        let placement = match (&path, c.line) {
            (Some(p), Some(_)) if !index.has_file(p) => {
                notes.push(format!("Comment {n}: {p} is not changed by this PR — kept as a general comment."));
                Placement::General
            }
            (Some(p), Some(line)) => {
                let last = end_line.unwrap_or(line);
                if index.shows(p, c.side, line) && index.shows(p, c.side, last) {
                    Placement::Inline
                } else {
                    notes.push(format!(
                        "Comment {n}: {p}:{line} ({}) is outside the diff — kept as a general comment.",
                        if c.side == Side::New { "new" } else { "old" }
                    ));
                    Placement::General
                }
            }
            _ => Placement::General,
        };

        out.push(AiComment {
            id: format!("c{n}"),
            path,
            line: c.line,
            end_line,
            side: c.side,
            severity: c.severity,
            body,
            suggestion: c.suggestion.filter(|s| !s.trim().is_empty()),
            placement,
            status: CommentStatus::Pending,
        });
    }
    Ok((out, notes))
}

/// Reading order, limited to files the PR changes.
pub fn clean_order(groups: Vec<ReviewGroup>, index: &DiffIndex, notes: &mut Vec<String>) -> Vec<ReviewGroup> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for group in groups.into_iter().take(MAX_GROUPS) {
        let mut files = Vec::new();
        for file in group.files {
            let file = file.trim().trim_start_matches("./").to_string();
            if !index.has_file(&file) {
                notes.push(format!("Order: {file} is not changed by this PR — left out."));
            } else if seen.insert(file.clone()) {
                files.push(file);
            }
        }
        if files.is_empty() {
            continue;
        }
        out.push(ReviewGroup {
            title: truncate(group.title.trim(), 120),
            files,
            why: truncate(group.why.trim(), 400),
        });
    }
    out
}

pub fn clean_summary(summary: Option<String>) -> Option<String> {
    summary
        .map(|s| truncate(s.trim(), MAX_SUMMARY_CHARS))
        .filter(|s| !s.is_empty())
}

fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// `owner/name`, as configured in ZuGit and as GitHub spells it.
pub fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |s: Option<&str>| {
        s.is_some_and(|s| {
            !s.is_empty()
                && s != "."
                && s != ".."
                && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
    };
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

/// A PR as people paste it: a GitHub URL, `owner/name#12` or `owner/name/pull/12`.
pub fn parse_pr_ref(text: &str) -> Option<(String, u64)> {
    let text = text.trim().trim_end_matches('/');
    let path = text
        .split_once("://")
        .map(|(_, rest)| rest.split_once('/').map(|(_, path)| path).unwrap_or(""))
        .unwrap_or(text);
    let (repo, number) = if let Some((repo, number)) = path.split_once('#') {
        (repo.to_string(), number)
    } else {
        let parts: Vec<&str> = path.split('/').collect();
        match parts.as_slice() {
            [owner, name, "pull" | "pulls", number, ..] => (format!("{owner}/{name}"), *number),
            _ => return None,
        }
    };
    let number = number.parse::<u64>().ok().filter(|n| *n > 0)?;
    valid_repo(&repo).then_some((repo, number))
}

// ── Carrying comments to the latest commit ───────────────────────────────────

/// One file's change between two commits of the PR.
#[derive(Debug, Clone)]
pub struct FileChange {
    pub path: String,
    pub previous_path: Option<String>,
    pub status: String,
    /// None for binary files and changes too large for GitHub to inline.
    pub patch: Option<String>,
}

/// From an older commit of the PR to its latest.
#[derive(Debug, Clone)]
pub struct CommitCompare {
    /// The older commit is an ancestor of the newer, so lines can be followed
    /// from one to the other. After a force-push they cannot.
    pub linear: bool,
    pub files: Vec<FileChange>,
    /// GitHub lists 300 changed files at most: past that, a file missing from
    /// the list may have changed all the same.
    pub complete: bool,
}

/// Where a comment sits: its file and lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub path: String,
    pub line: u32,
    pub end_line: Option<u32>,
}

/// A comment written on an older commit, seen from the PR's latest one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Carry {
    /// Its code did not change: the same comment, maybe on other lines.
    Moved(Position),
    /// Its code changed: it stays on the commit it was written on.
    Outdated,
    /// Saved without its code, on removed lines: nobody can tell.
    Unknown,
}

/// Where line `line` of the older file lands in the newer one, through the
/// patch between the two; None when the patch changes that line.
fn carry_line(hunks: &[Hunk], line: u32) -> Option<u32> {
    let mut offset = 0i64;
    for hunk in hunks {
        // A hunk that only adds lines (count 0) sits after its start line.
        let before = if hunk.old_count == 0 { line <= hunk.old_start } else { line < hunk.old_start };
        if before {
            break;
        }
        if hunk.old_count > 0 && line < hunk.old_start + hunk.old_count {
            let at = hunk.lines.iter().find(|l| l.old == Some(line))?;
            return if at.kind == LineKind::Context { at.new } else { None };
        }
        offset += i64::from(hunk.new_count) - i64::from(hunk.old_count);
    }
    u32::try_from(i64::from(line) + offset).ok()
}

/// Where a comment written on an older commit sits on the latest one, as
/// GitHub carries it: unchanged code keeps its comment, changed code makes it
/// outdated. Lines of the head follow the patch between the two commits;
/// removed lines, on the base side, must read the same.
pub fn carry(comment: &UserComment, compare: Option<&CommitCompare>, index: &DiffIndex) -> Carry {
    let (Some(path), Some(line)) = (comment.path.as_deref(), comment.line) else {
        return Carry::Outdated;
    };
    let last = comment.end_line.unwrap_or(line);
    let by_code = || match &comment.diff_hunk {
        Some(hunk) if index.same_code(path, comment.side, line, last, hunk) => {
            Carry::Moved(Position { path: path.to_string(), line, end_line: comment.end_line })
        }
        Some(_) => Carry::Outdated,
        None => Carry::Unknown,
    };
    if comment.side == Side::Old {
        return by_code();
    }
    // GitHub could not be asked: the comment's own code decides.
    let Some(compare) = compare else { return by_code() };
    if !compare.linear {
        return Carry::Outdated;
    }
    let change = compare.files.iter().find(|f| f.path == path || f.previous_path.as_deref() == Some(path));
    let (to, first, end) = match change {
        None if compare.complete => (path.to_string(), line, last),
        None => return by_code(),
        Some(f) if f.status == "removed" => return Carry::Outdated,
        Some(f) => {
            let Some(patch) = f.patch.as_deref() else { return Carry::Outdated };
            let hunks = parse_hunks(patch);
            let moved: Option<Vec<u32>> = (line..=last).map(|n| carry_line(&hunks, n)).collect();
            match moved.as_deref() {
                // Every line unchanged, still one after the other.
                Some(m) if !m.is_empty() && m.windows(2).all(|w| w[1] == w[0] + 1) => {
                    (f.path.clone(), m[0], m[m.len() - 1])
                }
                _ => return Carry::Outdated,
            }
        }
    };
    // Unchanged, but a comment needs its lines in the PR's diff to sit on them.
    if index.shows(&to, Side::New, first) && index.shows(&to, Side::New, end) {
        Carry::Moved(Position { path: to, line: first, end_line: (end > first).then_some(end) })
    } else {
        Carry::Outdated
    }
}

/// Where one of the user's comments written on an older commit sits on `head_sha`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPosition {
    pub id: String,
    /// "moved", "outdated" or "unknown".
    pub state: &'static str,
    pub position: Option<Position>,
    pub head_sha: String,
}

impl CommentPosition {
    pub fn new(id: String, carry: Carry, head_sha: &str) -> Self {
        let (state, position) = match carry {
            Carry::Moved(p) => ("moved", Some(p)),
            Carry::Outdated => ("outdated", None),
            Carry::Unknown => ("unknown", None),
        };
        Self { id, state, position, head_sha: head_sha.to_string() }
    }
}

// ── Publishing ───────────────────────────────────────────────────────────────

/// What a publish did: the reviews GitHub accepted (the main one first) and
/// those it refused, whose comments stay in ZuGit.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub published: Vec<PublishedReview>,
    pub failed: Vec<FailedReview>,
    pub mine: UserReview,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedReview {
    pub commit: String,
    pub url: String,
    pub comments: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedReview {
    pub commit: String,
    pub error: String,
    pub comments: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

impl ReviewEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewEvent::Comment => "COMMENT",
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
        }
    }
}

/// A comment as GitHub's create-review endpoint takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DraftComment {
    pub path: String,
    pub line: u32,
    pub side: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_side: Option<&'static str>,
    pub body: String,
}

/// A reply to one of GitHub's conversations, in the review it goes out with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftReply {
    pub thread_id: String,
    pub body: String,
}

/// One review to create, on one commit, with the user comments it carries.
#[derive(Debug, Clone)]
pub struct PlannedReview {
    pub commit: String,
    pub event: ReviewEvent,
    pub body: String,
    pub comments: Vec<DraftComment>,
    /// Replies to existing conversations: only the main review has them.
    pub replies: Vec<DraftReply>,
    /// The comments and replies it carries, removed from ZuGit once GitHub has them.
    pub ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PublishPlan {
    /// On the latest commit, with the verdict and the summary. None for a plain
    /// comment with nothing in it.
    pub main: Option<PlannedReview>,
    /// Comments on code that changed since they were written: one review per
    /// commit they were written on, where GitHub keeps them as outdated.
    pub older: Vec<PlannedReview>,
}

fn github_side(side: Side) -> &'static str {
    match side {
        Side::New => "RIGHT",
        Side::Old => "LEFT",
    }
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// A code fence longer than any run of backticks in `code`, so nothing in the
/// code can close it and spill the rest out as Markdown.
fn fence_for(code: &str) -> String {
    let longest = code.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

/// The text GitHub gets. A suggested change on new code becomes a
/// ```suggestion block, which GitHub offers to apply; anywhere else it can
/// only be shown.
fn published_body(c: &UserComment) -> String {
    match c.suggestion.as_deref().map(str::trim_end).filter(|s| !s.trim().is_empty()) {
        Some(code) if c.side == Side::New && c.placement == Placement::Inline => {
            let fence = fence_for(code);
            format!("{}\n\n{fence}suggestion\n{code}\n{fence}", c.body)
        }
        Some(code) => {
            let fence = fence_for(code);
            format!("{}\n\nSuggested change:\n{fence}\n{code}\n{fence}", c.body)
        }
        None => c.body.clone(),
    }
}

fn draft_comment(c: &UserComment, at: &Position) -> DraftComment {
    let side = github_side(c.side);
    DraftComment {
        path: at.path.clone(),
        line: at.end_line.unwrap_or(at.line),
        side,
        start_line: at.end_line.map(|_| at.line),
        start_side: at.end_line.map(|_| side),
        body: published_body(c),
    }
}

/// A comment with no line to sit on, as a paragraph of the review's text.
fn paragraph(c: &UserComment) -> String {
    let lines = match (c.line, c.end_line) {
        (Some(a), Some(b)) => format!(":{a}-{b}"),
        (Some(a), None) => format!(":{a}"),
        _ => String::new(),
    };
    match &c.path {
        Some(path) => format!("`{path}{lines}` — {}", published_body(c)),
        None => published_body(c),
    }
}

/// Turns the user's comments into the reviews GitHub creates. Comments on the
/// latest commit, or carried to it, go on its lines; a range GitHub would
/// refuse (across hunks) goes on its last line, saying which lines; a comment
/// with no line left joins the review's text. `carried` says where each
/// comment written on an older commit sits now; the rest stay on their commit.
pub fn plan_review(
    mine: &UserReview,
    head: &str,
    event: ReviewEvent,
    index: &DiffIndex,
    carried: &HashMap<String, Carry>,
) -> Result<PublishPlan, String> {
    let head_lower = head.to_lowercase();
    let on_head = |sha: &str| !sha.is_empty() && head_lower.starts_with(&sha.to_lowercase());
    let mut inline = Vec::new();
    let mut ids = Vec::new();
    let mut paragraphs = Vec::new();
    let mut older: Vec<PlannedReview> = Vec::new();

    for c in &mine.comments {
        let (Some(path), Some(line)) = (c.path.as_deref(), c.line) else {
            paragraphs.push(paragraph(c));
            ids.push(c.id.clone());
            continue;
        };
        if c.placement == Placement::General {
            paragraphs.push(paragraph(c));
            ids.push(c.id.clone());
            continue;
        }
        let at = if on_head(&c.head_sha) {
            Some(Position { path: path.to_string(), line, end_line: c.end_line })
        } else {
            match carried.get(&c.id) {
                Some(Carry::Moved(p)) => Some(p.clone()),
                _ => None,
            }
        };
        let Some(at) = at else {
            let i = match older.iter().position(|r| r.commit == c.head_sha) {
                Some(i) => i,
                None => {
                    older.push(PlannedReview {
                        commit: c.head_sha.clone(),
                        event: ReviewEvent::Comment,
                        body: format!("Comments on an earlier commit, `{}`.", short(&c.head_sha)),
                        comments: vec![],
                        replies: vec![],
                        ids: vec![],
                    });
                    older.len() - 1
                }
            };
            older[i].comments.push(draft_comment(c, &Position { path: path.to_string(), line, end_line: c.end_line }));
            older[i].ids.push(c.id.clone());
            continue;
        };
        let last = at.end_line.unwrap_or(at.line);
        if index.shows(&at.path, c.side, at.line) && index.same_hunk(&at.path, c.side, at.line, last) {
            inline.push(draft_comment(c, &at));
        } else if index.shows(&at.path, c.side, last) {
            let mut draft = draft_comment(c, &Position { path: at.path.clone(), line: last, end_line: None });
            draft.body = format!("_Lines {}–{last}:_ {}", at.line, draft.body);
            inline.push(draft);
        } else {
            paragraphs.push(paragraph(c));
        }
        ids.push(c.id.clone());
    }

    let summary = mine.summary.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let body = summary.map(str::to_string).into_iter().chain(paragraphs).collect::<Vec<_>>().join("\n\n");
    if event == ReviewEvent::RequestChanges && body.is_empty() {
        return Err("GitHub needs a text to request changes: write a summary for your review.".into());
    }
    // Replies go with the main review, as on GitHub they wait for its submit.
    let replies: Vec<DraftReply> = mine
        .replies
        .iter()
        .map(|r| DraftReply { thread_id: r.thread_id.clone(), body: r.body.clone() })
        .collect();
    ids.extend(mine.replies.iter().map(|r| r.id.clone()));
    let main = (event != ReviewEvent::Comment || !inline.is_empty() || !body.is_empty() || !replies.is_empty())
        .then(|| PlannedReview { commit: head.to_string(), event, body, comments: inline, replies, ids });
    if main.is_none() && older.is_empty() {
        return Err("Nothing to publish yet.".into());
    }
    Ok(PublishPlan { main, older })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, patch: &str) -> PrFileDiff {
        PrFileDiff {
            filename: name.into(),
            previous_filename: None,
            status: "modified".into(),
            additions: 0,
            deletions: 0,
            patch: Some(patch.into()),
            blob_url: String::new(),
        }
    }

    fn comment(path: &str, line: u32, side: Side) -> ProposedComment {
        ProposedComment {
            path: Some(path.into()),
            line: Some(line),
            end_line: None,
            side,
            severity: Severity::Bug,
            body: "x".into(),
            suggestion: None,
        }
    }

    const PATCH: &str = "@@ -10,3 +10,4 @@ class A {\n ctx\n-old\n+new1\n+new2\n ctx2\n";

    #[test]
    fn patch_lines_follow_both_sides() {
        let (old, new) = patch_lines(PATCH);
        assert_eq!(old.into_iter().collect::<Vec<_>>(), vec![10, 11, 12]);
        assert_eq!(new.into_iter().collect::<Vec<_>>(), vec![10, 11, 12, 13]);
    }

    #[test]
    fn comments_on_diff_lines_are_inline_others_general() {
        let index = DiffIndex::new(&[file("a.ts", PATCH)]);
        let (placed, notes) = place_comments(
            vec![
                comment("a.ts", 11, Side::New),
                comment("a.ts", 11, Side::Old),
                comment("a.ts", 40, Side::New),
                comment("b.ts", 3, Side::New),
            ],
            &index,
        )
        .unwrap();
        let placements: Vec<_> = placed.iter().map(|c| c.placement).collect();
        assert_eq!(placements, vec![Placement::Inline, Placement::Inline, Placement::General, Placement::General]);
        assert_eq!(notes.len(), 2);
        assert_eq!(placed[0].id, "c1");
    }

    #[test]
    fn a_range_must_stay_inside_the_diff() {
        let index = DiffIndex::new(&[file("a.ts", PATCH)]);
        let mut range = comment("a.ts", 11, Side::New);
        range.end_line = Some(13);
        let mut too_far = comment("a.ts", 12, Side::New);
        too_far.end_line = Some(30);
        let (placed, _) = place_comments(vec![range, too_far], &index).unwrap();
        assert_eq!(placed[0].placement, Placement::Inline);
        assert_eq!(placed[0].end_line, Some(13));
        assert_eq!(placed[1].placement, Placement::General);
    }

    #[test]
    fn empty_bodies_and_backwards_ranges_are_refused() {
        let index = DiffIndex::new(&[file("a.ts", PATCH)]);
        let mut empty = comment("a.ts", 11, Side::New);
        empty.body = "  ".into();
        assert!(place_comments(vec![empty], &index).is_err());
        let mut backwards = comment("a.ts", 12, Side::New);
        backwards.end_line = Some(11);
        assert!(place_comments(vec![backwards], &index).is_err());
    }

    #[test]
    fn order_keeps_changed_files_once() {
        let index = DiffIndex::new(&[file("a.ts", PATCH), file("b.ts", PATCH)]);
        let mut notes = Vec::new();
        let order = clean_order(
            vec![
                ReviewGroup { title: "Model".into(), files: vec!["b.ts".into(), "zzz.ts".into()], why: "first".into() },
                ReviewGroup { title: "Rest".into(), files: vec!["./a.ts".into(), "b.ts".into()], why: String::new() },
                ReviewGroup { title: "Empty".into(), files: vec!["nope.ts".into()], why: String::new() },
            ],
            &index,
            &mut notes,
        );
        assert_eq!(order.len(), 2);
        assert_eq!(order[0].files, vec!["b.ts"]);
        assert_eq!(order[1].files, vec!["a.ts"]);
        assert_eq!(notes.len(), 2);
    }

    #[test]
    fn pr_refs_come_in_three_spellings() {
        let want = Some(("zupit-it/app".to_string(), 482));
        assert_eq!(parse_pr_ref("https://github.com/zupit-it/app/pull/482"), want);
        assert_eq!(parse_pr_ref("https://github.com/zupit-it/app/pull/482/files"), want);
        assert_eq!(parse_pr_ref("zupit-it/app#482"), want);
        assert_eq!(parse_pr_ref("zupit-it/app/pull/482"), want);
        assert_eq!(parse_pr_ref("482"), None);
        assert_eq!(parse_pr_ref("zupit-it/app#x"), None);
    }

    #[test]
    fn repos_are_owner_slash_name() {
        assert!(valid_repo("zupit-it/Zu-Git"));
        assert!(!valid_repo("../etc"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("a/"));
    }

    fn user_comment(id: &str, line: u32, end_line: Option<u32>, side: Side, sha: &str) -> UserComment {
        UserComment {
            id: id.into(),
            path: Some("a.ts".into()),
            line: Some(line),
            end_line,
            side,
            body: "x".into(),
            severity: None,
            suggestion: None,
            placement: Placement::Inline,
            head_sha: sha.into(),
            diff_hunk: None,
            created_at: "t".into(),
            kept_from: None,
        }
    }

    fn compare(files: Vec<FileChange>) -> CommitCompare {
        CommitCompare { linear: true, files, complete: true }
    }

    fn change(path: &str, patch: &str) -> FileChange {
        FileChange { path: path.into(), previous_path: None, status: "modified".into(), patch: Some(patch.into()) }
    }

    #[test]
    fn lines_follow_the_patch_between_two_commits() {
        // Line 11 replaced by two: old 12 is new 13, old 20 new 21.
        let hunks = parse_hunks("@@ -10,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2\n@@ -30,0 +32,2 @@\n+a\n+b");
        assert_eq!(carry_line(&hunks, 9), Some(9));
        assert_eq!(carry_line(&hunks, 10), Some(10));
        assert_eq!(carry_line(&hunks, 11), None);
        assert_eq!(carry_line(&hunks, 12), Some(13));
        assert_eq!(carry_line(&hunks, 20), Some(21));
        // Lines added after line 30 leave it where it was and push the next ones down.
        assert_eq!(carry_line(&hunks, 30), Some(31));
        assert_eq!(carry_line(&hunks, 31), Some(34));
    }

    #[test]
    fn a_comment_follows_unchanged_code_and_goes_outdated_with_changed_code() {
        // The latest commit added a line above: what was line 12 of the head is 13 now.
        let now = DiffIndex::new(&[file("a.ts", "@@ -4,1 +4,2 @@\n a\n+inserted\n@@ -10,3 +11,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2")]);
        let inserted = compare(vec![change("a.ts", "@@ -4,0 +5,1 @@\n+inserted")]);
        let at = |line, end_line| Carry::Moved(Position { path: "a.ts".into(), line, end_line });
        assert_eq!(carry(&user_comment("u1", 12, None, Side::New, "old"), Some(&inserted), &now), at(13, None));
        assert_eq!(carry(&user_comment("u1", 11, Some(12), Side::New, "old"), Some(&inserted), &now), at(12, Some(13)));
        let rewritten = compare(vec![change("a.ts", "@@ -12,1 +12,1 @@\n-new2\n+other")]);
        assert_eq!(carry(&user_comment("u1", 12, None, Side::New, "old"), Some(&rewritten), &now), Carry::Outdated);
        let forced = CommitCompare { linear: false, ..compare(vec![]) };
        assert_eq!(carry(&user_comment("u1", 12, None, Side::New, "old"), Some(&forced), &now), Carry::Outdated);
        let removed = compare(vec![FileChange { status: "removed".into(), patch: None, ..change("a.ts", "") }]);
        assert_eq!(carry(&user_comment("u1", 12, None, Side::New, "old"), Some(&removed), &now), Carry::Outdated);

        // Unchanged file: same lines.
        let same = DiffIndex::new(&[file("a.ts", PATCH)]);
        assert_eq!(carry(&user_comment("u1", 11, Some(12), Side::New, "old"), Some(&compare(vec![])), &same), at(11, Some(12)));
        // Removed lines (base side) must read the same.
        let mut on_removed = user_comment("u1", 11, None, Side::Old, "old");
        assert_eq!(carry(&on_removed, None, &same), Carry::Unknown);
        on_removed.diff_hunk = Some("@@ -10,2 +10,1 @@\n ctx\n-old".into());
        assert_eq!(carry(&on_removed, None, &same), at(11, None));
        on_removed.diff_hunk = Some("@@ -10,2 +10,1 @@\n ctx\n-something else".into());
        assert_eq!(carry(&on_removed, None, &same), Carry::Outdated);
    }

    #[test]
    fn publishing_puts_comments_on_their_lines_and_the_rest_in_the_text() {
        // Head lines 10..13 in one hunk, 41..42 in another.
        let index = DiffIndex::new(&[file("a.ts", "@@ -10,3 +10,4 @@\n ctx\n-old\n+new1\n+new2\n ctx2\n@@ -40,2 +41,2 @@\n x\n-y\n+z")]);
        let mut mine = UserReview::new("org/app", 7);
        let mut general = user_comment("u5", 1, None, Side::New, "head");
        (general.path, general.line, general.placement) = (None, None, Placement::General);
        mine.comments = vec![
            user_comment("u1", 11, Some(12), Side::New, "head"),
            user_comment("u2", 12, Some(41), Side::New, "head"),
            user_comment("u3", 11, None, Side::Old, "head"),
            user_comment("u4", 99, None, Side::New, "head"),
            general,
            user_comment("u6", 12, None, Side::New, "older1"),
            user_comment("u7", 12, None, Side::New, "older2"),
        ];
        mine.comments[0].suggestion = Some("  fixed();".into());
        mine.summary = Some("Overall fine.".into());
        let carried = HashMap::from([
            ("u6".to_string(), Carry::Outdated),
            ("u7".to_string(), Carry::Moved(Position { path: "a.ts".into(), line: 13, end_line: None })),
        ]);
        let plan = plan_review(&mine, "head", ReviewEvent::RequestChanges, &index, &carried).unwrap();
        let main = plan.main.unwrap();
        assert_eq!(main.commit, "head");
        assert_eq!(
            main.comments[0],
            DraftComment {
                path: "a.ts".into(),
                line: 12,
                side: "RIGHT",
                start_line: Some(11),
                start_side: Some("RIGHT"),
                body: "x\n\n```suggestion\n  fixed();\n```".into(),
            }
        );
        // Across hunks: on its last line, saying which lines.
        assert_eq!((main.comments[1].line, main.comments[1].start_line), (41, None));
        assert!(main.comments[1].body.starts_with("_Lines 12–41:_ "));
        assert_eq!((main.comments[2].side, main.comments[2].line), ("LEFT", 11));
        assert_eq!(main.comments[3].line, 13);
        assert_eq!(main.body, "Overall fine.\n\n`a.ts:99` — x\n\nx");
        assert_eq!(main.ids, vec!["u1", "u2", "u3", "u4", "u5", "u7"]);
        assert_eq!(plan.older.len(), 1);
        assert_eq!(plan.older[0].commit, "older1");
        assert_eq!(plan.older[0].ids, vec!["u6"]);
        assert_eq!(plan.older[0].comments[0].line, 12);
    }

    #[test]
    fn a_review_needs_something_to_say() {
        let index = DiffIndex::new(&[]);
        let empty = UserReview::new("org/app", 7);
        let none = HashMap::new();
        assert!(plan_review(&empty, "head", ReviewEvent::RequestChanges, &index, &none).is_err());
        assert!(plan_review(&empty, "head", ReviewEvent::Comment, &index, &none).is_err());
        let approval = plan_review(&empty, "head", ReviewEvent::Approve, &index, &none).unwrap();
        assert!(approval.main.is_some_and(|m| m.comments.is_empty() && m.body.is_empty()));
    }

    #[test]
    fn replies_wait_for_the_main_review() {
        let index = DiffIndex::new(&[]);
        let mut mine = UserReview::new("org/app", 7);
        assert!(mine.add_reply("", "x", "t").is_err());
        assert!(mine.add_reply("PRRT_1", "  ", "t").is_err());
        mine.add_reply("PRRT_1", " Agreed. ", "t").unwrap();
        mine.add_reply("PRRT_2", "Fixed in the next push.", "t").unwrap();
        assert_eq!(mine.replies[0].body, "Agreed.");
        assert_eq!(mine.replies.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["r1", "r2"]);
        mine.edit_reply("r2", "Fixed.").unwrap();
        assert!(!mine.is_empty());
        // Only replies: a plain comment review still goes out, carrying them.
        let plan = plan_review(&mine, "head", ReviewEvent::Comment, &index, &HashMap::new()).unwrap();
        let main = plan.main.unwrap();
        assert_eq!(
            main.replies,
            vec![
                DraftReply { thread_id: "PRRT_1".into(), body: "Agreed.".into() },
                DraftReply { thread_id: "PRRT_2".into(), body: "Fixed.".into() },
            ]
        );
        assert_eq!(main.ids, vec!["r1", "r2"]);
        let sent = mine.clone();
        mine.published(&main.ids, &sent, true);
        assert!(mine.is_empty());
        assert!(!mine.remove_reply("r1"));
    }

    #[test]
    fn a_verdict_goes_only_on_the_commit_the_reviewer_saw() {
        let latest = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
        assert!(same_commit(latest, latest));
        assert!(same_commit("A1B2C3D", latest));
        assert!(!same_commit("ffffffffffffffffffffffffffffffffffffffff", latest));
        assert!(!same_commit("", latest));
        assert!(!same_commit("a1b2", latest));
    }

    #[test]
    fn code_in_a_suggestion_cannot_close_its_fence() {
        let mut c = user_comment("u1", 11, None, Side::New, "head");
        c.suggestion = Some("plain();".into());
        assert_eq!(published_body(&c), "x\n\n```suggestion\nplain();\n```");
        c.suggestion = Some("```md\n@everyone look\n```".into());
        assert_eq!(published_body(&c), "x\n\n````suggestion\n```md\n@everyone look\n```\n````");
        c.side = Side::Old;
        assert!(published_body(&c).starts_with("x\n\nSuggested change:\n````\n"));
    }

    #[test]
    fn the_summary_is_kept_until_the_main_review_is_out() {
        let mut mine = UserReview::new("org/app", 7);
        assert!(mine.is_empty());
        mine.set_summary("  ").unwrap();
        assert!(mine.summary.is_none());
        mine.set_summary(" Looks good. ").unwrap();
        assert_eq!(mine.summary.as_deref(), Some("Looks good."));
        assert!(!mine.is_empty());
        mine.comments.push(user_comment("u1", 11, None, Side::New, "head"));
        mine.comments.push(user_comment("u2", 12, None, Side::New, "older"));
        let sent = mine.clone();
        mine.published(&["u1".to_string()], &sent, true);
        assert_eq!(mine.comments.len(), 1);
        assert!(mine.summary.is_none());
    }

    #[test]
    fn what_is_written_while_a_review_goes_out_stays() {
        let mut mine = UserReview::new("org/app", 7);
        mine.set_summary("Looks good.").unwrap();
        mine.comments.push(user_comment("u1", 11, None, Side::New, "head"));
        mine.comments.push(user_comment("u2", 12, None, Side::New, "head"));
        let sent = mine.clone();
        // Meanwhile: u2 deleted, a new comment given its id, the summary reworded.
        mine.remove("u2");
        let mut new = user_comment("u2", 30, None, Side::New, "head");
        new.created_at = "later".into();
        mine.comments.push(new);
        mine.set_summary("Looks good, one nit.").unwrap();
        mine.published(&["u1".to_string(), "u2".to_string()], &sent, true);
        assert_eq!(mine.comments.iter().map(|c| c.line).collect::<Vec<_>>(), vec![Some(30)]);
        assert_eq!(mine.summary.as_deref(), Some("Looks good, one nit."));
    }

    fn proposal(comments: Vec<ProposedComment>) -> AiReview {
        let index = DiffIndex::new(&[file("a.ts", PATCH)]);
        let (comments, _) = place_comments(comments, &index).unwrap();
        AiReview {
            repo: "org/app".into(),
            number: 7,
            head_sha: "abc1234".into(),
            source: "claude-code".into(),
            created_at: "2026-10-01T10:00:00Z".into(),
            summary: None,
            order: vec![],
            comments,
        }
    }

    fn new_comment(line: u32, end_line: Option<u32>, body: &str) -> NewComment {
        NewComment {
            path: "a.ts".into(),
            line,
            end_line,
            side: Side::New,
            head_sha: "ABC1234".into(),
            diff_hunk: None,
            body: body.into(),
        }
    }

    #[test]
    fn user_comments_need_a_body_and_a_forward_range() {
        let mut mine = UserReview::new("org/app", 7);
        assert!(mine.add(new_comment(11, None, "  "), "t").is_err());
        assert!(mine.add(new_comment(12, Some(11), "x"), "t").is_err());
        mine.add(new_comment(11, Some(13), " range "), "t").unwrap();
        mine.add(new_comment(12, Some(12), "single"), "t").unwrap();
        assert_eq!(mine.comments[0].body, "range");
        assert_eq!(mine.comments[0].end_line, Some(13));
        assert_eq!(mine.comments[1].end_line, None);
        assert_eq!(mine.comments[1].head_sha, "abc1234");
        assert_eq!(mine.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["u1", "u2"]);
        mine.edit("u1", "reworded").unwrap();
        assert!(mine.edit("u1", " ").is_err());
        assert_eq!(mine.remove("u1").unwrap().body, "reworded");
        mine.add(new_comment(13, None, "third"), "t").unwrap();
        assert_eq!(mine.comments[1].id, "u3");
    }

    #[test]
    fn a_kept_ai_comment_becomes_the_users() {
        let mut review = proposal(vec![comment("a.ts", 11, Side::New)]);
        let mut mine = UserReview::new("org/app", 7);
        keep_comment(&mut review, "c1", Some("  my words "), Some("@@ -10 +11 @@\n+new1"), &mut mine, "t").unwrap();
        // A double click adds nothing.
        keep_comment(&mut review, "c1", None, None, &mut mine, "t").unwrap();
        assert_eq!(mine.comments.len(), 1);
        let kept = &mine.comments[0];
        assert_eq!(kept.body, "my words");
        assert_eq!(kept.severity, Some(Severity::Bug));
        assert_eq!((kept.line, kept.placement), (Some(11), Placement::Inline));
        assert_eq!(kept.head_sha, "abc1234");
        assert_eq!(kept.diff_hunk.as_deref(), Some("@@ -10 +11 @@\n+new1"));
        assert_eq!(review.comments[0].status, CommentStatus::Kept);
        assert!(keep_comment(&mut review, "c9", None, None, &mut mine, "t").is_err());
    }

    #[test]
    fn a_comment_keeps_its_code_only_when_it_reads_as_a_hunk() {
        let mut mine = UserReview::new("org/app", 7);
        let mut with_hunk = new_comment(11, None, "x");
        with_hunk.diff_hunk = Some("@@ -10,2 +10,3 @@\n ctx\n+new1".into());
        mine.add(with_hunk, "t").unwrap();
        let mut not_a_hunk = new_comment(11, None, "y");
        not_a_hunk.diff_hunk = Some("<b>no</b>".into());
        mine.add(not_a_hunk, "t").unwrap();
        assert!(mine.comments[0].diff_hunk.is_some());
        assert!(mine.comments[1].diff_hunk.is_none());
    }

    #[test]
    fn deleting_a_kept_comment_discards_it_in_its_own_proposal_only() {
        let mut review = proposal(vec![comment("a.ts", 11, Side::New)]);
        let mut mine = UserReview::new("org/app", 7);
        keep_comment(&mut review, "c1", None, None, &mut mine, "t").unwrap();
        let from = mine.remove("u1").unwrap().kept_from.unwrap();
        // The agent proposed again: its c1 is another comment.
        let mut newer = proposal(vec![comment("a.ts", 12, Side::New)]);
        newer.created_at = "2026-10-02T10:00:00Z".into();
        assert!(!release_kept(&mut newer, &from));
        assert_eq!(newer.comments[0].status, CommentStatus::Pending);
        assert!(release_kept(&mut review, &from));
        assert_eq!(review.comments[0].status, CommentStatus::Discarded);
    }
}
