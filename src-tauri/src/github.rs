use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::models::{
    ApiError, AppSettings, DraftPrInfo, Mainline, MainlineCommit, MainlineTag, StaleBranch,
    StaleBranchesResult, PipelineState,
};

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
    /// Head commit SHA at fetch time — used as `expectedHeadOid` when triggering a
    /// rebase, so GitHub rejects the mutation instead of racing a concurrent push.
    pub head_sha: String,
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
    /// True when the failure was an authentication error (HTTP 401) rather than
    /// a transient/other error — used to surface a re-authenticate prompt.
    pub auth_failed: bool,
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
) -> Result<T, ApiError> {
    let response = client
        .get(url)
        .headers(github_headers(settings))
        .send()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::from_status(
            status.as_u16(),
            format!("GitHub request failed ({status}) for {url}"),
        ));
    }

    response
        .json::<T>()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))
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
) -> Result<GqlResponse, ApiError> {
    let url = graphql_url(settings);
    let body = serde_json::json!({ "query": query, "variables": variables });

    let response = client
        .post(&url)
        .headers(github_headers(settings))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("GraphQL request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::from_status(
            status.as_u16(),
            format!("GitHub GraphQL API returned {status} for {url}"),
        ));
    }

    response
        .json::<GqlResponse>()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))
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
) -> Result<String, ApiError> {
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
            auth_failed: false,
        },
        Err(e) => GithubRepoFetchResult {
            repo: repo.to_string(),
            ok: false,
            pull_requests: vec![],
            auth_failed: e.is_auth(),
            error: Some(e.to_string()),
        },
    }
}

async fn fetch_repo_pull_requests_inner(
    repo: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<GithubPullRequestRecord>, ApiError> {
    let (owner, repo_name) = repo
        .split_once('/')
        .ok_or_else(|| ApiError::Other(format!("Invalid repo format: {repo}")))?;

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
            return Err(ApiError::Other(format!("GraphQL error: {}", msgs.join("; "))));
        }

        let connection = resp
            .data
            .and_then(|d| d.repository)
            .ok_or_else(|| ApiError::Other(format!("Repository {repo} not found or inaccessible")))?
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
            head_sha: pr
                .head_ref
                .as_ref()
                .and_then(|h| h.target.as_ref())
                .map(|t| t.oid.clone())
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

/// Changed files of a pull request with their patches. GitHub pages them 100 at
/// a time and stops at 3000 files, i.e. 30 pages.
pub async fn fetch_pr_files(
    repo: &str,
    number: u64,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<crate::models::PrDiff, ApiError> {
    const PER_PAGE: usize = 100;
    const MAX_PAGES: u32 = 30;
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let mut files = Vec::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{}/repos/{}/pulls/{}/files?per_page={}&page={}",
            api_base, repo, number, PER_PAGE, page
        );
        let batch: Vec<serde_json::Value> = github_request(&url, settings, client).await?;
        let full_page = batch.len() == PER_PAGE;
        files.extend(batch.iter().map(parse_pr_file));
        if !full_page {
            return Ok(crate::models::PrDiff { files, truncated: false, head_sha: String::new() });
        }
    }
    Ok(crate::models::PrDiff { files, truncated: true, head_sha: String::new() })
}

/// What a reviewer reads before the code: the PR itself and both ends of its range.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrMeta {
    pub url: String,
    pub title: String,
    pub description: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub base_ref: String,
    pub base_sha: String,
    pub head_ref: String,
    pub head_sha: String,
}

pub async fn fetch_pr_meta(
    repo: &str,
    number: u64,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<PrMeta, ApiError> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let url = format!("{}/repos/{}/pulls/{}", api_base, repo, number);
    let pr: serde_json::Value = github_request(&url, settings, client).await?;
    let text = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
    Ok(PrMeta {
        url: text(&pr["html_url"]),
        title: text(&pr["title"]),
        description: text(&pr["body"]),
        author: text(&pr["user"]["login"]),
        state: if pr["merged_at"].is_string() { "merged".into() } else { text(&pr["state"]) },
        draft: pr["draft"].as_bool().unwrap_or(false),
        base_ref: text(&pr["base"]["ref"]),
        base_sha: text(&pr["base"]["sha"]),
        head_ref: text(&pr["head"]["ref"]),
        head_sha: text(&pr["head"]["sha"]),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComment {
    pub author: String,
    pub avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    /// Part of the viewer's own review, not submitted yet on GitHub.
    pub pending: bool,
    /// Why GitHub hides it ("outdated", "spam"…), when it does.
    pub minimized: Option<String>,
}

/// A review conversation on the PR, placed as GitHub places it: under a line
/// of the latest diff, on the whole file, or outdated — written on code that
/// changed since, and kept with the hunk it was written on.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    /// Last line of the range in the PR's latest diff; None when outdated or on the whole file.
    pub line: Option<u64>,
    pub start_line: Option<u64>,
    /// The same on the commit the conversation started on, which GitHub keeps.
    pub original_line: Option<u64>,
    pub original_start_line: Option<u64>,
    pub original_commit: String,
    /// "new" (RIGHT) or "old" (LEFT).
    pub side: String,
    pub resolved: bool,
    pub resolved_by: Option<String>,
    pub outdated: bool,
    /// The hunk it was written on, down to its line: what GitHub shows above an outdated conversation.
    pub diff_hunk: String,
    pub comments: Vec<ThreadComment>,
    /// Replies past the ones fetched, left to read on GitHub.
    pub more_comments: u64,
}

const REVIEW_THREADS_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line startLine originalLine originalStartLine diffSide isResolved isOutdated
          resolvedBy { login }
          comments(first: 50) {
            totalCount
            nodes {
              author { login avatarUrl(size: 40) }
              body createdAt url diffHunk state isMinimized minimizedReason
              originalCommit { oid }
            }
          }
        }
      }
    }
  }
}
"#;

