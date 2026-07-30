import { invoke } from "@tauri-apps/api/core";
import type { DashboardSnapshot } from "./shared/rpc";
import type { PullRequestSummary } from "./shared/pr-model";
import { state } from "./state";
import { errorMessage } from "./utils";
import { applyListFilters, byPriorityRank } from "./filters";
import { renderListBoard, setStatus, notifyQueueRebaseTriggered, notifyQueueConflictBlocked } from "./render";

function prKey(pr: PullRequestSummary): string {
  return `${pr.repo}/${pr.id}`;
}

function groupKey(pr: PullRequestSummary): string {
  return `${pr.repo}::${pr.baseRef}`;
}

/**
 * The nearest (soonest-shipping) scheduled release among a group of PRs, by
 * `jiraReleaseDate` — or `null` if none of them have a dated fix version.
 * `jiraRelease` is already each PR's own most-imminent fix version, so taking
 * the minimum date across the group and reading off its release name is
 * enough; no need to look at the full `jiraReleases` list.
 */
function findNearestRelease(prs: PullRequestSummary[]): string | null {
  let nearest: { name: string; time: number } | null = null;
  for (const pr of prs) {
    if (!pr.jiraRelease || !pr.jiraReleaseDate) continue;
    const time = Date.parse(pr.jiraReleaseDate);
    if (Number.isNaN(time)) continue;
    if (!nearest || time < nearest.time) nearest = { name: pr.jiraRelease, time };
  }
  return nearest?.name ?? null;
}

// ── Automation: keep the head of each auto-merge-enabled queue unblocked ──────
//
// There is no manual ordering here — the queue order is simply Jira priority
// (the same order already shown in the list), scoped to each repo+base-branch
// group's nearest scheduled release. Every ZuGit client fetches the same Jira
// data independently, so the order is naturally shared across the team with
// no storage or sync mechanism of our own.

export async function processMergeQueue(snapshot: DashboardSnapshot) {
  // A successful rebase force-pushes the PR's branch, which bumps its own
  // updatedAtIso — so that field can't be used to detect "still waiting for
  // GitHub to catch up" (it changes precisely because of the action we're
  // trying to dedupe). Instead, only drop the "already triggered" flag once
  // the PR is confirmed to no longer be behind — merged, closed, rebased
  // successfully, or newly conflicting all count. While it's still reported
  // as behind, keep suppressing re-triggers.
  for (const key of state.queueRebaseTriggeredFor) {
    const pr = snapshot.prs.find((p) => prKey(p) === key);
    if (!pr || pr.mergeStatus !== "behind") state.queueRebaseTriggeredFor.delete(key);
  }

  const groups = new Map<string, PullRequestSummary[]>();
  for (const pr of snapshot.prs) {
    if (pr.isDraft) continue;
    const key = groupKey(pr);
    const group = groups.get(key);
    if (group) group.push(pr);
    else groups.set(key, [pr]);
  }

  const blocked = new Set<string>();
  const rebaseTargets: PullRequestSummary[] = [];

  for (const group of groups.values()) {
    const nearestRelease = findNearestRelease(group);
    if (!nearestRelease) continue; // nothing scheduled in this repo+branch — out of scope

    // First PR targeting that release, in Jira-priority order, that already
    // has auto-merge on — PRs above it without auto-merge yet are simply out
    // of the automation's scope.
    const candidate = group
      .filter((pr) => pr.jiraRelease === nearestRelease)
      .sort(byPriorityRank)
      .find((pr) => pr.autoMergeMethod !== null);
    if (!candidate) continue;

    if (candidate.mergeStatus === "conflicting") {
      blocked.add(prKey(candidate));
      void maybeNotifyConflict(candidate);
    } else if (candidate.mergeStatus === "behind") {
      rebaseTargets.push(candidate);
    }
    // "clean" / "blocked" / "unknown" → nothing to do this refresh.
  }

  state.queueBlockedPrKeys = blocked;
  if (state.currentDashboard === snapshot) renderListBoard(applyListFilters(snapshot));

  await Promise.allSettled(rebaseTargets.map(triggerRebase));
}

async function maybeNotifyConflict(pr: PullRequestSummary) {
  if (!state.notificationsEnabled) return;
  const key = prKey(pr);
  if (state.queueConflictNotifiedFor.get(key) === pr.updatedAtIso) return;
  state.queueConflictNotifiedFor.set(key, pr.updatedAtIso);
  await notifyQueueConflictBlocked(pr);
}

async function triggerRebase(pr: PullRequestSummary) {
  const key = prKey(pr);
  if (state.queueRebaseTriggeredFor.has(key)) return; // already triggered, waiting for GitHub to catch up
  state.queueRebaseTriggeredFor.add(key);

  try {
    await invoke("rebase_pull_request", {
      repo: pr.repo,
      prNumber: pr.id,
      nodeId: pr.nodeId,
      headSha: pr.headSha,
    });
    setStatus(`Rebasing ${pr.repo}#${pr.id} to keep it moving in the merge queue…`);
    if (state.notificationsEnabled) void notifyQueueRebaseTriggered(pr);
  } catch (error) {
    state.queueRebaseTriggeredFor.delete(key); // allow a retry on the next refresh
    setStatus(
      `Failed to rebase ${pr.repo}#${pr.id}: ${errorMessage(error, "unknown reason")}`,
      "danger",
    );
  }
}
