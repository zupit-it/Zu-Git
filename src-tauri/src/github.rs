use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::{AppSettings, DraftPrInfo, PipelineState};

// ── GraphQL query ─────────────────────────────────────────────────────────────

const PR_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      states: OPEN
      first: 50
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        id
        number
        title
        body
        url
        isDraft
        createdAt
        updatedAt
        additions
        deletions
        author { login avatarUrl }
        assignees(first: 5) { nodes { login avatarUrl } }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login avatarUrl }
            }
          }
        }
        reviews(first: 100) {
          nodes {
            state
            submittedAt
            author { login avatarUrl }
          }
        }
        autoMergeRequest { mergeMethod }
        mergeable
        mergeStateStatus
        reviewThreads(first: 50) {
          nodes { isResolved }
        }
        baseRef { name }
        headRef {
          name
          target { oid }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      databaseId
                      name
                      status
                      conclusion
                      startedAt
                      completedAt
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

// ── GraphQL response types ────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GqlResponse {
    data: Option<GqlData>,
    errors: Option<Vec<GqlError>>,
}

#[derive(Debug, Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct GqlData {
    repository: Option<GqlRepository>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRepository {
    pull_requests: GqlPrConnection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPrConnection {
    nodes: Vec<GqlPr>,
    page_info: GqlPageInfo,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlPr {
    id: String,
    number: u64,
    title: String,
    body: Option<String>,
    url: String,
    is_draft: bool,
    created_at: String,
    updated_at: String,
    additions: u32,
    deletions: u32,
    author: Option<GqlActor>,
    assignees: GqlNodes<GqlActor>,
    review_requests: GqlNodes<GqlReviewRequest>,
    reviews: GqlNodes<GqlReview>,
    auto_merge_request: Option<GqlAutoMergeRequest>,
    mergeable: Option<String>,
    merge_state_status: Option<String>,
    review_threads: GqlNodes<GqlReviewThread>,
    base_ref: Option<GqlHeadRef>,
    head_ref: Option<GqlHeadRef>,
    commits: GqlNodes<GqlCommitNode>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GqlActor {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlNodes<T> {
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlReviewRequest {
    requested_reviewer: Option<GqlRequestedReviewer>,
}

/// Inline fragment on User — fields absent when the reviewer is a Team.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlRequestedReviewer {
    login: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlReview {
    state: String,
    submitted_at: Option<String>,
    author: Option<GqlActor>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlHeadRef {
    name: String,
    target: Option<GqlTarget>,
}

#[derive(Debug, Deserialize)]
struct GqlTarget {
    oid: String,
}

#[derive(Debug, Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlCommit {
    status_check_rollup: Option<GqlStatusCheckRollup>,
}

#[derive(Debug, Deserialize)]
struct GqlStatusCheckRollup {
    state: String,
    contexts: GqlNodes<GqlStatusContext>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlAutoMergeRequest {
    merge_method: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GqlReviewThread {
    is_resolved: bool,
}

/// Flat struct covering both CheckRun and StatusContext inline fragments.
/// Discriminated at runtime via `__typename`.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GqlStatusContext {
    #[serde(rename = "__typename")]
    typename: String,
    // CheckRun fields
    database_id: Option<u64>,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    // StatusContext fields (legacy) — present in JSON but aggregated via rollup.state
    #[allow(dead_code)]
    context: Option<String>,
    #[allow(dead_code)]
    state: Option<String>,
}

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GithubReviewSummary {
    pub current_approvers: Vec<String>,
    pub stale_approvers: Vec<String>,
    pub blocking_reviewers: Vec<String>,
    pub commented_reviewers: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GithubPullRequestRecord {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub body: String,
    pub created_at: String,
    pub author: String,
    pub assignee: Option<String>,
    pub requested_reviewers: Vec<String>,
    pub participant_avatars: HashMap<String, String>,
    pub head_ref: String,
    pub updated_at: String,
    pub node_id: String,
    pub base_ref: String,
    pub draft: bool,
    pub pipeline_state: PipelineState,
    pub review_summary: GithubReviewSummary,
    pub additions: u32,
    pub deletions: u32,
    pub auto_merge_method: Option<String>,
    pub unresolved_threads: u32,
    pub merge_status: String,
}


pub struct GithubRepoFetchResult {
    pub repo: String,
    pub ok: bool,
    pub pull_requests: Vec<GithubPullRequestRecord>,
    pub error: Option<String>,
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

fn github_headers(settings: &AppSettings) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("Accept", "application/vnd.github+json".parse().unwrap());
    headers.insert(
        "Authorization",
        format!("Bearer {}", settings.github_token).parse().unwrap(),
    );
    headers.insert("User-Agent", "zugit-tauri".parse().unwrap());
    headers.insert("X-GitHub-Api-Version", "2022-11-28".parse().unwrap());
    headers
}

async fn github_request<T: serde::de::DeserializeOwned>(
    url: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<T, String> {
    let response = client
        .get(url)
        .headers(github_headers(settings))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub request failed ({}) for {}",
            response.status(),
            url
        ));
    }

    response.json::<T>().await.map_err(|e| e.to_string())
}

/// Fetches avatar URLs for a list of GitHub logins via `GET /users/{login}` in parallel.
/// Logins that fail (e.g. 404) are silently skipped.
pub async fn fetch_user_avatars(
    logins: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct GithubUser {
        avatar_url: String,
    }

    let base = settings.github_api_base_url.trim_end_matches('/');
    let futures: Vec<_> = logins
        .iter()
        .map(|login| {
            let url = format!("{}/users/{}", base, login);
            async move {
                let result: Result<GithubUser, _> =
                    github_request(&url, settings, client).await;
                result.ok().map(|u| (login.clone(), u.avatar_url))
            }
        })
        .collect();

    futures::future::join_all(futures)
        .await
        .into_iter()
        .flatten()
        .collect()
}

/// Derives the GraphQL endpoint from the REST base URL.
/// - `https://api.github.com`       → `https://api.github.com/graphql`
/// - `https://hostname/api/v3`      → `https://hostname/api/graphql`
fn graphql_url(settings: &AppSettings) -> String {
    let base = settings.github_api_base_url.trim_end_matches('/');
    if base.ends_with("/api/v3") {
        format!("{}/graphql", base.trim_end_matches("/v3"))
    } else {
        format!("{}/graphql", base)
    }
}

async fn graphql_request(
    query: &str,
    variables: serde_json::Value,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<GqlResponse, String> {
    let url = graphql_url(settings);
    let body = serde_json::json!({ "query": query, "variables": variables });

    let response = client
        .post(&url)
        .headers(github_headers(settings))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GraphQL request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "GitHub GraphQL API returned {} for {}",
            response.status(),
            url
        ));
    }

    response.json::<GqlResponse>().await.map_err(|e| e.to_string())
}

/// Like `graphql_request` but returns the raw `data` value — used for
/// dynamically-aliased queries where the response shape isn't known at compile time.
async fn graphql_request_raw(
    query: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<serde_json::Value> {
    let url = graphql_url(settings);
    let body = serde_json::json!({ "query": query });
    let resp = client
        .post(&url)
        .headers(github_headers(settings))
        .json(&body)
        .send()
        .await
        .ok()?;
    let json: serde_json::Value = resp.json().await.ok()?;
    Some(json["data"].clone())
}


// ── Public API ────────────────────────────────────────────────────────────────

pub async fn fetch_viewer_login(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    #[derive(Debug, Deserialize)]
    struct GithubViewer {
        login: String,
    }
    let base = settings.github_api_base_url.trim_end_matches('/');
    let viewer: GithubViewer =
        github_request(&format!("{}/user", base), settings, client).await?;
    Ok(viewer.login)
}

pub async fn request_review(
    repo: &str,
    pr_number: u64,
    login: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let base = settings.github_api_base_url.trim_end_matches('/');
    let url = format!(
        "{}/repos/{}/pulls/{}/requested_reviewers",
        base, repo, pr_number
    );
    let body = serde_json::json!({ "reviewers": [login] });

    let response = client
        .post(&url)
        .headers(github_headers(settings))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to request review from {} ({})",
            login,
            response.status()
        ));
    }
    Ok(())
}

pub async fn fetch_open_pull_requests(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<GithubRepoFetchResult> {
    let futures = settings
        .github_repos
        .iter()
        .map(|repo| fetch_repo_pull_requests(repo, settings, client));
    futures::future::join_all(futures).await
}

// ── Per-repo GraphQL fetch ────────────────────────────────────────────────────

async fn fetch_repo_pull_requests(
    repo: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> GithubRepoFetchResult {
    match fetch_repo_pull_requests_inner(repo, settings, client).await {
        Ok(prs) => GithubRepoFetchResult {
            repo: repo.to_string(),
            ok: true,
            pull_requests: prs,
            error: None,
        },
        Err(e) => GithubRepoFetchResult {
            repo: repo.to_string(),
            ok: false,
            pull_requests: vec![],
            error: Some(e),
        },
    }
}

async fn fetch_repo_pull_requests_inner(
    repo: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<GithubPullRequestRecord>, String> {
    let (owner, repo_name) = repo
        .split_once('/')
        .ok_or_else(|| format!("Invalid repo format: {repo}"))?;

    // Fetch all pages (typically one for most repos).
    let mut all_prs: Vec<GqlPr> = vec![];
    let mut cursor: Option<String> = None;

    loop {
        let variables = serde_json::json!({
            "owner": owner,
            "repo":  repo_name,
            "cursor": cursor,
        });

        let resp = graphql_request(PR_QUERY, variables, settings, client).await?;

        if let Some(errors) = &resp.errors {
            let msgs: Vec<_> = errors.iter().map(|e| e.message.as_str()).collect();
            return Err(format!("GraphQL error: {}", msgs.join("; ")));
        }

        let connection = resp
            .data
            .and_then(|d| d.repository)
            .ok_or_else(|| format!("Repository {repo} not found or inaccessible"))?
            .pull_requests;

        let has_next = connection.page_info.has_next_page;
        let end_cursor = connection.page_info.end_cursor;
        all_prs.extend(connection.nodes);

        if has_next {
            cursor = end_cursor;
        } else {
            break;
        }
    }

    let mut records = Vec::new();
    for pr in &all_prs {
        let head_sha = pr
            .head_ref
            .as_ref()
            .and_then(|h| h.target.as_ref())
            .map(|t| t.oid.clone())
            .unwrap_or_default();

        let details = build_pr_details(pr, &head_sha);

        records.push(GithubPullRequestRecord {
            repo: repo.to_string(),
            number: pr.number,
            title: pr.title.clone(),
            url: pr.url.clone(),
            body: pr.body.clone().unwrap_or_default(),
            created_at: pr.created_at.clone(),
            author: pr.author.as_ref().map(|a| a.login.clone()).unwrap_or_default(),
            assignee: pr.assignees.nodes.first().map(|a| a.login.clone()),
            requested_reviewers: pr
                .review_requests
                .nodes
                .iter()
                .filter_map(|rr| rr.requested_reviewer.as_ref()?.login.clone())
                .collect(),
            participant_avatars: details.participant_avatars.clone(),
            head_ref: pr
                .head_ref
                .as_ref()
                .map(|h| h.name.clone())
                .unwrap_or_default(),
            updated_at: pr.updated_at.clone(),
            node_id: pr.id.clone(),
            base_ref: pr.base_ref.as_ref().map(|b| b.name.clone()).unwrap_or_default(),
            draft: pr.is_draft,
            pipeline_state: details.pipeline_state.clone(),
            review_summary: details.review_summary.clone(),
            additions: details.additions,
            deletions: details.deletions,
            auto_merge_method: details.auto_merge_method.clone(),
            unresolved_threads: details.unresolved_threads,
            merge_status: details.merge_status.clone(),
        });
    }

    Ok(records)
}

// ── Build processed details from a GraphQL PR node ────────────────────────────

struct PrDetails {
    participant_avatars: HashMap<String, String>,
    pipeline_state: PipelineState,
    review_summary: GithubReviewSummary,
    additions: u32,
    deletions: u32,
    auto_merge_method: Option<String>,
    unresolved_threads: u32,
    merge_status: String,
}

fn build_pr_details(pr: &GqlPr, _head_sha: &str) -> PrDetails {
    let mut avatars: HashMap<String, String> = HashMap::new();

    let mut add = |login: &str, url: Option<&str>| {
        if let Some(u) = url {
            if !u.is_empty() {
                avatars.insert(login.to_string(), u.to_string());
            }
        }
    };

    if let Some(a) = &pr.author {
        add(&a.login, a.avatar_url.as_deref());
    }
    for a in &pr.assignees.nodes {
        add(&a.login, a.avatar_url.as_deref());
    }
    for rr in &pr.review_requests.nodes {
        if let Some(rv) = &rr.requested_reviewer {
            if let (Some(login), Some(url)) = (&rv.login, &rv.avatar_url) {
                add(login, Some(url));
            }
        }
    }
    for rev in &pr.reviews.nodes {
        if let Some(a) = &rev.author {
            add(&a.login, a.avatar_url.as_deref());
        }
    }

    let requested_logins: Vec<String> = pr
        .review_requests
        .nodes
        .iter()
        .filter_map(|rr| rr.requested_reviewer.as_ref()?.login.clone())
        .collect();

    let review_summary = summarize_reviews(&pr.reviews.nodes, &requested_logins);
    let rollup = pr
        .commits
        .nodes
        .first()
        .and_then(|c| c.commit.status_check_rollup.as_ref());
    let pipeline_state = summarize_pipeline_state(rollup);

    let auto_merge_method = pr.auto_merge_request.as_ref().map(|r| r.merge_method.clone());
    let unresolved_threads = pr.review_threads.nodes.iter().filter(|t| !t.is_resolved).count() as u32;
    let merge_status = summarize_merge_status(
        pr.mergeable.as_deref(),
        pr.merge_state_status.as_deref(),
    );

    PrDetails {
        participant_avatars: avatars,
        pipeline_state,
        review_summary,
        additions: pr.additions,
        deletions: pr.deletions,
        auto_merge_method,
        unresolved_threads,
        merge_status,
    }
}

fn summarize_merge_status(mergeable: Option<&str>, merge_state_status: Option<&str>) -> String {
    match merge_state_status {
        Some("BEHIND") => "behind".to_string(),
        Some("DIRTY") | Some("CONFLICTING") => "conflicting".to_string(),
        Some("CLEAN") | Some("UNSTABLE") | Some("HAS_HOOKS") => "clean".to_string(),
        Some("BLOCKED") => "blocked".to_string(),
        _ => match mergeable {
            Some("CONFLICTING") => "conflicting".to_string(),
            Some("MERGEABLE") => "clean".to_string(),
            _ => "unknown".to_string(),
        },
    }
}

// ── Review summary ────────────────────────────────────────────────────────────

fn summarize_reviews(reviews: &[GqlReview], requested_reviewers: &[String]) -> GithubReviewSummary {
    let mut latest: HashMap<String, &GqlReview> = HashMap::new();

    for review in reviews {
        let login = match &review.author {
            Some(u) => &u.login,
            None => continue,
        };
        let next_ts = parse_ts(review.submitted_at.as_deref());
        let better = latest
            .get(login.as_str())
            .map(|cur| next_ts >= parse_ts(cur.submitted_at.as_deref()))
            .unwrap_or(true);
        if better {
            latest.insert(login.clone(), review);
        }
    }

    let mut current_approvers = vec![];
    let mut stale_approvers = vec![];
    let mut blocking_reviewers = vec![];
    let mut commented_reviewers = vec![];

    for (login, review) in &latest {
        match review.state.as_str() {
            "APPROVED" => current_approvers.push(login.clone()),
            "DISMISSED" => stale_approvers.push(login.clone()),
            "CHANGES_REQUESTED" if !requested_reviewers.contains(login) => {
                blocking_reviewers.push(login.clone());
            }
            "COMMENTED" => commented_reviewers.push(login.clone()),
            _ => {}
        }
    }

    GithubReviewSummary {
        current_approvers,
        stale_approvers,
        blocking_reviewers,
        commented_reviewers,
    }
}

fn parse_ts(s: Option<&str>) -> i64 {
    s.and_then(|ts| chrono::DateTime::parse_from_rfc3339(ts).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

// ── Pipeline state ────────────────────────────────────────────────────────────

fn summarize_pipeline_state(rollup: Option<&GqlStatusCheckRollup>) -> PipelineState {
    let Some(rollup) = rollup else {
        return PipelineState::Unknown;
    };

    let check_runs: Vec<&GqlStatusContext> = rollup
        .contexts
        .nodes
        .iter()
        .filter(|c| c.typename == "CheckRun")
        .collect();

    // Deduplicate check runs by name, keeping the most recent execution.
    let latest = keep_latest_check_runs(&check_runs);

    let has_failed = latest.iter().any(|cr| {
        cr.status.as_deref() == Some("completed")
            && matches!(
                cr.conclusion.as_deref(),
                Some("failure" | "timed_out" | "startup_failure")
            )
    });
    if has_failed {
        return PipelineState::Failure;
    }

    let has_action_required = latest.iter().any(|cr| {
        cr.status.as_deref() == Some("completed")
            && cr.conclusion.as_deref() == Some("action_required")
    });

    // rollup.state aggregates both CheckRun and legacy StatusContext results.
    match rollup.state.as_str() {
        "FAILURE" | "ERROR" => return PipelineState::Failure,
        "SUCCESS" if !has_action_required => return PipelineState::Success,
        "PENDING" => return PipelineState::Pending,
        _ => {}
    }

    let has_pending = latest.iter().any(|cr| {
        matches!(
            cr.status.as_deref(),
            Some("queued" | "in_progress" | "waiting" | "requested" | "pending")
        )
    });
    if has_pending {
        return PipelineState::Pending;
    }

    if has_action_required {
        return PipelineState::ActionRequired;
    }

    PipelineState::Unknown
}

// ── Branch discovery & PR creation ───────────────────────────────────────────

/// A push/force-push/branch-creation event from the GitHub Activity API.
#[derive(Deserialize)]
struct RepoActivity {
    #[serde(rename = "ref")]
    git_ref: String,
    timestamp: String,
    activity_type: String,
}

struct BranchCandidate {
    repo: String,
    branch: String,
    base_branch: String,
    suggested_title: String,
    committed_at: String,
}

fn build_viewer_repos_gql(repos: &[String]) -> String {
    let mut q = String::from("{ viewer { login }");
    for (i, repo) in repos.iter().enumerate() {
        if let Some((owner, name)) = repo.split_once('/') {
            q.push_str(&format!(
                " r_{i}: repository(owner:\"{owner}\", name:\"{name}\") {{ defaultBranchRef {{ name }} pullRequests(states: OPEN, first: 100) {{ nodes {{ headRefName }} }} }}"
            ));
        }
    }
    q.push('}');
    q
}

fn build_candidates_check_gql(
    candidates: &[(usize, &str, &str, &str)], // (repo_idx, owner, name, branch)
) -> String {
    // Group by repo_idx so each repository block has all its branch aliases.
    use std::collections::BTreeMap;
    type RepoBranches<'a> = (&'a str, &'a str, Vec<(usize, &'a str)>);
    let mut by_repo: BTreeMap<usize, RepoBranches<'_>> = BTreeMap::new();
    for &(ri, owner, name, branch) in candidates {
        let e = by_repo.entry(ri).or_insert_with(|| (owner, name, Vec::new()));
        let bi = e.2.len();
        e.2.push((bi, branch));
    }
    let mut q = String::from("{");
    for (ri, (owner, name, branches)) in &by_repo {
        q.push_str(&format!(
            " r_{ri}: repository(owner:\"{owner}\", name:\"{name}\") {{"
        ));
        for (bi, branch) in branches {
            let escaped = branch.replace('\\', "\\\\").replace('"', "\\\"");
            q.push_str(&format!(
                " c{bi}_prs: pullRequests(headRefName:\"{escaped}\", states:[OPEN,CLOSED,MERGED], first:1) {{ nodes {{ state mergedAt }} }}"
            ));
            q.push_str(&format!(
                " c{bi}_ref: ref(qualifiedName:\"refs/heads/{escaped}\") {{ target {{ ... on Commit {{ messageHeadline }} }} }}"
            ));
        }
        q.push_str(" }");
    }
    q.push('}');
    q
}

/// Searches all configured repos for the viewer's most recently pushed branch
/// that has no open PR yet.
///
/// Round trips:
///   1. GraphQL batch: viewer login + default branch for every repo
///   2. N × GET activity (parallel, needs viewer login from step 1)
///   3. GraphQL batch: PR existence + commit headline for all candidates
///   4. GET /compare for the chosen branch
pub async fn find_viewer_branch(
    repos: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<DraftPrInfo> {
    // ── Round trip 1: viewer login + default branches ─────────────────────────
    let viewer_repos_q = build_viewer_repos_gql(repos);
    let gql_data = graphql_request_raw(&viewer_repos_q, settings, client).await?;

    let viewer_login = gql_data["viewer"]["login"].as_str()?.to_string();

    let default_branches: Vec<Option<String>> = repos
        .iter()
        .enumerate()
        .map(|(i, _)| {
            gql_data[&format!("r_{i}")]["defaultBranchRef"]["name"]
                .as_str()
                .map(|s| s.to_string())
        })
        .collect();

    // Collect all head branches that already have an open PR — these must be excluded.
    let open_head_refs: std::collections::HashSet<String> = repos
        .iter()
        .enumerate()
        .flat_map(|(i, _)| {
            gql_data[&format!("r_{i}")]["pullRequests"]["nodes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|n| n["headRefName"].as_str().map(|s| s.to_string()))
        })
        .collect();

    // ── Round trip 2: activity per repo (parallel) ────────────────────────────
    let rest_base = settings.github_api_base_url.trim_end_matches('/');
    let activity_urls: Vec<String> = repos
        .iter()
        .map(|repo| format!(
            "{}/repos/{}/activity?actor={}&time_period=month&per_page=25",
            rest_base, repo, viewer_login
        ))
        .collect();
    let activity_futs: Vec<_> = activity_urls
        .iter()
        .map(|url| github_request::<Vec<RepoActivity>>(url, settings, client))
        .collect();
    let activity_results = futures::future::join_all(activity_futs).await;

    // ── Build candidate list ──────────────────────────────────────────────────
    // (repo_idx, owner, name, branch, timestamp)
    let mut candidates_meta: Vec<(usize, String, String, String, String)> = Vec::new();

    for (i, repo) in repos.iter().enumerate() {
        let default_branch = match &default_branches[i] {
            Some(b) => b.clone(),
            None => continue,
        };
        let activities = match &activity_results[i] {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (owner, repo_name) = match repo.split_once('/') {
            Some(p) => (p.0.to_string(), p.1.to_string()),
            None => continue,
        };

        let mut seen = std::collections::HashSet::new();
        for a in activities {
            if !matches!(a.activity_type.as_str(), "push" | "force_push" | "branch_creation") {
                continue;
            }
            let branch = match a.git_ref.strip_prefix("refs/heads/") {
                Some(b) => b.to_string(),
                None => continue,
            };
            if branch == default_branch || !seen.insert(branch.clone()) {
                continue;
            }
            if open_head_refs.contains(&branch) {
                continue;
            }
            candidates_meta.push((i, owner.clone(), repo_name.clone(), branch, a.timestamp.clone()));
        }
    }

    if candidates_meta.is_empty() {
        return None;
    }

    // ── Round trip 3: PR check + commit message for all candidates ────────────
    let gql_candidates: Vec<(usize, &str, &str, &str)> = candidates_meta
        .iter()
        .map(|(ri, owner, name, branch, _)| (*ri, owner.as_str(), name.as_str(), branch.as_str()))
        .collect();
    let check_q = build_candidates_check_gql(&gql_candidates);
    let check_data = graphql_request_raw(&check_q, settings, client).await?;

    // Per-repo branch index (to match aliases c{bi}_*)
    let mut repo_branch_counter: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();

    let mut best: Option<BranchCandidate> = None;

    for (ri, _, _, branch, timestamp) in &candidates_meta {
        let bi = {
            let e = repo_branch_counter.entry(*ri).or_insert(0);
            let idx = *e;
            *e += 1;
            idx
        };
        let repo_node = &check_data[&format!("r_{ri}")];
        let prs = &repo_node[&format!("c{bi}_prs")]["nodes"];
        // If PR data is unavailable (null), skip conservatively to avoid proposing a branch
        // that already has an open PR (e.g. draft) when the check query returned a partial error.
        if prs.is_null() {
            continue;
        }
        if let Some(pr) = prs.as_array().and_then(|a| a.first()) {
            let is_open   = pr["state"].as_str() == Some("OPEN");
            let is_merged = pr["mergedAt"].is_string() && !pr["mergedAt"].is_null();
            if is_open || is_merged {
                continue;
            }
        }

        let title = repo_node[&format!("c{bi}_ref")]["target"]["messageHeadline"]
            .as_str()
            .unwrap_or("")
            .to_string();

        let (owner, repo_name) = repos[*ri].split_once('/').unwrap_or(("", ""));
        let candidate = BranchCandidate {
            repo: repos[*ri].clone(),
            branch: branch.clone(),
            base_branch: default_branches[*ri].clone().unwrap_or_default(),
            suggested_title: title,
            committed_at: timestamp.clone(),
        };
        let _ = (owner, repo_name);

        match &best {
            None => best = Some(candidate),
            Some(b) if candidate.committed_at > b.committed_at => best = Some(candidate),
            _ => {}
        }
    }

    let best = best?;

    // ── Round trip 4: diff stats ──────────────────────────────────────────────
    let stats = fetch_compare(&best.repo, &best.base_branch, &best.branch, settings, client).await;

    Some(DraftPrInfo {
        repo: best.repo,
        branch: best.branch,
        base_branch: best.base_branch,
        suggested_title: best.suggested_title,
        stats,
    })
}

pub async fn fetch_compare(
    repo: &str,
    base: &str,
    head: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Option<crate::models::BranchStats> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let url = format!("{}/repos/{}/compare/{}...{}", api_base, repo, base, head);
    let resp: serde_json::Value = github_request(&url, settings, client).await.ok()?;

    let total_add = resp["files"]
        .as_array()
        .map(|f| f.iter().map(|v| v["additions"].as_u64().unwrap_or(0)).sum::<u64>())
        .unwrap_or(0) as u32;
    let total_del = resp["files"]
        .as_array()
        .map(|f| f.iter().map(|v| v["deletions"].as_u64().unwrap_or(0)).sum::<u64>())
        .unwrap_or(0) as u32;
    let files_count = resp["files"].as_array().map(|f| f.len() as u32).unwrap_or(0);

    // compare API returns commits without per-commit file breakdown
    let commits = resp["commits"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .rev() // oldest first
                .map(|c| crate::models::CommitSummary {
                    sha: c["sha"].as_str().unwrap_or("").chars().take(7).collect(),
                    message: c["commit"]["message"]
                        .as_str()
                        .unwrap_or("")
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string(),
                    committed_at: c["commit"]["committer"]["date"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    Some(crate::models::BranchStats {
        additions: total_add,
        deletions: total_del,
        files: files_count,
        commits,
    })
}


/// Creates a pull request via the GitHub REST API and optionally assigns reviewers.
/// Returns the URL of the newly created PR.
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    repo: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    reviewers: &[String],
    draft: bool,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');

    #[derive(Serialize)]
    struct CreatePrPayload<'a> {
        title: &'a str,
        body: &'a str,
        head: &'a str,
        base: &'a str,
        draft: bool,
    }

    let response = client
        .post(format!("{}/repos/{}/pulls", api_base, repo))
        .headers(github_headers(settings))
        .json(&CreatePrPayload { title, body, head, base, draft })
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        // Surface a clean message when the branch already has an open PR.
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v["errors"]
                    .as_array()?
                    .first()?
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| body.clone());
        return Err(format!("GitHub API error {status}: {detail}"));
    }

    let pr: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let pr_number = pr["number"]
        .as_u64()
        .ok_or("Missing PR number in response")?;
    let pr_url = pr["html_url"]
        .as_str()
        .ok_or("Missing PR URL in response")?
        .to_string();

    // Assign reviewers if provided.
    if !reviewers.is_empty() {
        #[derive(Serialize)]
        struct ReviewersPayload<'a> {
            reviewers: &'a [String],
        }
        // Best-effort: ignore errors (e.g. reviewer is the PR author).
        let _ = client
            .post(format!(
                "{}/repos/{}/pulls/{}/requested_reviewers",
                api_base, repo, pr_number
            ))
            .headers(github_headers(settings))
            .json(&ReviewersPayload { reviewers })
            .send()
            .await;
    }

    Ok(pr_url)
}

/// Promotes a draft PR to ready for review: patches title/body, assigns reviewers,
/// then calls the `markPullRequestReadyForReview` GraphQL mutation.
/// Returns the PR HTML URL on success.
#[allow(clippy::too_many_arguments)]
pub async fn promote_draft_pr(
    repo: &str,
    pr_number: u64,
    node_id: &str,
    title: &str,
    body: &str,
    reviewers: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');

    #[derive(Serialize)]
    struct PatchPayload<'a> {
        title: &'a str,
        body: &'a str,
    }

    let patch_resp = client
        .patch(format!("{}/repos/{}/pulls/{}", api_base, repo, pr_number))
        .headers(github_headers(settings))
        .json(&PatchPayload { title, body })
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !patch_resp.status().is_success() {
        let status = patch_resp.status();
        let detail = patch_resp.text().await.unwrap_or_default();
        return Err(format!("GitHub API error {status}: {detail}"));
    }

    let pr_val: serde_json::Value = patch_resp.json().await.map_err(|e| e.to_string())?;
    let pr_url = pr_val["html_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    if !reviewers.is_empty() {
        #[derive(Serialize)]
        struct ReviewersPayload<'a> {
            reviewers: &'a [String],
        }
        let _ = client
            .post(format!(
                "{}/repos/{}/pulls/{}/requested_reviewers",
                api_base, repo, pr_number
            ))
            .headers(github_headers(settings))
            .json(&ReviewersPayload { reviewers })
            .send()
            .await;
    }

    let mutation = r#"mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { url }
  }
}"#;
    let gql_body = serde_json::json!({
        "query": mutation,
        "variables": { "id": node_id }
    });

    let gql_resp = client
        .post(graphql_url(settings))
        .headers(github_headers(settings))
        .json(&gql_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !gql_resp.status().is_success() {
        return Err(format!(
            "markPullRequestReadyForReview failed ({})",
            gql_resp.status()
        ));
    }

    let gql_val: serde_json::Value = gql_resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errors) = gql_val["errors"].as_array() {
        if !errors.is_empty() {
            let msg = errors[0]["message"]
                .as_str()
                .unwrap_or("Unknown GraphQL error");
            return Err(format!("markPullRequestReadyForReview: {msg}"));
        }
    }

    Ok(pr_url)
}

fn keep_latest_check_runs<'a>(runs: &[&'a GqlStatusContext]) -> Vec<&'a GqlStatusContext> {
    let mut latest: HashMap<String, &'a GqlStatusContext> = HashMap::new();

    for cr in runs {
        let key = cr
            .name
            .as_deref()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("__unnamed__:{}", cr.database_id.unwrap_or(0)));

        let should_replace = match latest.get(&key) {
            None => true,
            Some(cur) => {
                let cur_ts = ctx_timestamp(cur);
                let cand_ts = ctx_timestamp(cr);
                if cand_ts != cur_ts {
                    cand_ts > cur_ts
                } else {
                    cr.database_id.unwrap_or(0) > cur.database_id.unwrap_or(0)
                }
            }
        };

        if should_replace {
            latest.insert(key, cr);
        }
    }

    latest.into_values().collect()
}

fn ctx_timestamp(cr: &GqlStatusContext) -> i64 {
    cr.completed_at
        .as_deref()
        .or(cr.started_at.as_deref())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(i64::MIN)
}