/// Pages of 100 conversations; past this, the rest stays on GitHub.
const MAX_THREAD_PAGES: usize = 10;

pub async fn fetch_review_threads(
    repo: &str,
    number: u64,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<ReviewThread>, ApiError> {
    let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
    let mut threads = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_THREAD_PAGES {
        let data = graphql_data(
            REVIEW_THREADS_QUERY,
            serde_json::json!({ "owner": owner, "name": name, "number": number, "after": after }),
            settings,
            client,
        )
        .await?;
        let page = &data["repository"]["pullRequest"]["reviewThreads"];
        if let Some(nodes) = page["nodes"].as_array() {
            threads.extend(nodes.iter().map(parse_review_thread));
        }
        after = page["pageInfo"]["endCursor"].as_str().map(str::to_string);
        if page["pageInfo"]["hasNextPage"].as_bool() != Some(true) || after.is_none() {
            break;
        }
    }
    Ok(threads)
}

fn parse_review_thread(t: &serde_json::Value) -> ReviewThread {
    let text = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
    let nodes = t["comments"]["nodes"].as_array().cloned().unwrap_or_default();
    let first = nodes.first().cloned().unwrap_or_default();
    let comments: Vec<ThreadComment> = nodes
        .iter()
        .map(|c| ThreadComment {
            author: c["author"]["login"].as_str().unwrap_or("ghost").to_string(),
            avatar_url: text(&c["author"]["avatarUrl"]),
            body: text(&c["body"]),
            created_at: text(&c["createdAt"]),
            url: text(&c["url"]),
            pending: c["state"].as_str() == Some("PENDING"),
            minimized: (c["isMinimized"].as_bool() == Some(true)).then(|| text(&c["minimizedReason"]).to_lowercase()),
        })
        .collect();
    let total = t["comments"]["totalCount"].as_u64().unwrap_or(comments.len() as u64);
    ReviewThread {
        id: text(&t["id"]),
        path: text(&t["path"]),
        line: t["line"].as_u64(),
        start_line: t["startLine"].as_u64(),
        original_line: t["originalLine"].as_u64(),
        original_start_line: t["originalStartLine"].as_u64(),
        original_commit: text(&first["originalCommit"]["oid"]),
        side: if t["diffSide"].as_str() == Some("LEFT") { "old" } else { "new" }.to_string(),
        resolved: t["isResolved"].as_bool().unwrap_or(false),
        resolved_by: t["resolvedBy"]["login"].as_str().map(str::to_string),
        outdated: t["isOutdated"].as_bool().unwrap_or(false),
        diff_hunk: text(&first["diffHunk"]),
        more_comments: total.saturating_sub(comments.len() as u64),
        comments,
    }
}

/// What changed between two commits of a PR, file by file: what carries a
/// comment written on the older one over to the newer.
pub async fn fetch_commit_compare(
    repo: &str,
    from: &str,
    to: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<crate::pr_review::CommitCompare, ApiError> {
    /// GitHub lists this many changed files at most.
    const MAX_FILES: usize = 300;
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    // The files come with the first page; one commit per page keeps it small.
    let url = format!("{}/repos/{}/compare/{}...{}?per_page=1", api_base, repo, from, to);
    let resp: serde_json::Value = github_request(&url, settings, client).await?;
    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let files: Vec<crate::pr_review::FileChange> = resp["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .map(|f| crate::pr_review::FileChange {
                    path: text(&f["filename"]).unwrap_or_default(),
                    previous_path: text(&f["previous_filename"]),
                    status: text(&f["status"]).unwrap_or_default(),
                    patch: text(&f["patch"]),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(crate::pr_review::CommitCompare {
        linear: matches!(resp["status"].as_str(), Some("ahead" | "identical")),
        complete: files.len() < MAX_FILES,
        files,
    })
}

/// Creates a pull request review: on its commit, with its verdict, text, line
/// comments and replies. Without replies it is one request, which GitHub takes
/// whole or not at all. Replies only join a review while it is pending, so then
/// the review is created pending, given its replies and submitted — and
/// deleted if any step fails, which leaves nothing half sent: a pending review
/// is only ever visible to its author. Returns the review's page.
pub async fn create_review(
    repo: &str,
    number: u64,
    review: &crate::pr_review::PlannedReview,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    if review.replies.is_empty() {
        return Ok(post_review(repo, number, review, true, settings, client).await?.url);
    }
    let pending = post_review(repo, number, review, false, settings, client).await?;
    let finished = async {
        for reply in &review.replies {
            add_thread_reply(&reply.thread_id, &reply.body, Some(&pending.node_id), settings, client).await?;
        }
        submit_review(repo, number, pending.id, review, settings, client).await
    }
    .await;
    if let Err(error) = &finished {
        if let Err(cleanup) = delete_pending_review(repo, number, pending.id, settings, client).await {
            // Left behind, it would make the next publish fail with no reason anyone could see.
            // Discarded, not submitted: ZuGit still has every comment, and would send them twice.
            return Err(format!(
                "{error} — and the review begun for it could not be removed ({cleanup}). It waits on GitHub as your pending review, visible only to you, with a copy of these comments: discard it there, then publish again from here, where they all still are."
            ));
        }
    }
    finished
}

struct CreatedReview {
    id: u64,
    node_id: String,
    url: String,
}

/// POSTs the review with its comments: submitted with its verdict, or pending.
async fn post_review(
    repo: &str,
    number: u64,
    review: &crate::pr_review::PlannedReview,
    submit: bool,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<CreatedReview, String> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let mut payload = serde_json::json!({ "commit_id": review.commit, "comments": review.comments });
    if submit {
        payload["event"] = review.event.as_str().into();
        if !review.body.is_empty() {
            payload["body"] = review.body.clone().into();
        }
    }
    let response = client
        .post(format!("{api_base}/repos/{repo}/pulls/{number}/reviews"))
        .headers(github_headers(settings))
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let created = github_reply(response).await?;
    Ok(CreatedReview {
        id: created["id"].as_u64().ok_or("GitHub did not say which review it created.")?,
        node_id: created["node_id"].as_str().unwrap_or_default().to_string(),
        url: created["html_url"].as_str().unwrap_or_default().to_string(),
    })
}

/// Submits a pending review with its verdict and text.
async fn submit_review(
    repo: &str,
    number: u64,
    review_id: u64,
    review: &crate::pr_review::PlannedReview,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let mut payload = serde_json::json!({ "event": review.event.as_str() });
    if !review.body.is_empty() {
        payload["body"] = review.body.clone().into();
    }
    let response = client
        .post(format!("{api_base}/repos/{repo}/pulls/{number}/reviews/{review_id}/events"))
        .headers(github_headers(settings))
        .json(&payload)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(github_reply(response).await?["html_url"].as_str().unwrap_or_default().to_string())
}

async fn delete_pending_review(
    repo: &str,
    number: u64,
    review_id: u64,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let api_base = settings.github_api_base_url.trim_end_matches('/');
    let response = client
        .delete(format!("{api_base}/repos/{repo}/pulls/{number}/reviews/{review_id}"))
        .headers(github_headers(settings))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    github_reply(response).await.map(|_| ())
}

/// Replies to one of the PR's conversations: inside a pending review when
/// `review` names one, or at once, as GitHub's "Add single comment" does.
pub async fn add_thread_reply(
    thread_id: &str,
    body: &str,
    review: Option<&str>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    const MUTATION: &str = r#"
mutation($thread: ID!, $body: String!, $review: ID) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body, pullRequestReviewId: $review }) {
    comment { id }
  }
}
"#;
    graphql_data(MUTATION, serde_json::json!({ "thread": thread_id, "body": body, "review": review }), settings, client)
        .await
        .map(|_| ())
        .map_err(|e| format!("GitHub refused the reply: {e}"))
}

