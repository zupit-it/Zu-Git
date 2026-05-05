use std::collections::HashMap;
use std::sync::Mutex;

use crate::github::{CachedPrDetails, GithubPullRequestRecord, GithubReviewSummary};
use crate::jira::JiraIssueSummary;
use crate::models::{
    mock_pull_requests, settings_ready_for_github, settings_ready_for_jira, AppSettings,
    AuthorType, DashboardSnapshot, IntegrationStatus, MatchStrategy, PipelineState, Priority,
    PullRequestSummary, RepoSyncStatus, ReviewActor, ReviewState, TokenStoreStatus,
};

fn placeholder_token_store() -> TokenStoreStatus {
    TokenStoreStatus {
        provider: String::new(),
        provider_detail: String::new(),
        provider_ok: false,
        github_token_present: false,
        jira_token_present: false,
        last_save_used_vault: None,
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

pub async fn build_dashboard_snapshot(
    settings: &AppSettings,
    pr_cache: &Mutex<HashMap<String, CachedPrDetails>>,
    jira_cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
) -> DashboardSnapshot {
    let now = chrono::Utc::now().to_rfc3339();
    let mut warnings: Vec<String> = vec![];
    let repo_syncs: Vec<RepoSyncStatus> = vec![];

    let mut integrations = vec![
        IntegrationStatus {
            name: "github".to_string(),
            configured: settings_ready_for_github(settings),
            ok: false,
            detail: if settings_ready_for_github(settings) {
                "Waiting for GitHub sync.".to_string()
            } else {
                "Missing token or repositories.".to_string()
            },
        },
        IntegrationStatus {
            name: "jira".to_string(),
            configured: settings_ready_for_jira(settings),
            ok: false,
            detail: if settings_ready_for_jira(settings) {
                "Waiting for Jira enrichment.".to_string()
            } else {
                "Not configured yet.".to_string()
            },
        },
    ];

    if !settings_ready_for_github(settings) {
        warnings.push(
            "Configure GitHub token and at least one repo to load live pull requests.".to_string(),
        );
        integrations[0].detail =
            "Add a GitHub token and at least one repo, then save again.".to_string();
        return DashboardSnapshot {
            prs: sort_pull_requests(mock_pull_requests()),
            viewer_login: None,
            warnings,
            source: "mock".to_string(),
            refreshed_at: now,
            integrations,
            repo_syncs,
            token_store: placeholder_token_store(),
        };
    }

    match fetch_live(
        settings,
        pr_cache,
        jira_cache,
        client,
        &mut integrations,
        &mut warnings,
    )
    .await
    {
        Ok(snapshot) => snapshot,
        Err(err) => {
            warnings.push(err);
            warnings
                .push("Showing mock data while the live integration is unavailable.".to_string());
            integrations[0].ok = false;
            DashboardSnapshot {
                prs: sort_pull_requests(mock_pull_requests()),
                viewer_login: None,
                warnings,
                source: "mock".to_string(),
                refreshed_at: now,
                integrations,
                repo_syncs: vec![],
                token_store: placeholder_token_store(),
            }
        }
    }
}

// ── Live fetch ────────────────────────────────────────────────────────────────

async fn fetch_live(
    settings: &AppSettings,
    pr_cache: &Mutex<HashMap<String, CachedPrDetails>>,
    jira_cache: &Mutex<HashMap<String, Option<JiraIssueSummary>>>,
    client: &reqwest::Client,
    integrations: &mut Vec<IntegrationStatus>,
    warnings: &mut Vec<String>,
) -> Result<DashboardSnapshot, String> {
    let now = chrono::Utc::now().to_rfc3339();

    let viewer_login = crate::github::fetch_viewer_login(settings, client).await?;
    let repo_results = crate::github::fetch_open_pull_requests(settings, pr_cache, client).await;

    let mut repo_syncs = vec![];
    let mut all_prs: Vec<GithubPullRequestRecord> = vec![];
    let mut failed_count = 0usize;

    for result in &repo_results {
        if result.ok {
            let detail = if result.pull_requests.is_empty() {
                "Sync ok, no open PRs in this repo.".to_string()
            } else {
                format!("{} open PRs loaded.", result.pull_requests.len())
            };
            repo_syncs.push(RepoSyncStatus {
                repo: result.repo.clone(),
                ok: true,
                pr_count: result.pull_requests.len(),
                detail,
            });
            all_prs.extend(result.pull_requests.clone());
        } else {
            failed_count += 1;
            let error = result
                .error
                .clone()
                .unwrap_or_else(|| "Unknown error.".to_string());
            repo_syncs.push(RepoSyncStatus {
                repo: result.repo.clone(),
                ok: false,
                pr_count: 0,
                detail: error.clone(),
            });
            warnings.push(format!("{}: {}", result.repo, error));
        }
    }

    if failed_count > 0 {
        warnings.push(format!(
            "{} configured repos could not be loaded from GitHub.",
            failed_count
        ));
    }

    // ── Normalise + enrich ────────────────────────────────────────────────────

    let jira_enabled = settings_ready_for_jira(settings);

    let normalised: Vec<NormalisedPr> = all_prs
        .iter()
        .map(|pr| normalise_pr(pr, settings, warnings))
        .collect();

    let jira_keys: Vec<String> = normalised
        .iter()
        .filter_map(|n| n.jira_key.clone())
        .collect();

    let jira_issues = if jira_enabled {
        crate::jira::fetch_jira_issues(&jira_keys, settings, jira_cache, client).await
    } else {
        HashMap::new()
    };

    let enriched: Vec<PullRequestSummary> = normalised
        .iter()
        .map(|n| enrich(n, &jira_issues, settings))
        .collect();

    if !jira_enabled {
        warnings.push(
            "Jira is not configured yet, so release and priority are placeholders.".to_string(),
        );
        integrations[1].detail =
            "GitHub data is live, Jira enrichment is using placeholders.".to_string();
    } else {
        let linked = enriched
            .iter()
            .filter(|pr| pr.jira_key != "No ticket")
            .count();
        integrations[1].ok = true;
        integrations[1].detail = format!(
            "Jira enrichment active for linked tickets. {} PRs include a Jira key. {} repo-to-board mappings configured.",
            linked,
            settings.jira_repo_boards.len()
        );
    }

    integrations[0].ok = failed_count == 0;
    integrations[0].detail = if failed_count == 0 {
        format!(
            "GitHub sync completed. {} open PRs loaded from {} repos.",
            all_prs.len(),
            settings.github_repos.len()
        )
    } else {
        format!(
            "GitHub sync partially completed. {} open PRs loaded, but {} repos failed.",
            all_prs.len(),
            failed_count
        )
    };

    Ok(DashboardSnapshot {
        prs: sort_pull_requests(enriched),
        viewer_login: Some(viewer_login),
        warnings: warnings.clone(),
        source: "live".to_string(),
        refreshed_at: now,
        integrations: integrations.clone(),
        repo_syncs,
        token_store: placeholder_token_store(), // overwritten in commands.rs
    })
}

// ── Per-PR normalisation ──────────────────────────────────────────────────────

struct NormalisedPr<'a> {
    pr: &'a GithubPullRequestRecord,
    author_type: AuthorType,
    jira_board: Option<String>,
    jira_key: Option<String>,
    match_strategy: MatchStrategy,
    pending_reviewers: Vec<String>,
    current_reviewer: String,
    previous_approver: Option<String>,
}

fn normalise_pr<'a>(
    pr: &'a GithubPullRequestRecord,
    settings: &AppSettings,
    warnings: &mut Vec<String>,
) -> NormalisedPr<'a> {
    let jira_board = settings.jira_repo_boards.get(&pr.repo).cloned();

    let collaborator_override = settings.collaborator_github_users.contains(&pr.author);
    let marker_match = !settings.internal_author_marker.is_empty()
        && pr
            .author
            .to_lowercase()
            .contains(&settings.internal_author_marker.to_lowercase());

    let author_type = if collaborator_override || !marker_match {
        AuthorType::Collaborator
    } else {
        AuthorType::Internal
    };

    let title_match = crate::jira::extract_jira_key_from_title(&pr.title, jira_board.as_deref());
    let fallback_key = if author_type == AuthorType::Internal && title_match.key.is_none() {
        let text = format!("{}\n{}\n{}", pr.title, pr.body, pr.head_ref);
        crate::jira::extract_jira_key(&text)
    } else {
        None
    };

    let (jira_key, match_strategy) = match title_match.key {
        Some(k) => (Some(k), title_match.strategy),
        None => match fallback_key {
            Some(k) => (Some(k), MatchStrategy::FallbackText),
            None => (None, MatchStrategy::None),
        },
    };

    if author_type == AuthorType::Internal && jira_key.is_none() {
        warnings.push(format!(
            "{}#{}: internal PR without Jira key in the expected title pattern.",
            pr.repo, pr.number
        ));
    }

    let rs = &pr.review_summary;
    let pending_reviewers: Vec<String> = pr
        .requested_reviewers
        .iter()
        .filter(|login| {
            !rs.current_approvers.contains(login)
                && !rs.stale_approvers.contains(login)
                && !rs.blocking_reviewers.contains(login)
                && !rs.commented_reviewers.contains(login)
        })
        .cloned()
        .collect();

    let current_reviewer = pending_reviewers
        .first()
        .or(rs.current_approvers.first())
        .or(rs.stale_approvers.first())
        .or(pr.assignee.as_ref())
        .cloned()
        .unwrap_or_else(|| "Unassigned".to_string());

    let previous_approver = rs.stale_approvers.first().cloned();

    NormalisedPr {
        pr,
        author_type,
        jira_board,
        jira_key,
        match_strategy,
        pending_reviewers,
        current_reviewer,
        previous_approver,
    }
}

