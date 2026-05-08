export type ReviewState =
  | "approved"
  | "approved-stale"
  | "needs-review"
  | "changes-requested";

export type Priority = "Highest" | "High" | "Medium" | "Low";
export type AuthorType = "internal" | "team" | "collaborator";
export type MatchStrategy = "title-board" | "title-any" | "fallback-text" | "none";

export interface ReviewActor {
  login: string;
  avatarUrl?: string;
}

export interface PullRequestSummary {
  id: number;
  repo: string;
  title: string;
  url: string;
  jiraUrl?: string;
  isDraft: boolean;
  createdAtIso: string;
  authorType: AuthorType;
  jiraBoard?: string;
  matchStrategy: MatchStrategy;
  jiraKey: string;
  jiraSummary: string;
  jiraPriority: Priority;
  jiraRelease: string;
  jiraReleaseDate?: string;
  jiraStatus: string;
  author: string;
  authorAvatarUrl?: string;
  assignee: string;
  assigneeAvatarUrl?: string;
  currentReviewer: string;
  currentReviewerAvatarUrl?: string;
  previousApprover?: string;
  previousApproverAvatarUrl?: string;
  pendingReviewers: ReviewActor[];
  currentApprovers: ReviewActor[];
  staleApprovers: ReviewActor[];
  blockingReviewers: ReviewActor[];
  commentedReviewers: ReviewActor[];
  reviewState: ReviewState;
  hasStaleApproval: boolean;
  updatedAt: string;
  pipelineState: "success" | "pending" | "failure" | "action-required" | "unknown";
  hasFailedPipeline: boolean;
  additions: number;
  deletions: number;
  autoMergeMethod: string | null;
  unresolvedThreads: number;
  mergeStatus: "clean" | "behind" | "conflicting" | "blocked" | "unknown";
  nodeId: string;
  headRef: string;
  baseRef: string;
  body: string;
}

export const mockPullRequests: PullRequestSummary[] = [
  {
    id: 1842,
    repo: "payments/api",
    title: "Support partial refunds in settlement flow",
    url: "https://github.com/payments/api/pull/1842",
    jiraUrl: "https://jira.example.com/browse/PAY-184",
    isDraft: false,
    createdAtIso: "2026-04-01T10:00:00.000Z",
    authorType: "internal",
    jiraBoard: "PAY",
    matchStrategy: "title-board",
    jiraKey: "PAY-184",
    jiraSummary: "Enable partial refund orchestration for card settlements",
    jiraPriority: "Highest",
    jiraRelease: "2026.05",
    jiraReleaseDate: "May 15, 2026",
    jiraStatus: "Ready for release",
    author: "marta",
    assignee: "luca",
    currentReviewer: "chiara",
    previousApprover: "luca",
    pendingReviewers: [{ login: "chiara" }],
    currentApprovers: [],
    staleApprovers: [{ login: "luca" }],
    blockingReviewers: [],
    commentedReviewers: [],
    reviewState: "approved-stale",
    hasStaleApproval: true,
    updatedAt: "14 min ago",
    pipelineState: "success",
    hasFailedPipeline: false,
    additions: 312,
    deletions: 47,
    autoMergeMethod: "SQUASH",
    unresolvedThreads: 2,
    mergeStatus: "behind",
    nodeId: "",
    headRef: "",
    baseRef: "",
    body: "",
  },
  {
    id: 918,
    repo: "mobile/backoffice",
    title: "Improve deployment status polling",
    url: "https://github.com/mobile/backoffice/pull/918",
    jiraUrl: "https://jira.example.com/browse/OPS-77",
    isDraft: false,
    createdAtIso: "2026-04-10T09:30:00.000Z",
    authorType: "internal",
    jiraBoard: "OPS",
    matchStrategy: "title-board",
    jiraKey: "OPS-77",
    jiraSummary: "Reduce noisy polling and expose final rollout state",
    jiraPriority: "High",
    jiraRelease: "2026.04-hotfix",
    jiraReleaseDate: "Apr 25, 2026",
    jiraStatus: "In validation",
    author: "sara",
    assignee: "federico",
    currentReviewer: "federico",
    pendingReviewers: [],
    currentApprovers: [{ login: "federico" }],
    staleApprovers: [],
    blockingReviewers: [],
    commentedReviewers: [],
    reviewState: "approved",
    hasStaleApproval: false,
    updatedAt: "1 h ago",
    pipelineState: "success",
    hasFailedPipeline: false,
    additions: 58,
    deletions: 120,
    autoMergeMethod: null,
    unresolvedThreads: 0,
    mergeStatus: "clean",
    nodeId: "",
    headRef: "",
    baseRef: "",
    body: "",
  },
  {
    id: 415,
    repo: "checkout/web",
    title: "Refactor promo code validation and edge cases",
    url: "https://github.com/checkout/web/pull/415",
    jiraUrl: "https://jira.example.com/browse/CHK-311",
    isDraft: true,
    createdAtIso: "2026-03-20T15:45:00.000Z",
    authorType: "collaborator",
    jiraBoard: "CHK",
    matchStrategy: "none",
    jiraKey: "CHK-311",
    jiraSummary: "Fix coupon validation failures for mixed carts",
    jiraPriority: "Medium",
    jiraRelease: "2026.06",
    jiraReleaseDate: "Jun 10, 2026",
    jiraStatus: "In progress",
    author: "giulia",
    assignee: "davide",
    currentReviewer: "andrea",
    pendingReviewers: [{ login: "andrea" }],
    currentApprovers: [],
    staleApprovers: [],
    blockingReviewers: [],
    commentedReviewers: [],
    reviewState: "needs-review",
    hasStaleApproval: false,
    updatedAt: "8 min ago",
    pipelineState: "pending",
    hasFailedPipeline: false,
    additions: 5,
    deletions: 3,
    autoMergeMethod: null,
    unresolvedThreads: 0,
    mergeStatus: "unknown",
    nodeId: "",
    headRef: "CHK-311/refactor-promo-validation",
    baseRef: "main",
    body: "",
  },
];