/// Resolves a conversation, or opens it again — at once, as on GitHub: it is
/// not part of a review. GitHub lets the PR's author and those with write
/// access do it, and says so to anyone else. Returns whether it is resolved now.
pub async fn set_thread_resolved(
    thread_id: &str,
    resolved: bool,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<bool, String> {
    const RESOLVE: &str = "mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }";
    const UNRESOLVE: &str = "mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }";
    let (mutation, field) = if resolved { (RESOLVE, "resolveReviewThread") } else { (UNRESOLVE, "unresolveReviewThread") };
    let data = graphql_data(mutation, serde_json::json!({ "thread": thread_id }), settings, client)
        .await
        .map_err(|e| format!("GitHub refused: {e}"))?;
    Ok(data[field]["thread"]["isResolved"].as_bool().unwrap_or(resolved))
}

/// The JSON of a successful response, or why GitHub refused.
async fn github_reply(response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub refused the review ({status}): {}", github_error(&body)));
    }
    Ok(serde_json::from_str(&body).unwrap_or_default())
}

/// Why GitHub refused a request: the `errors` it lists, or its message.
fn github_error(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return body.chars().take(300).collect();
    };
    let errors: Vec<String> = value["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .filter_map(|e| e.as_str().or_else(|| e["message"].as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if errors.is_empty() {
        value["message"].as_str().unwrap_or("no reason given").to_string()
    } else {
        errors.join("; ")
    }
}

fn parse_pr_file(f: &serde_json::Value) -> crate::models::PrFileDiff {
    let text = |key: &str| f[key].as_str().map(str::to_string);
    crate::models::PrFileDiff {
        filename: text("filename").unwrap_or_default(),
        previous_filename: text("previous_filename"),
        status: text("status").unwrap_or_default(),
        additions: f["additions"].as_u64().unwrap_or(0) as u32,
        deletions: f["deletions"].as_u64().unwrap_or(0) as u32,
        patch: text("patch"),
        blob_url: text("blob_url").unwrap_or_default(),
    }
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

/// Triggers a real rebase + force-push of a PR's branch onto its base branch via
/// `updatePullRequestBranch(updateMethod: REBASE)` — the same operation as GitHub's
/// web UI "Update with rebase" button. Unlike `PUT /pulls/{n}/update-branch` (REST),
/// which only supports a merge-commit update, this is GraphQL-only.
///
/// `expected_head_sha` is passed as `expectedHeadOid`, GitHub's optimistic-concurrency
/// guard for this mutation: if the branch's real current head doesn't match (e.g. the
/// author pushed a new commit after our last dashboard refresh), GitHub rejects the
/// call instead of rebasing over it — turning a possible silent clobber of concurrent
/// work into a clean, visible error.
///
/// Callers should only invoke this when `mergeStatus == "behind"`; a rejection here
/// most likely means the state changed a moment ago (a new push, or a new conflicting
/// commit on the base branch), not routine behavior, so the error is surfaced as-is
/// rather than retried or swallowed.
pub async fn rebase_pull_request(
    node_id: &str,
    expected_head_sha: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<(), String> {
    let mutation = r#"mutation($id: ID!, $sha: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $sha, updateMethod: REBASE }) {
    pullRequest { id }
  }
}"#;
    let gql_body = serde_json::json!({
        "query": mutation,
        "variables": { "id": node_id, "sha": expected_head_sha }
    });

    let resp = client
        .post(graphql_url(settings))
        .headers(github_headers(settings))
        .json(&gql_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("updatePullRequestBranch failed ({})", resp.status()));
    }

    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(errors) = val["errors"].as_array() {
        if !errors.is_empty() {
            let msg = errors[0]["message"].as_str().unwrap_or("Unknown GraphQL error");
            return Err(format!("updatePullRequestBranch: {msg}"));
        }
    }

    Ok(())
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

