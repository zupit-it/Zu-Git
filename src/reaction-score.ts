import type { MyScore, MyScoreItem, PullRequestSummary } from "./shared/pr-model";

const HIGH_PRIORITY = new Set(["Highest", "High"]);

function hoursAgo(isoDate: string, now: Date): number {
  return (now.getTime() - new Date(isoDate).getTime()) / 3_600_000;
}

function formatWaited(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

function isHigh(pr: PullRequestSummary): boolean {
  return HIGH_PRIORITY.has(pr.jiraPriority);
}

function applyMultiplier(base: number, pr: PullRequestSummary): number {
  return isHigh(pr) ? Math.round(base * 1.5) : base;
}

export interface ScoreRules {
  reviews: boolean;
  changesRequested: boolean;
  ci: boolean;
  behind: boolean;
}

const DEFAULT_RULES: ScoreRules = {
  reviews: true,
  changesRequested: true,
  ci: true,
  behind: false,
};

export function computeMyScore(
  prs: PullRequestSummary[],
  viewerLogin: string,
  now: Date = new Date(),
  rules: ScoreRules = DEFAULT_RULES,
): MyScore {
  const viewer = viewerLogin.toLowerCase();
  const items: MyScoreItem[] = [];

  const counters = {
    reviews: { count: 0, high: 0, label: "Reviews waiting" },
    myPRs:   { count: 0, high: 0, label: "My PRs need action" },
    ci:      { count: 0, high: 0, label: "CI failures" },
    behind:  { count: 0, high: 0, label: "Behind / conflict" },
  };

  for (const pr of prs) {
    if (pr.isDraft) continue;

    const hours = hoursAgo(pr.updatedAtIso, now);
    const waited = formatWaited(hours);
    const high = isHigh(pr);
    const jira = pr.jiraKey || "—";

    const isMyPr = pr.author.toLowerCase() === viewer;
    const isPendingReviewer = pr.pendingReviewers.some(
      (r) => r.login.toLowerCase() === viewer
    );

    // ── Review requested from me ────────────────────────────────
    if (rules.reviews && isPendingReviewer && hours > 1) {
      counters.reviews.count++;
      if (high) counters.reviews.high++;
      const base = hours > 4 ? 25 : 10;
      items.push({
        kind: "review-requested",
        icon: "review",
        jira,
        priority: high ? "high" : "normal",
        title: pr.title,
        reason: `Review requested by ${pr.author}`,
        waited,
        penalty: applyMultiplier(base, pr),
        prUrl: pr.url,
      });
    }

    if (!isMyPr) continue;

    // ── My PR: changes requested ────────────────────────────────
    if (rules.changesRequested && pr.reviewState === "changes-requested" && hours > 2) {
      counters.myPRs.count++;
      if (high) counters.myPRs.high++;
      const blocker = pr.blockingReviewers[0]?.login ?? "reviewer";
      items.push({
        kind: "my-changes-requested",
        icon: "changes",
        jira,
        priority: high ? "high" : "normal",
        title: pr.title,
        reason: `Changes requested by ${blocker}`,
        waited,
        penalty: applyMultiplier(20, pr),
        prUrl: pr.url,
      });
    }

    // ── My PR: CI failed ────────────────────────────────────────
    if (rules.ci && pr.hasFailedPipeline && hours > 1) {
      counters.ci.count++;
      if (high) counters.ci.high++;
      items.push({
        kind: "ci-failed",
        icon: "ci",
        jira,
        priority: high ? "high" : "normal",
        title: pr.title,
        reason: "CI failed on pull-request workflow",
        waited,
        penalty: applyMultiplier(15, pr),
        prUrl: pr.url,
      });
    }

    // ── My PR: behind or conflicting ────────────────────────────
    if (rules.behind && (pr.mergeStatus === "behind" || pr.mergeStatus === "conflicting") && hours > 2) {
      counters.behind.count++;
      if (high) counters.behind.high++;
      items.push({
        kind: "behind",
        icon: "behind",
        jira,
        priority: high ? "high" : "normal",
        title: pr.title,
        reason: `Branch is ${pr.mergeStatus} with target`,
        waited,
        penalty: applyMultiplier(10, pr),
        prUrl: pr.url,
      });
    }
  }

  items.sort((a, b) => b.penalty - a.penalty || b.waited.localeCompare(a.waited));

  const totalPenalty = items.reduce((sum, it) => sum + it.penalty, 0);
  const value = Math.max(0, Math.min(100, 100 - totalPenalty));

  return {
    value,
    counters,
    items: items.slice(0, 3),
  };
}
