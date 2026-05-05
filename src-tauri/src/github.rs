use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;

use crate::models::{AppSettings, PipelineState};

// ── GitHub API response types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GithubPullRequest {
    number: u64,
    title: String,
    body: Option<String>,
    created_at: String,
    draft: bool,
    updated_at: String,
    requested_reviewers: Vec<GithubUser>,
    assignees: Vec<GithubUser>,
    user: GithubUser,
    head: GithubHead,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubHead {
    sha: String,
    #[serde(rename = "ref")]
    ref_name: String,
}

#[derive(Debug, Deserialize)]
struct GithubViewer {
    login: String,
}

#[derive(Debug, Deserialize)]
struct GithubReview {
    state: String,
    user: Option<GithubUser>,
    submitted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubCombinedStatus {
    state: String,
}

#[derive(Debug, Deserialize)]
struct GithubCheckRunsResponse {
    check_runs: Vec<GithubCheckRun>,
}

#[derive(Debug, Deserialize, Clone)]
struct GithubCheckRun {
    id: Option<u64>,
    name: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    status: String,
    conclusion: Option<String>,
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
}

#[derive(Debug, Clone)]
pub struct CachedPrDetails {
    pub updated_at: String,
    pub head_sha: String,
    pub participant_avatars: HashMap<String, String>,
    pub pipeline_state: PipelineState,
    pub review_summary: GithubReviewSummary,
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

// ── Public API ────────────────────────────────────────────────────────────────

pub async fn fetch_viewer_login(
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<String, String> {
    let base = settings.github_api_base_url.trim_end_matches('/');
    let viewer: GithubViewer = github_request(&format!("{}/user", base), settings, client).await?;
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

// ── Per-repo fetch ────────────────────────────────────────────────────────────

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
    let base = settings.github_api_base_url.trim_end_matches('/');
    let url = format!(
        "{}/repos/{}/pulls?state=open&per_page=50&sort=updated&direction=desc",
        base, repo
    );

    let pulls: Vec<GithubPullRequest> = github_request(&url, settings, client).await?;

    let active_keys: std::collections::HashSet<String> = pulls
        .iter()
        .map(|pr| format!("{}#{}", repo, pr.number))
        .collect();

    // Fetch all PR details in parallel, using cache where possible.
    let detail_futures = pulls.iter().map(|pr| {
        let cache_key = format!("{}#{}", repo, pr.number);
        let cached = pr_cache.lock().unwrap().get(&cache_key).cloned();
        async move {
            if let Some(c) = cached {
                if c.updated_at == pr.updated_at && c.head_sha == pr.head.sha {
                    return Ok((cache_key, c, pr));
                }
            }
            let d = fetch_pr_details(repo, pr, base, settings, client).await?;
            Ok::<_, String>((cache_key, d, pr))
        }
    });

    let results: Vec<Result<_, String>> = futures::future::join_all(detail_futures).await;

    let mut records = Vec::new();
    for result in results {
        let (cache_key, details, pr) = result?;
        pr_cache.lock().unwrap().insert(cache_key, details.clone());
        records.push(GithubPullRequestRecord {
            repo: repo.to_string(),
            number: pr.number,
            title: pr.title.clone(),
            url: format!("https://github.com/{}/pull/{}", repo, pr.number),
            body: pr.body.clone().unwrap_or_default(),
            created_at: pr.created_at.clone(),
            author: pr.user.login.clone(),
            assignee: pr.assignees.first().map(|u| u.login.clone()),
            requested_reviewers: pr
                .requested_reviewers
                .iter()
                .map(|u| u.login.clone())
                .collect(),
            participant_avatars: details.participant_avatars,
            head_ref: pr.head.ref_name.clone(),
            updated_at: pr.updated_at.clone(),
            draft: pr.draft,
            pipeline_state: details.pipeline_state,
            review_summary: details.review_summary,
        });
    }

    // Evict stale cache entries for this repo.
    pr_cache
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(&format!("{}#", repo)) || active_keys.contains(k));

    Ok(records)
}

async fn fetch_pr_details(
    repo: &str,
    pr: &GithubPullRequest,
    base: &str,
    settings: &AppSettings,
    client: &reqwest::Client,
) -> Result<CachedPrDetails, String> {
    let url_reviews = format!(
        "{}/repos/{}/pulls/{}/reviews?per_page=100",
        base, repo, pr.number
    );
    let url_status = format!("{}/repos/{}/commits/{}/status", base, repo, pr.head.sha);
    let url_checks = format!(
        "{}/repos/{}/commits/{}/check-runs?per_page=100",
        base, repo, pr.head.sha
    );

    let (reviews, combined_status, check_runs_resp) = tokio::try_join!(
        github_request::<Vec<GithubReview>>(&url_reviews, settings, client),
        github_request::<GithubCombinedStatus>(&url_status, settings, client),
        github_request::<GithubCheckRunsResponse>(&url_checks, settings, client),
    )?;

    let mut avatars: HashMap<String, String> = HashMap::new();
    add_avatar(&mut avatars, &pr.user);
    if let Some(assignee) = pr.assignees.first() {
        add_avatar(&mut avatars, assignee);
    }
    for reviewer in &pr.requested_reviewers {
        add_avatar(&mut avatars, reviewer);
    }
    for review in &reviews {
        if let Some(user) = &review.user {
            add_avatar(&mut avatars, user);
        }
    }

    let requested_logins: Vec<String> = pr
        .requested_reviewers
        .iter()
        .map(|r| r.login.clone())
        .collect();
    let review_summary = summarize_reviews(&reviews, &requested_logins);
    let pipeline_state = summarize_pipeline_state(&combined_status, &check_runs_resp.check_runs);

    Ok(CachedPrDetails {
        updated_at: pr.updated_at.clone(),
        head_sha: pr.head.sha.clone(),
        participant_avatars: avatars,
        pipeline_state,
        review_summary,
    })
}

// ── Review summary ────────────────────────────────────────────────────────────

fn summarize_reviews(
    reviews: &[GithubReview],
    requested_reviewers: &[String],
) -> GithubReviewSummary {
    let mut latest: HashMap<String, &GithubReview> = HashMap::new();

    for review in reviews {
        let login = match &review.user {
            Some(u) => &u.login,
            None => continue,
        };
        match latest.get(login.as_str()) {
            None => {
                latest.insert(login.clone(), review);
            }
            Some(current) => {
                let current_ts = parse_ts(current.submitted_at.as_deref());
                let next_ts = parse_ts(review.submitted_at.as_deref());
                if next_ts >= current_ts {
                    latest.insert(login.clone(), review);
                }
            }
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

fn summarize_pipeline_state(
    combined: &GithubCombinedStatus,
    check_runs: &[GithubCheckRun],
) -> PipelineState {
    let latest = keep_latest_per_check(check_runs);

    let has_failed = latest.iter().any(|cr| {
        cr.status == "completed"
            && matches!(
                cr.conclusion.as_deref(),
                Some("failure" | "timed_out" | "action_required" | "startup_failure")
            )
    });
    if has_failed {
        return PipelineState::Failure;
    }

    if matches!(combined.state.as_str(), "failure" | "error") {
        return PipelineState::Failure;
    }

    let has_action_required = latest
        .iter()
        .any(|cr| cr.status == "completed" && cr.conclusion.as_deref() == Some("action_required"));

    let all_completed = !latest.is_empty() && latest.iter().all(|cr| cr.status == "completed");
    if all_completed && !has_action_required {
        return PipelineState::Success;
    }

    if combined.state == "success" && !has_action_required {
        return PipelineState::Success;
    }

    let has_pending = latest.iter().any(|cr| {
        matches!(
            cr.status.as_str(),
            "queued" | "in_progress" | "waiting" | "requested" | "pending"
        )
    });
    if combined.state == "pending" || has_pending {
        return PipelineState::Pending;
    }

    if has_action_required {
        return PipelineState::ActionRequired;
    }

    PipelineState::Unknown
}

fn keep_latest_per_check(check_runs: &[GithubCheckRun]) -> Vec<GithubCheckRun> {
    let mut latest: HashMap<String, GithubCheckRun> = HashMap::new();

    for cr in check_runs {
        let key = cr
            .name
            .as_deref()
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| {
                format!(
                    "__unnamed__:{}:{}:{}",
                    cr.id.map(|i| i.to_string()).unwrap_or_default(),
                    cr.started_at.as_deref().unwrap_or("no-start"),
                    cr.completed_at.as_deref().unwrap_or("no-end"),
                )
            });

        let should_replace = match latest.get(&key) {
            None => true,
            Some(current) => {
                let cur_ts = cr_timestamp(current);
                let cand_ts = cr_timestamp(cr);
                if cand_ts != cur_ts {
                    cand_ts > cur_ts
                } else {
                    cr.id.unwrap_or(0) > current.id.unwrap_or(0)
                }
            }
        };

        if should_replace {
            latest.insert(key, cr.clone());
        }
    }

    latest.into_values().collect()
}

fn cr_timestamp(cr: &GithubCheckRun) -> i64 {
    cr.completed_at
        .as_deref()
        .or(cr.started_at.as_deref())
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(i64::MIN)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn add_avatar(map: &mut HashMap<String, String>, user: &GithubUser) {
    if let Some(url) = &user.avatar_url {
        if !url.is_empty() {
            map.insert(user.login.clone(), url.clone());
        }
    }
}