fn tag_ref_timestamp_ms(tag_ref: &serde_json::Value) -> Option<i64> {
    let target = &tag_ref["target"];
    target["committedDate"]
        .as_str()
        .or_else(|| target["tagger"]["date"].as_str())
        .or_else(|| target["target"]["committedDate"].as_str())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
}

// ── Release diff: merged PRs since last release ───────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedPrRecord {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub merged_at: String,
    pub head_ref: String,
    pub author: String,
    pub author_avatar_url: Option<String>,
    pub jira_keys: Vec<String>,
}

/// Quotes a value for inlining into a GraphQL query as a string literal.
fn graphql_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// PR number a commit message points back to: GitHub's squash suffix "(#123)"
/// or the "Merge pull request #123" headline. A cherry-pick keeps the original
/// message, so this leads back to the PR the story was first merged with.
fn pr_number_in_message(message: &str) -> Option<u64> {
    static PR_REF_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r"\(#(\d+)\)|Merge pull request #(\d+)").unwrap()
    });
    PR_REF_RE
        .captures(message)
        .and_then(|c| c.get(1).or_else(|| c.get(2)))
        .and_then(|m| m.as_str().parse().ok())
}

/// Merged work since the latest tag on `target_branch`, or on the default branch
/// when none is given.
///
/// On a release branch stories often land as plain cherry-picks with no PR of
/// their own, so besides the PRs whose base is that branch the commits since the
/// tag are scanned too: any Jira key they carry counts as merged.
pub async fn fetch_merged_prs_since_last_release(
    repos: &[String],
    target_branch: Option<&str>,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> (Vec<MergedPrRecord>, String) {
    if repos.is_empty() {
        return (vec![], String::new());
    }

    // Build one batched GraphQL query across all repos. It fetches:
    // - last 100 commits on the target branch to locate the latest tag on that branch
    // - all recent tags with resolved commit OIDs (for cross-referencing with the branch history)
    // - merged PRs after that tag (only those based on the target branch, when one is given)
    let (branch_ref, history_fields, pr_filter) = match target_branch {
        Some(branch) => (
            format!("ref(qualifiedName: {})", graphql_string(&format!("refs/heads/{branch}"))),
            "oid url messageHeadline message author { user { login avatarUrl } name } committedDate",
            format!(", baseRefName: {}", graphql_string(branch)),
        ),
        None => ("defaultBranchRef".to_string(), "oid", String::new()),
    };
    let mut q = String::from("{");
    for (i, repo) in repos.iter().enumerate() {
        if let Some((owner, name)) = repo.split_once('/') {
            q.push_str(&format!(
                r#" r_{i}: repository(owner:"{owner}", name:"{name}") {{
                  url
                  branchRef: {branch_ref} {{
                    target {{
                      ... on Commit {{
                        history(first: 100) {{
                          nodes {{ {history_fields} }}
                        }}
                      }}
                    }}
                  }}
                  refs(refPrefix:"refs/tags/", first: 20, orderBy: {{field: TAG_COMMIT_DATE, direction: DESC}}) {{
                    nodes {{
                      name
                      target {{
                        oid
                        ... on Commit {{ committedDate }}
                        ... on Tag {{
                          tagger {{ date }}
                          target {{ oid ... on Commit {{ committedDate }} }}
                        }}
                      }}
                    }}
                  }}
                  pullRequests(states: [MERGED]{pr_filter}, first: 100, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{
                    nodes {{ number title body headRefName mergedAt url author {{ login avatarUrl }} }}
                  }}
                }}"#
            ));
        }
    }
    q.push('}');

    let data = match graphql_request_raw(&q, settings, client).await {
        Some(d) => d,
        None => return (vec![], String::new()),
    };

    let mut result: Vec<MergedPrRecord> = vec![];
    let mut since_tags: Vec<String> = vec![];

    for i in 0..repos.len() {
        let repo_node = &data[&format!("r_{i}")];
        if repo_node.is_null() {
            continue;
        }

        // Build a map from resolved commit OID → tag node.
        // Lightweight tags: commit OID is in target.oid
        // Annotated tags:   commit OID is in target.target.oid (target itself is a Tag object)
        let tag_nodes = repo_node["refs"]["nodes"].as_array();
        let mut oid_to_tag: std::collections::HashMap<&str, &serde_json::Value> =
            std::collections::HashMap::new();
        if let Some(tags) = tag_nodes {
            for tag in tags {
                let commit_oid = tag["target"]["target"]["oid"]
                    .as_str()
                    .or_else(|| tag["target"]["oid"].as_str());
                if let Some(oid) = commit_oid {
                    oid_to_tag.insert(oid, tag);
                }
            }
        }

        // Walk the branch's commit history and find the most recent commit that has a tag.
        // This ensures we only consider tags reachable from that branch.
        let branch_history: &[serde_json::Value] = repo_node["branchRef"]["target"]["history"]["nodes"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        let tagged_index = branch_history.iter().position(|c| {
            c["oid"]
                .as_str()
                .map(|oid| oid_to_tag.contains_key(oid))
                .unwrap_or(false)
        });
        let latest_tag_ref: Option<&serde_json::Value> = tagged_index
            .and_then(|idx| branch_history[idx]["oid"].as_str())
            .and_then(|oid| oid_to_tag.get(oid).copied());

        let latest_tag_ms: i64 = latest_tag_ref
            .and_then(tag_ref_timestamp_ms)
            .unwrap_or(0); // 0 = epoch, i.e. include all PRs if no tag exists
        let latest_tag = latest_tag_ref
            .and_then(|r| r["name"].as_str())
            .unwrap_or("beginning");
        if latest_tag != "beginning" {
            since_tags.push(latest_tag.to_string());
        }

        let prs: &[serde_json::Value] = repo_node["pullRequests"]["nodes"]
            .as_array()
            .map(|a| a.as_slice())
            .unwrap_or(&[]);

        let repo_start = result.len();
        for pr in prs {
            let merged_at = match pr["mergedAt"].as_str() {
                Some(s) => s,
                None => continue,
            };
            let merged_ms = chrono::DateTime::parse_from_rfc3339(merged_at)
                .ok()
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            if merged_ms <= latest_tag_ms {
                continue;
            }

            let title = pr["title"].as_str().unwrap_or("").to_string();
            let body = pr["body"].as_str().unwrap_or("").to_string();
            let head_ref = pr["headRefName"].as_str().unwrap_or("").to_string();
            let url = pr["url"].as_str().unwrap_or("").to_string();
            let number = pr["number"].as_u64().unwrap_or(0);
            let author = pr["author"]["login"].as_str().unwrap_or("").to_string();
            let author_avatar_url = pr["author"]["avatarUrl"].as_str().map(|s| s.to_string());

            let jira_keys = pr_jira_keys(&title, &head_ref, &body);

            result.push(MergedPrRecord {
                number,
                title,
                url,
                merged_at: merged_at.to_string(),
                head_ref,
                author,
                author_avatar_url,
                jira_keys,
            });
        }

        if target_branch.is_none() {
            continue;
        }

        // Commits after the tag that bring a story no PR above covers: cherry-picks
        // pushed straight to the branch. Each becomes a record of its own, linked
        // to the original PR when the message names one.
        let mut covered: std::collections::HashSet<String> = result[repo_start..]
            .iter()
            .flat_map(|r| r.jira_keys.iter().cloned())
            .collect();
        let repo_url = repo_node["url"].as_str().unwrap_or("");
        let since_tag_commits = &branch_history[..tagged_index.unwrap_or(branch_history.len())];
        for commit in since_tag_commits {
            let headline = commit["messageHeadline"].as_str().unwrap_or("");
            let message = commit["message"].as_str().unwrap_or("");
            let mut jira_keys = crate::jira::extract_all_jira_keys(headline);
            if jira_keys.is_empty() {
                jira_keys = crate::jira::extract_all_jira_keys(message);
            }
            jira_keys.retain(|k| covered.insert(k.clone()));
            if jira_keys.is_empty() {
                continue;
            }

            let original_pr = pr_number_in_message(message).filter(|_| !repo_url.is_empty());
            let url = match original_pr {
                Some(n) => format!("{repo_url}/pull/{n}"),
                None => commit["url"].as_str().unwrap_or("").to_string(),
            };
            let author = commit["author"]["user"]["login"]
                .as_str()
                .or_else(|| commit["author"]["name"].as_str())
                .unwrap_or("")
                .to_string();

            result.push(MergedPrRecord {
                number: original_pr.unwrap_or(0),
                title: headline.to_string(),
                url,
                merged_at: commit["committedDate"].as_str().unwrap_or("").to_string(),
                head_ref: String::new(),
                author,
                author_avatar_url: commit["author"]["user"]["avatarUrl"].as_str().map(|s| s.to_string()),
                jira_keys,
            });
        }
    }

    let since_tag = since_tags.join(" · ");
    (result, since_tag)
}