// ── Enrichment ────────────────────────────────────────────────────────────────

fn enrich(
    n: &NormalisedPr,
    jira_issues: &HashMap<String, Option<JiraIssueSummary>>,
    settings: &AppSettings,
) -> PullRequestSummary {
    let pr = n.pr;
    let issue = n
        .jira_key
        .as_ref()
        .and_then(|k| jira_issues.get(k))
        .and_then(|v| v.as_ref());

    let effective_key = issue
        .map(|i| i.key.as_str())
        .or(n.jira_key.as_deref())
        .unwrap_or("No ticket")
        .to_string();

    let jira_url = n
        .jira_key
        .as_ref()
        .map(|_| format!("{}/browse/{}", settings.jira_base_url, effective_key));

    let rs = &pr.review_summary;

    PullRequestSummary {
        id: pr.number,
        repo: pr.repo.clone(),
        title: pr.title.clone(),
        url: pr.url.clone(),
        jira_url,
        is_draft: pr.draft,
        created_at_iso: pr.created_at.clone(),
        author_type: n.author_type.clone(),
        jira_board: n.jira_board.clone(),
        match_strategy: n.match_strategy.clone(),
        jira_key: effective_key,
        jira_summary: issue
            .map(|i| i.summary.clone())
            .unwrap_or_else(|| "No linked Jira issue found".to_string()),
        jira_priority: map_priority(issue.map(|i| i.priority.as_str()).unwrap_or("Medium")),
        jira_release: issue
            .map(|i| i.release.clone())
            .unwrap_or_else(|| "Unscheduled".to_string()),
        jira_release_date: issue
            .and_then(|i| i.release_date.clone())
            .and_then(|d| format_release_date(&d)),
        jira_status: issue
            .map(|i| i.status.clone())
            .unwrap_or_else(|| "Unknown".to_string()),
        author: pr.author.clone(),
        author_avatar_url: pr.participant_avatars.get(&pr.author).cloned(),
        assignee: pr
            .assignee
            .clone()
            .or_else(|| issue.and_then(|i| i.assignee.clone()))
            .unwrap_or_else(|| "Unassigned".to_string()),
        assignee_avatar_url: pr
            .assignee
            .as_ref()
            .and_then(|a| pr.participant_avatars.get(a))
            .cloned(),
        current_reviewer: n.current_reviewer.clone(),
        current_reviewer_avatar_url: pr.participant_avatars.get(&n.current_reviewer).cloned(),
        previous_approver: n.previous_approver.clone(),
        previous_approver_avatar_url: n
            .previous_approver
            .as_ref()
            .and_then(|p| pr.participant_avatars.get(p))
            .cloned(),
        pending_reviewers: build_actors(&n.pending_reviewers, &pr.participant_avatars),
        current_approvers: build_actors(&rs.current_approvers, &pr.participant_avatars),
        stale_approvers: build_actors(&rs.stale_approvers, &pr.participant_avatars),
        blocking_reviewers: build_actors(&rs.blocking_reviewers, &pr.participant_avatars),
        commented_reviewers: build_actors(&rs.commented_reviewers, &pr.participant_avatars),
        review_state: choose_review_state(rs),
        has_stale_approval: !rs.stale_approvers.is_empty(),
        updated_at: relative_date(&pr.updated_at),
        pipeline_state: pr.pipeline_state.clone(),
        has_failed_pipeline: pr.pipeline_state == PipelineState::Failure,
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn build_actors(logins: &[String], avatars: &HashMap<String, String>) -> Vec<ReviewActor> {
    logins
        .iter()
        .map(|login| ReviewActor {
            login: login.clone(),
            avatar_url: avatars.get(login).cloned(),
        })
        .collect()
}

fn choose_review_state(rs: &GithubReviewSummary) -> ReviewState {
    if !rs.blocking_reviewers.is_empty() {
        return ReviewState::ChangesRequested;
    }
    if !rs.current_approvers.is_empty() {
        return ReviewState::Approved;
    }
    if !rs.stale_approvers.is_empty() {
        return ReviewState::ApprovedStale;
    }
    ReviewState::NeedsReview
}

fn map_priority(priority: &str) -> Priority {
    match priority.to_lowercase().as_str() {
        "highest" | "blocker" | "altissima" => Priority::Highest,
        "high" | "alta" => Priority::High,
        "low" | "lowest" | "bassa" | "bassissima" => Priority::Low,
        _ => Priority::Medium,
    }
}

fn priority_weight(p: &Priority) -> u8 {
    match p {
        Priority::Highest => 0,
        Priority::High => 1,
        Priority::Medium => 2,
        Priority::Low => 3,
    }
}

fn sort_pull_requests(mut prs: Vec<PullRequestSummary>) -> Vec<PullRequestSummary> {
    prs.sort_by(|a, b| {
        let stale = b.has_stale_approval.cmp(&a.has_stale_approval);
        if stale != std::cmp::Ordering::Equal {
            return stale;
        }
        priority_weight(&a.jira_priority).cmp(&priority_weight(&b.jira_priority))
    });
    prs
}

fn relative_date(iso: &str) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc));

    let Some(parsed) = parsed else {
        return iso.to_string();
    };

    let minutes = chrono::Utc::now()
        .signed_duration_since(parsed)
        .num_minutes()
        .max(0) as u64;

    if minutes < 1 {
        return "just now".to_string();
    }
    if minutes < 60 {
        return format!("{} min ago", minutes);
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{} h ago", hours);
    }
    format!("{} d ago", hours / 24)
}

fn format_release_date(iso_date: &str) -> Option<String> {
    use chrono::Datelike;
    let date = chrono::NaiveDate::parse_from_str(iso_date, "%Y-%m-%d").ok()?;
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    Some(format!(
        "{} {}, {}",
        months[(date.month0()) as usize],
        date.day(),
        date.year()
    ))
}
