use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

use crate::models::{AppSettings, PipelineState};

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
    pub draft: bool,
    pub pipeline_state: PipelineState,
    pub review_summary: GithubReviewSummary,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone)]
pub struct CachedPrDetails {
    pub updated_at: String,
    pub head_sha: String,
    pub participant_avatars: HashMap<String, String>,
    pub pipeline_state: PipelineState,
    pub review_summary: GithubReviewSummary,
    pub additions: u32,
    pub deletions: u32,
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
    pr_cache: &Mutex<HashMap<String, CachedPrDetails>>,
    client: &reqwest::Client,
) -> Vec<GithubRepoFetchResult> {
    let futures = settings
        .github_repos
        .iter()
        .map(|repo| fetch_repo_pull_requests(repo, settings, pr_cache, client));
    futures::future::join_all(futures).await
}

// ── Per-repo GraphQL fetch ────────────────────────────────────────────────────

async fn fetch_repo_pull_requests(
    repo: &str,
    settings: &AppSettings,
    pr_cache: &Mutex<HashMap<String, CachedPrDetails>>,
    client: &reqwest::Client,
) -> GithubRepoFetchResult {
    match fetch_repo_pull_requests_inner(repo, settings, pr_cache, client).await {
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
    pr_cache: &Mutex<HashMap<String, CachedPrDetails>>,
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

    let active_keys: std::collections::HashSet<String> = all_prs
        .iter()
        .map(|pr| format!("{}#{}", repo, pr.number))
        .collect();

    let mut records = Vec::new();
    for pr in &all_prs {
        let cache_key = format!("{}#{}", repo, pr.number);
        let head_sha = pr
            .head_ref
            .as_ref()
            .and_then(|h| h.target.as_ref())
            .map(|t| t.oid.clone())
            .unwrap_or_default();

        // Reuse processed details if the PR hasn't changed since last refresh.
        let cached = pr_cache.lock().unwrap().get(&cache_key).cloned();
        let details = match cached {
            Some(c) if c.updated_at == pr.updated_at && c.head_sha == head_sha => c,
            _ => build_cached_details(pr, &head_sha),
        };

        pr_cache
            .lock()
            .unwrap()
            .insert(cache_key, details.clone());

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
            draft: pr.is_draft,
            pipeline_state: details.pipeline_state.clone(),
            review_summary: details.review_summary.clone(),
            additions: details.additions,
            deletions: details.deletions,
        });
    }

    // Evict stale cache entries (closed / merged PRs) for this repo.
    pr_cache
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(&format!("{}#", repo)) || active_keys.contains(k));

    Ok(records)
}

// ── Build processed details from a GraphQL PR node ────────────────────────────

fn build_cached_details(pr: &GqlPr, head_sha: &str) -> CachedPrDetails {
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

    CachedPrDetails {
        updated_at: pr.updated_at.clone(),
        head_sha: head_sha.to_string(),
        participant_avatars: avatars,
        pipeline_state,
        review_summary,
        additions: pr.additions,
        deletions: pr.deletions,
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
            "CHANGES_REQUESTED" => {
                if !requested_reviewers.contains(login) {
                    blocking_reviewers.push(login.clone());
                }
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