/// Jira keys a PR is about: the title first, then the head branch and body.
fn pr_jira_keys(title: &str, head_ref: &str, body: &str) -> Vec<String> {
    let mut jira_keys = crate::jira::extract_all_jira_keys(title);
    if jira_keys.is_empty() {
        jira_keys = crate::jira::extract_all_jira_keys(&format!("{head_ref}\n{body}"));
    }
    jira_keys.dedup();
    jira_keys
}

/// Date of the commit a tag points at — where the tag sits on the branch —
/// falling back to the tagger date.
fn tag_commit_date(tag_ref: &serde_json::Value) -> Option<String> {
    let target = &tag_ref["target"];
    target["committedDate"]
        .as_str()
        .or_else(|| target["target"]["committedDate"].as_str())
        .or_else(|| target["tagger"]["date"].as_str())
        .map(|s| s.to_string())
}

/// Recent history of the default branch for the release map: the last merged
/// PRs into it and the tags reachable from it. One batched GraphQL query.
pub async fn fetch_mainline(
    repos: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Mainline {
    if repos.is_empty() {
        return Mainline::default();
    }

    let mut q = String::from("{");
    for (i, repo) in repos.iter().enumerate() {
        if let Some((owner, name)) = repo.split_once('/') {
            q.push_str(&format!(
                r#" r_{i}: repository(owner:"{owner}", name:"{name}") {{
                  defaultBranchRef {{
                    name
                    target {{ ... on Commit {{ history(first: 100) {{ nodes {{ oid }} }} }} }}
                  }}
                  refs(refPrefix:"refs/tags/", first: 30, orderBy: {{field: TAG_COMMIT_DATE, direction: DESC}}) {{
                    nodes {{
                      name
                      target {{
                        oid
                        ... on Commit {{ committedDate }}
                        ... on Tag {{
                          tagger {{ date }}
                          target {{ oid ... on Commit {{ committedDate }} }}
                        }}
                      }}
                    }}
                  }}
                  pullRequests(states: [MERGED], first: 100, orderBy: {{field: UPDATED_AT, direction: DESC}}) {{
                    nodes {{ number title body headRefName baseRefName mergedAt url }}
                  }}
                }}"#
            ));
        }
    }
    q.push('}');

    match graphql_request_raw(&q, settings, client).await {
        Some(data) => parse_mainline(&data, repos.len()),
        None => Mainline::default(),
    }
}

fn parse_mainline(data: &serde_json::Value, repo_count: usize) -> Mainline {
    let mut mainline = Mainline::default();
    let mut tag_names = std::collections::HashSet::new();

    for i in 0..repo_count {
        let repo_node = &data[&format!("r_{i}")];
        let Some(default_branch) = repo_node["defaultBranchRef"]["name"].as_str() else {
            continue;
        };
        if mainline.branch.is_empty() {
            mainline.branch = default_branch.to_string();
        }

        // A tag counts only when its commit is in the branch history — tags cut
        // on release branches must not show up on main.
        let history: std::collections::HashSet<&str> = repo_node["defaultBranchRef"]["target"]["history"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["oid"].as_str())
            .collect();
        for tag in repo_node["refs"]["nodes"].as_array().into_iter().flatten() {
            let oid = tag["target"]["target"]["oid"]
                .as_str()
                .or_else(|| tag["target"]["oid"].as_str());
            let (Some(name), Some(oid), Some(date)) = (tag["name"].as_str(), oid, tag_commit_date(tag)) else {
                continue;
            };
            if history.contains(oid) && tag_names.insert(name.to_string()) {
                mainline.tags.push(MainlineTag { name: name.to_string(), date });
            }
        }

        for pr in repo_node["pullRequests"]["nodes"].as_array().into_iter().flatten() {
            if pr["baseRefName"].as_str() != Some(default_branch) {
                continue;
            }
            let Some(merged_at) = pr["mergedAt"].as_str() else { continue };
            let title = pr["title"].as_str().unwrap_or("");
            mainline.commits.push(MainlineCommit {
                number: pr["number"].as_u64().unwrap_or(0),
                url: pr["url"].as_str().unwrap_or("").to_string(),
                title: title.to_string(),
                merged_at: merged_at.to_string(),
                jira_keys: pr_jira_keys(
                    title,
                    pr["headRefName"].as_str().unwrap_or(""),
                    pr["body"].as_str().unwrap_or(""),
                ),
            });
        }
    }

    // RFC 3339 timestamps from the same API sort correctly as strings.
    mainline.commits.sort_by(|a, b| a.merged_at.cmp(&b.merged_at));
    mainline.tags.sort_by(|a, b| a.date.cmp(&b.date));
    mainline
}

/// Branches whose name starts with `prefix` (case-insensitive) across `repos`,
/// most recently updated first. A name present in several repos is listed once.
pub async fn fetch_release_branches(
    repos: &[String],
    prefix: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Vec<String> {
    if repos.is_empty() {
        return vec![];
    }

    let mut q = String::from("{");
    for (i, repo) in repos.iter().enumerate() {
        if let Some((owner, name)) = repo.split_once('/') {
            q.push_str(&format!(
                r#" r_{i}: repository(owner:"{owner}", name:"{name}") {{
                  refs(refPrefix:"refs/heads/", query: {query}, first: 100) {{
                    nodes {{ name target {{ ... on Commit {{ committedDate }} }} }}
                  }}
                }}"#,
                query = graphql_string(prefix),
            ));
        }
    }
    q.push('}');

    let data = match graphql_request_raw(&q, settings, client).await {
        Some(d) => d,
        None => return vec![],
    };

    // `query` matches anywhere in the name; only a leading match counts here.
    let prefix = prefix.to_lowercase();
    let mut latest: HashMap<String, String> = HashMap::new();
    for i in 0..repos.len() {
        let nodes = data[&format!("r_{i}")]["refs"]["nodes"].as_array();
        for node in nodes.into_iter().flatten() {
            let Some(name) = node["name"].as_str() else { continue };
            if !name.to_lowercase().starts_with(&prefix) {
                continue;
            }
            let date = node["target"]["committedDate"].as_str().unwrap_or("").to_string();
            let entry = latest.entry(name.to_string()).or_default();
            if date > *entry {
                *entry = date;
            }
        }
    }

    let mut branches: Vec<(String, String)> = latest.into_iter().collect();
    // RFC 3339 timestamps from the same API sort correctly as strings.
    branches.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    branches.into_iter().map(|(name, _)| name).collect()
}

// ── Stale branches ───────────────────────────────────────────────────────────

/// Head and base refs of every open PR in the repo. A branch that is the base of
/// an open PR is a shared integration branch, not an abandoned one, so both sides
/// are excluded.
const OPEN_PR_REFS_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { headRefName baseRefName }
    }
  }
}
"#;

/// Branch refs oldest-commit-first, so the scan can stop as soon as it reaches
/// branches that are still recent.
const BRANCH_REFS_QUERY: &str = r#"
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    url
    defaultBranchRef { name }
    refs(
      refPrefix: "refs/heads/"
      first: 100
      after: $cursor
      orderBy: { field: TAG_COMMIT_DATE, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        branchProtectionRule { id }
        target {
          ... on Commit {
            oid
            committedDate
            messageHeadline
            author { name user { login avatarUrl } }
          }
        }
      }
    }
  }
}
"#;

/// Safety net for repos with thousands of branches: 100 per page.
const MAX_BRANCH_PAGES: usize = 20;

/// Internal covers both ways the app knows a colleague — the author marker and
/// the explicit team list — because this view only offers a two-way filter.
/// A commit with no linked GitHub account has no login to match, so it lands in
/// `Collaborator`.
fn classify_branch_author(login: &str, settings: &AppSettings) -> crate::models::AuthorType {
    let lower = login.to_lowercase();
    let is_team_member = settings
        .team_member_github_users
        .iter()
        .any(|user| user.to_lowercase() == lower);
    let marker_match = !settings.internal_author_marker.is_empty()
        && lower.contains(&settings.internal_author_marker.to_lowercase());

    if !login.is_empty() && (is_team_member || marker_match) {
        crate::models::AuthorType::Internal
    } else {
        crate::models::AuthorType::Collaborator
    }
}

/// Like `graphql_request_raw`, but takes variables and reports failures instead
/// of swallowing them — the stale-branches view surfaces per-repo errors as warnings.
async fn graphql_data(
    query: &str,
    variables: serde_json::Value,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<serde_json::Value, ApiError> {
    let url = graphql_url(settings);
    let body = serde_json::json!({ "query": query, "variables": variables });

    let response = client
        .post(&url)
        .headers(github_headers(settings))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError::Other(format!("GraphQL request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::from_status(
            status.as_u16(),
            format!("GitHub GraphQL API returned {status}"),
        ));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| ApiError::Other(e.to_string()))?;

    if let Some(message) = json["errors"][0]["message"].as_str() {
        return Err(ApiError::Other(message.to_string()));
    }

    Ok(json["data"].clone())
}

async fn fetch_open_pr_refs(
    owner: &str,
    name: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<std::collections::HashSet<String>, ApiError> {
    let mut refs = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;

    loop {
        let data = graphql_data(
            OPEN_PR_REFS_QUERY,
            serde_json::json!({ "owner": owner, "repo": name, "cursor": cursor }),
            settings,
            client,
        )
        .await?;

        let connection = &data["repository"]["pullRequests"];
        for node in connection["nodes"].as_array().unwrap_or(&vec![]) {
            for key in ["headRefName", "baseRefName"] {
                if let Some(value) = node[key].as_str() {
                    refs.insert(value.to_string());
                }
            }
        }

        if connection["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
            return Ok(refs);
        }
        cursor = connection["pageInfo"]["endCursor"].as_str().map(String::from);
        if cursor.is_none() {
            return Ok(refs);
        }
    }
}

async fn fetch_repo_stale_branches(
    repo: &str,
    cutoff: chrono::DateTime<chrono::Utc>,
    ignored_prefixes: &[String],
    viewer_login: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<Vec<StaleBranch>, ApiError> {
    let (owner, name) = repo
        .split_once('/')
        .ok_or_else(|| ApiError::Other(format!("\"{repo}\" is not in owner/name form")))?;

    let excluded_refs = fetch_open_pr_refs(owner, name, settings, client).await?;

    let now = chrono::Utc::now();
    let mut stale: Vec<StaleBranch> = Vec::new();
    let mut cursor: Option<String> = None;

    for _ in 0..MAX_BRANCH_PAGES {
        let data = graphql_data(
            BRANCH_REFS_QUERY,
            serde_json::json!({ "owner": owner, "repo": name, "cursor": cursor }),
            settings,
            client,
        )
        .await?;

        let repository = &data["repository"];
        let repo_url = repository["url"].as_str().unwrap_or("").to_string();
        let default_branch = repository["defaultBranchRef"]["name"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let connection = &repository["refs"];
        let nodes = connection["nodes"].as_array().cloned().unwrap_or_default();

        // Refs come oldest-commit-first, so once a page ends on a recent branch
        // every later page is recent too and the scan can stop there.
        let mut reached_recent = false;

        for node in &nodes {
            let branch = node["name"].as_str().unwrap_or("").to_string();
            let commit = &node["target"];
            let committed_date = match commit["committedDate"].as_str() {
                Some(value) => value,
                None => continue, // annotated tag or unreachable object — not a branch tip we can date
            };
            let committed_at = match chrono::DateTime::parse_from_rfc3339(committed_date) {
                Ok(value) => value.with_timezone(&chrono::Utc),
                Err(_) => continue,
            };

            if committed_at > cutoff {
                reached_recent = true;
                continue;
            }
            if branch.is_empty() || branch == default_branch || excluded_refs.contains(&branch) {
                continue;
            }
            let branch_lower = branch.to_lowercase();
            if ignored_prefixes
                .iter()
                .any(|prefix| branch_lower.starts_with(&prefix.to_lowercase()))
            {
                continue;
            }
            // Protected branches are long-lived by design (release trains, staging…).
            if !node["branchProtectionRule"].is_null() {
                continue;
            }

            let author_login = commit["author"]["user"]["login"]
                .as_str()
                .unwrap_or("")
                .to_string();

            stale.push(StaleBranch {
                repo: repo.to_string(),
                branch: branch.clone(),
                url: format!("{repo_url}/tree/{branch}"),
                last_commit_at: committed_at.to_rfc3339(),
                last_commit_message: commit["messageHeadline"].as_str().unwrap_or("").to_string(),
                last_commit_sha: commit["oid"].as_str().unwrap_or("").to_string(),
                is_mine: !author_login.is_empty()
                    && author_login.eq_ignore_ascii_case(viewer_login),
                author_type: classify_branch_author(&author_login, settings),
                author_login,
                author_name: commit["author"]["name"].as_str().unwrap_or("").to_string(),
                author_avatar_url: commit["author"]["user"]["avatarUrl"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                age_days: (now - committed_at).num_days().max(0) as u32,
            });
        }

        if reached_recent || connection["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
            break;
        }
        cursor = connection["pageInfo"]["endCursor"].as_str().map(String::from);
        if cursor.is_none() {
            break;
        }
    }

    Ok(stale)
}

/// Remote branches with no open PR whose last commit predates `stale_days`.
/// Repos that fail are reported as warnings rather than failing the whole scan.
pub async fn fetch_stale_branches(
    repos: &[String],
    stale_days: u32,
    ignored_prefixes: &[String],
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<StaleBranchesResult, ApiError> {
    let viewer_login = fetch_viewer_login(settings, client).await?;
    let cutoff = chrono::Utc::now() - chrono::Duration::days(stale_days as i64);

    let results = futures::future::join_all(repos.iter().map(|repo| {
        let viewer_login = viewer_login.as_str();
        async move {
            (
                repo.clone(),
                fetch_repo_stale_branches(
                    repo,
                    cutoff,
                    ignored_prefixes,
                    viewer_login,
                    settings,
                    client,
                )
                .await,
            )
        }
    }))
    .await;

    let mut branches = Vec::new();
    let mut warnings = Vec::new();

    for (repo, result) in results {
        match result {
            Ok(found) => branches.extend(found),
            Err(error) => warnings.push(format!("{repo}: {error}")),
        }
    }

    // Ascending by last commit — the most obvious deletion candidates lead the list.
    branches.sort_by(|a, b| a.last_commit_at.cmp(&b.last_commit_at));

    Ok(StaleBranchesResult {
        branches,
        viewer_login,
        warnings,
        stale_days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_number_in_message_follows_squash_and_merge_commits() {
        assert_eq!(pr_number_in_message("PENT-12 Fix login (#345)"), Some(345));
        assert_eq!(
            pr_number_in_message("Merge pull request #78 from org/PENT-9-feature\n\nPENT-9 Feature"),
            Some(78)
        );
        assert_eq!(
            pr_number_in_message("PENT-12 Fix login (#345)\n\n(cherry picked from commit abc123)"),
            Some(345)
        );
        assert_eq!(pr_number_in_message("PENT-12 Fix login"), None);
    }

    #[test]
    fn mainline_keeps_default_branch_prs_and_reachable_tags_oldest_first() {
        let data = serde_json::json!({
            "r_0": {
                "defaultBranchRef": {
                    "name": "main",
                    "target": { "history": { "nodes": [{ "oid": "c2" }, { "oid": "c1" }] } }
                },
                "refs": { "nodes": [
                    { "name": "v1.1.0-beta.2", "target": { "oid": "c2", "committedDate": "2026-05-02T10:00:00Z" } },
                    { "name": "v1.0.1", "target": { "oid": "rel", "committedDate": "2026-05-03T10:00:00Z" } },
                    { "name": "v1.1.0-beta.1", "target": {
                        "oid": "tagobj",
                        "tagger": { "date": "2026-05-09T10:00:00Z" },
                        "target": { "oid": "c1", "committedDate": "2026-05-01T10:00:00Z" }
                    } }
                ] },
                "pullRequests": { "nodes": [
                    { "number": 9, "title": "PENT-9 Later", "body": "", "headRefName": "x", "baseRefName": "main", "mergedAt": "2026-05-04T10:00:00Z", "url": "u9" },
                    { "number": 8, "title": "Hotfix", "body": "", "headRefName": "PENT-8-fix", "baseRefName": "release/1.0", "mergedAt": "2026-05-03T09:00:00Z", "url": "u8" },
                    { "number": 7, "title": "Earlier", "body": "", "headRefName": "feature/PENT-7", "baseRefName": "main", "mergedAt": "2026-05-01T09:00:00Z", "url": "u7" }
                ] }
            }
        });

        let mainline = parse_mainline(&data, 1);

        assert_eq!(mainline.branch, "main");
        let numbers: Vec<u64> = mainline.commits.iter().map(|c| c.number).collect();
        assert_eq!(numbers, vec![7, 9]);
        assert_eq!(mainline.commits[0].jira_keys, vec!["PENT-7".to_string()]);
        let tags: Vec<(&str, &str)> = mainline.tags.iter().map(|t| (t.name.as_str(), t.date.as_str())).collect();
        assert_eq!(tags, vec![
            ("v1.1.0-beta.1", "2026-05-01T10:00:00Z"),
            ("v1.1.0-beta.2", "2026-05-02T10:00:00Z"),
        ]);
    }

    #[test]
    fn graphql_string_escapes_quotes_and_backslashes() {
        assert_eq!(graphql_string(r#"release/"x"\y"#), r#""release/\"x\"\\y""#);
    }

    #[test]
    fn github_says_why_it_refused() {
        assert_eq!(
            github_error(r#"{"message":"Unprocessable Entity","errors":["Review Can not request changes on your own pull request"]}"#),
            "Review Can not request changes on your own pull request"
        );
        assert_eq!(
            github_error(r#"{"message":"Validation Failed","errors":[{"message":"line must be part of the diff"}]}"#),
            "line must be part of the diff"
        );
        assert_eq!(github_error(r#"{"message":"Not Found"}"#), "Not Found");
        assert_eq!(github_error("Bad gateway"), "Bad gateway");
    }

    #[test]
    fn review_threads_keep_where_github_placed_them() {
        let thread = parse_review_thread(&serde_json::json!({
            "id": "PRRT_1", "path": "src/a.ts",
            "line": null, "startLine": null, "originalLine": 14, "originalStartLine": 12,
            "diffSide": "LEFT", "isResolved": true, "isOutdated": true,
            "resolvedBy": { "login": "anna" },
            "comments": {
                "totalCount": 3,
                "nodes": [
                    {
                        "author": { "login": "anna", "avatarUrl": "https://avatars.githubusercontent.com/u/1" },
                        "body": "Why?", "createdAt": "2026-10-01T10:00:00Z", "url": "https://github.com/o/r/pull/1#discussion_r1",
                        "diffHunk": "@@ -10,5 +10,5 @@\n a\n-b", "state": "SUBMITTED",
                        "isMinimized": false, "minimizedReason": null, "originalCommit": { "oid": "abc123" }
                    },
                    {
                        "author": null, "body": "Spam", "createdAt": "2026-10-02T10:00:00Z", "url": "u2",
                        "diffHunk": "", "state": "PENDING", "isMinimized": true, "minimizedReason": "SPAM",
                        "originalCommit": { "oid": "abc123" }
                    }
                ]
            }
        }));
        assert_eq!((thread.line, thread.original_line, thread.original_start_line), (None, Some(14), Some(12)));
        assert_eq!((thread.side.as_str(), thread.outdated, thread.resolved), ("old", true, true));
        assert_eq!(thread.resolved_by.as_deref(), Some("anna"));
        assert_eq!((thread.original_commit.as_str(), thread.diff_hunk.as_str()), ("abc123", "@@ -10,5 +10,5 @@\n a\n-b"));
        assert_eq!(thread.more_comments, 1);
        assert_eq!(thread.comments[1].author, "ghost");
        assert!(thread.comments[1].pending);
        assert_eq!(thread.comments[1].minimized.as_deref(), Some("spam"));
        assert_eq!(thread.comments[0].minimized, None);
    }
}
