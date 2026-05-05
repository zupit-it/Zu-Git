import { invoke } from "@tauri-apps/api/core";
import type { DashboardBootstrap, DashboardSnapshot, SaveSettingsResult, TokenStoreStatus } from "./shared/rpc";
import type { PullRequestSummary, ReviewActor } from "./shared/pr-model";
import {
  defaultListFilterPreferences,
  defaultSettings,
  normalizeSettings,
  serializeSettingsForm,
  type ListFilterPreferences,
  type SettingsFormValues,
} from "./shared/settings";

const reviewStateLabel: Record<PullRequestSummary["reviewState"], string> = {
  approved: "Approved",
  "approved-stale": "Approved but stale",
  "needs-review": "Needs review",
  "changes-requested": "Changes requested",
};

const authorTypeLabel: Record<PullRequestSummary["authorType"], string> = {
  internal: "Internal",
  collaborator: "Collaborator",
};

const pipelineStateMeta: Record<
  PullRequestSummary["pipelineState"],
  { label: string; className: string } | null
> = {
  success: { label: "OK", className: "table-tag-pipeline-success" },
  pending: { label: "RUNNING", className: "table-tag-pipeline-pending" },
  failure: { label: "FAILED", className: "table-tag-pipeline-failure" },
  "action-required": { label: "ACTION REQUIRED", className: "table-tag-pipeline-action" },
  unknown: null,
};

let currentDashboard: DashboardSnapshot | null = null;
let currentView: "status" | "list" | "settings" = "list";
let listSearchQuery = "";
let onlyMyPendingReviews = defaultListFilterPreferences.onlyMyPendingReviews;
let onlyMyPullRequests = defaultListFilterPreferences.onlyMyPullRequests;
let showInternalOnly = defaultListFilterPreferences.includeInternal;
let showCollaboratorOnly = defaultListFilterPreferences.includeCollaborator;
let groupByRelease = defaultListFilterPreferences.groupByRelease;
let showDraft = defaultListFilterPreferences.showDraft;
let hiddenRepos = [...defaultListFilterPreferences.hiddenRepos];
let currentAutoRefreshMinutes = defaultSettings.autoRefreshMinutes;
let currentInternalMarker = defaultSettings.internalAuthorMarker;
let currentCollaborators: string[] = [];
let autoRefreshIntervalId: number | null = null;
let syncLabelIntervalId: number | null = null;
let lastSyncedAt: string | null = null;
let lastSyncSource: "live" | "mock" = "mock";
let lastMyChangesRequestedIds = new Set<string>();
let lastMyPendingReviewIds: Set<string> | null = null; // null = first load, skip notification
let notificationsEnabled = defaultSettings.notificationsEnabled;
let settingsDirty = false;
let settingsSaving = false;
let refreshInProgress = false;


function renderSecretStoreInfo(secretStore: {
  provider: "keychain" | "credential-manager" | "secret-service" | "fallback-file";
  detail: string;
}) {
  const providerTarget = document.querySelector<HTMLElement>("[data-secret-store-provider]");
  const badgeTarget = document.querySelector<HTMLElement>("[data-secret-store-badge]");
  if (!providerTarget || !badgeTarget) return;

  const labels = {
    keychain: "macOS Keychain",
    "credential-manager": "Windows Credential Manager",
    "secret-service": "Linux Secret Service",
    "fallback-file": "Fallback file",
  } as const;

  providerTarget.textContent = labels[secretStore.provider];
  badgeTarget.textContent =
    secretStore.provider === "fallback-file" ? "Fallback active" : "System store active";
  badgeTarget.dataset.provider = secretStore.provider;
}

function setSettingsNotice(
  message: string,
  tone: "neutral" | "info" | "success" | "danger" = "neutral",
) {
  const target = document.querySelector<HTMLElement>("[data-settings-notice]");
  if (!target) return;

  target.innerHTML = message;
  target.dataset.tone = tone;
}

function syncSettingsSaveButton() {
  const saveBar = document.querySelector<HTMLElement>("[data-save-bar]");
  const saveButton = document.querySelector<HTMLButtonElement>("[data-save-button]");

  const discardButton = document.querySelector<HTMLButtonElement>("[data-discard-button]");

  if (settingsSaving) {
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "Saving…";
    }
    if (discardButton) discardButton.setAttribute("hidden", "");
    return;
  }

  if (discardButton) discardButton.removeAttribute("hidden");

  if (saveButton) {
    saveButton.disabled = false;
    saveButton.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>
      Save settings &amp; sync
    `;
  }

  if (saveBar) {
    saveBar.toggleAttribute("hidden", !settingsDirty);
  }
}

function setSettingsDirtyState(isDirty: boolean) {
  settingsDirty = isDirty;
  syncSettingsSaveButton();

  if (settingsSaving) return;

  if (isDirty) {
    setSettingsNotice(
      "You have unsaved changes. Settings are saved only when you click <strong>Save settings and sync</strong>.",
      "info",
    );
  } else {
    setSettingsNotice(
      "Changes are saved only when you click <strong>Save settings and sync</strong>.",
      "neutral",
    );
  }
}

function setListLoading(isLoading: boolean, label = "Loading pull requests…") {
  const loading = document.querySelector<HTMLElement>("[data-list-loading]");
  const loadingLabel = document.querySelector<HTMLElement>("[data-list-loading-label]");
  const table = document.querySelector<HTMLElement>("[data-list-table]");
  const dashboardList = document.querySelector<HTMLElement>("[data-pr-list]");
  const dashboardEmpty = document.querySelector<HTMLElement>("[data-pr-empty]");

  if (loading) {
    loading.toggleAttribute("hidden", !isLoading);
  }

  if (loadingLabel) {
    loadingLabel.textContent = label;
  }

  if (isLoading) {
    dashboardEmpty?.setAttribute("hidden", "");
  }
}

function configureAutoRefresh() {
  if (autoRefreshIntervalId !== null) {
    window.clearInterval(autoRefreshIntervalId);
    autoRefreshIntervalId = null;
  }

  if (currentAutoRefreshMinutes <= 0) {
    return;
  }

  autoRefreshIntervalId = window.setInterval(() => {
    void refreshDashboard("auto");
  }, currentAutoRefreshMinutes * 60 * 1000);
}

function getAvailableRepos(snapshot: DashboardSnapshot) {
  const configuredRepos = snapshot.repoSyncs.map((repoSync) => repoSync.repo);
  if (configuredRepos.length > 0) {
    return configuredRepos;
  }

  return Array.from(new Set(snapshot.prs.map((pr) => pr.repo))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function renderToolbarRepoFilters(snapshot: DashboardSnapshot | null) {
  const container = document.querySelector<HTMLElement>("[data-toolbar-repo-filters]");
  const sep = document.querySelector<HTMLElement>("[data-repo-filter-sep]");
  if (!container) return;

  if (!snapshot || currentView !== "list") {
    container.innerHTML = "";
    container.setAttribute("hidden", "");
    sep?.setAttribute("hidden", "");
    return;
  }

  const repos = getAvailableRepos(snapshot);
  if (repos.length === 0) {
    container.innerHTML = "";
    container.setAttribute("hidden", "");
    sep?.setAttribute("hidden", "");
    return;
  }

  container.innerHTML = repos
    .map((repo) => {
      const checked = !hiddenRepos.includes(repo);
      return `
        <label class="toolbar-repo-toggle">
          <input data-toolbar-repo-toggle type="checkbox" value="${repo}" ${checked ? "checked" : ""} />
          <span>${repo}</span>
        </label>
      `;
    })
    .join("");
  container.removeAttribute("hidden");
  sep?.removeAttribute("hidden");
}

const AVATAR_COLORS = [
  '#4f46e5', '#7c3aed', '#db2777', '#dc2626',
  '#d97706', '#059669', '#0891b2', '#2563eb',
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function renderAvatar(name: string, avatarUrl?: string, size: "sm" | "md" = "md") {
  if (avatarUrl) {
    return `<img class="user-avatar user-avatar-${size}" src="${avatarUrl}" alt="${name}" loading="lazy" />`;
  }

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const color = avatarColor(name);
  return `<span class="user-avatar user-avatar-${size}" style="background:${color};color:#fff;border-color:${color}" aria-hidden="true">${initial}</span>`;
}

function renderUserIdentity(
  name: string,
  subtitle?: string,
  avatarUrl?: string,
  size: "sm" | "md" = "md",
) {
  return `
    <div class="table-user-cell">
      <div class="user-identity">
        ${renderAvatar(name, avatarUrl, size)}
        <div class="user-identity-copy">
          <strong>${name}</strong>
          ${subtitle ? `<span>${subtitle}</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderReviewActors(actors: ReviewActor[], tone: string) {
  if (actors.length === 0) return "";

  return `
    <div class="review-actor-list">
      ${actors
        .map(
          (actor) => `
            <span class="review-actor review-actor-${tone}">
              ${renderAvatar(actor.login, actor.avatarUrl, "sm")}
              <span>${actor.login}</span>
            </span>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderReviewDetail(pr: PullRequestSummary) {
  const items = [
    ...pr.blockingReviewers.map((a) => ({ label: "Changes requested", tone: "blocked", ...a })),
    ...pr.pendingReviewers.map((a) => ({ label: "Pending", tone: "pending", ...a })),
    ...pr.staleApprovers.map((a) => ({ label: "Stale approval", tone: "stale", ...a })),
    ...pr.currentApprovers.map((a) => ({ label: "Approved", tone: "approved", ...a })),
  ];

  if (items.length === 0) {
    return `<span class="no-reviewers">No reviewers</span>`;
  }

  return `
    <div class="review-badge-list">
      ${items
        .map(
          (item) => `
            <div class="review-badge review-badge-${item.tone}">
              ${renderAvatar(item.login, item.avatarUrl, "sm")}
              <span>${item.label}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function setView(view: "status" | "list" | "settings") {
  currentView = view;

  document.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.toggleAttribute("hidden", panel.dataset.viewPanel !== view);
  });

  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach((tab) => {
    const isActive = tab.dataset.viewTab === view;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-pressed", String(isActive));
  });

  renderToolbarRepoFilters(currentDashboard);
}

function matchesSearch(pr: PullRequestSummary, query: string) {
  if (!query) return true;

  const haystack = [
    pr.title,
    pr.jiraKey,
    pr.jiraSummary,
    pr.repo,
    pr.author,
    pr.jiraRelease,
    pr.jiraStatus,
    pr.jiraBoard,
    ...pr.pendingReviewers.map((actor) => actor.login),
    ...pr.currentApprovers.map((actor) => actor.login),
    ...pr.staleApprovers.map((actor) => actor.login),
    ...pr.blockingReviewers.map((actor) => actor.login),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function countPendingReviewsForViewer(snapshot: DashboardSnapshot) {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) {
    return 0;
  }

  return snapshot.prs.filter((pr) => {
    if (pr.isDraft) return false;
    const isPendingReviewer = pr.pendingReviewers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    const alreadyApproved = pr.currentApprovers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );

    return isPendingReviewer && !alreadyApproved;
  }).length;
}

function countMyChangesRequested(snapshot: DashboardSnapshot) {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) {
    return 0;
  }

  return snapshot.prs.filter(
    (pr) =>
      !pr.isDraft &&
      pr.author.toLowerCase() === viewerLogin &&
      pr.reviewState === "changes-requested" &&
      pr.blockingReviewers.length > 0,
  ).length;
}

function getMyPendingReviewIds(snapshot: DashboardSnapshot): Set<string> {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) return new Set();

  return new Set(
    snapshot.prs
      .filter(
        (pr) =>
          !pr.isDraft &&
          pr.pendingReviewers.some((a) => a.login.toLowerCase() === viewerLogin) &&
          !pr.currentApprovers.some((a) => a.login.toLowerCase() === viewerLogin),
      )
      .map((pr) => `${pr.repo}#${pr.id}`),
  );
}

function getMyChangesRequestedIds(snapshot: DashboardSnapshot) {
  const viewerLogin = snapshot.viewerLogin?.toLowerCase();
  if (!viewerLogin) {
    return new Set<string>();
  }

  return new Set(
    snapshot.prs
      .filter(
        (pr) =>
          !pr.isDraft &&
          pr.author.toLowerCase() === viewerLogin &&
          pr.reviewState === "changes-requested" &&
          pr.blockingReviewers.length > 0,
      )
      .map((pr) => `${pr.repo}#${pr.id}`),
  );
}

function countNewIds(next: Set<string>, previous: Set<string>) {
  let count = 0;
  for (const id of next) {
    if (!previous.has(id)) {
      count += 1;
    }
  }
  return count;
}

const PRIORITY_RANK: Record<string, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

function applyListSort(prs: PullRequestSummary[]): PullRequestSummary[] {
  return [...prs].sort((a, b) => {
    const ra = PRIORITY_RANK[a.jiraPriority] ?? 4;
    const rb = PRIORITY_RANK[b.jiraPriority] ?? 4;
    return ra - rb;
  });
}

function applyListFilters(snapshot: DashboardSnapshot) {
  return applyListSort(snapshot.prs.filter((pr) => {
    if (!matchesSearch(pr, listSearchQuery)) {
      return false;
    }

    if (!showDraft && pr.isDraft) {
      return false;
    }

    if (hiddenRepos.includes(pr.repo)) {
      return false;
    }

    if (onlyMyPullRequests) {
      const viewerLogin = snapshot.viewerLogin?.toLowerCase();
      if (!viewerLogin || pr.author.toLowerCase() !== viewerLogin) {
        return false;
      }
    }

    if (showInternalOnly || showCollaboratorOnly) {
      const matchesType =
        (showInternalOnly && pr.authorType === "internal") ||
        (showCollaboratorOnly && pr.authorType === "collaborator");

      if (!matchesType) {
        return false;
      }
    }

    if (!onlyMyPendingReviews) {
      return true;
    }

    const viewerLogin = snapshot.viewerLogin?.toLowerCase();
    if (!viewerLogin) {
      return false;
    }

    const isPendingReviewer = pr.pendingReviewers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );
    const alreadyApproved = pr.currentApprovers.some(
      (actor) => actor.login.toLowerCase() === viewerLogin,
    );

    return isPendingReviewer && !alreadyApproved;
  }));
}


async function persistListFilters() {
  try {
    const saved = await invoke<ListFilterPreferences>("save_list_filters", {
      params: {
        onlyMyPendingReviews,
        onlyMyPullRequests,
        includeInternal: showInternalOnly,
        includeCollaborator: showCollaboratorOnly,
        groupByRelease,
        showDraft,
        hiddenRepos,
      },
    });

    onlyMyPendingReviews = saved.onlyMyPendingReviews;
    onlyMyPullRequests = saved.onlyMyPullRequests;
    showInternalOnly = saved.includeInternal;
    showCollaboratorOnly = saved.includeCollaborator;
    groupByRelease = saved.groupByRelease;
    showDraft = saved.showDraft;
    hiddenRepos = saved.hiddenRepos;
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to save list filters.",
      "danger",
    );
  }
}

const SVG = {
  gitpr: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><path d="M3 4.4v3.2M9 7.6V6a2 2 0 0 0-2-2H5.5"/><path d="M6.5 2.5L5 4l1.5 1.5"/></svg>`,
  draft: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.5" stroke-dasharray="2 1.8"/><path d="M6 4v2.5L7.5 8"/></svg>`,
  clock: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5v3L8 8"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`,
  x: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`,
  ext: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2H2v6h6V6M5.5 1.5h3v3M4.5 5.5l4-4"/></svg>`,
  jira: `<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1L1 6l5 5 1.3-1.3L3.6 6 7.3 2.3z" opacity=".7"/><path d="M6 4.7L8.4 7.1 6 9.5V11l5-5-5-5z"/></svg>`,
  priorityHighest: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8l4-4 4 4"/><path d="M2 5l4-4 4 4"/></svg>`,
  priorityHigh:    `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5l4-5 4 5"/></svg>`,
  priorityMedium:  `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#ca8a04" stroke-width="2" stroke-linecap="round"><path d="M2 4.5h8M2 7.5h8"/></svg>`,
  priorityLow:     `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5l4 5 4-5"/></svg>`,
  rerequest: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5A4.5 4.5 0 1 0 11 7"/><path d="M10 1v3h-3"/></svg>`,
};

function chip(kind: string, content: string, icon = ""): string {
  return `<span class="chip chip-${kind}">${icon}${content}</span>`;
}

function avatarSm(name: string, avatarUrl?: string): string {
  if (avatarUrl) {
    return `<img class="avatar avatar-sm" src="${avatarUrl}" alt="${name}" loading="lazy" />`;
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const color = avatarColor(name);
  return `<span class="avatar avatar-sm" style="background:${color}" aria-hidden="true">${initial}</span>`;
}

function renderReviewBadges(pr: PullRequestSummary, viewerLogin?: string): string {
  const seen = new Set<string>();
  const dedup = <T extends { login: string }>(arr: T[]) =>
    arr.filter(({ login }) => !seen.has(login) && seen.add(login));

  const isMyPr = !!viewerLogin && pr.author.toLowerCase() === viewerLogin.toLowerCase();

  const items: Array<{ login: string; avatarUrl?: string; tone: string; label: string; stale?: boolean; canRerequest?: boolean }> = [
    ...dedup(pr.blockingReviewers).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl, tone: "fail", label: "Changes requested", canRerequest: isMyPr })),
    ...dedup(pr.pendingReviewers).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl, tone: "warn", label: "Review required" })),
    ...dedup(pr.staleApprovers).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl, tone: "ok", label: "Approved", stale: true })),
    ...dedup(pr.currentApprovers).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl, tone: "ok", label: "Approved", stale: false })),
    ...dedup(pr.commentedReviewers).map((a) => ({ login: a.login, avatarUrl: a.avatarUrl, tone: "neutral", label: "Commented" })),
  ];

  if (items.length === 0) {
    return `<span style="font-size:11.5px;color:var(--ink-faint);font-style:italic">No reviewers</span>`;
  }

  return items
    .map(
      (item) => `
        <div class="review-badge review-badge-${item.tone}">
          ${avatarSm(item.login, item.avatarUrl)}
          <span>${item.label}</span>${item.stale ? `<span class="review-badge-stale-icon">${SVG.clock}</span>` : ""}${item.canRerequest ? `<button class="review-badge-rerequest" title="Re-request review from ${item.login}" data-repo="${pr.repo}" data-pr-number="${pr.id}" data-login="${item.login}">${SVG.rerequest}</button>` : ""}
        </div>
      `,
    )
    .join("");
}

function formatDiffNum(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

function diffSizeBucket(total: number): string {
  if (total <= 50)   return "xs";
  if (total <= 200)  return "s";
  if (total <= 500)  return "m";
  if (total <= 1000) return "l";
  return "xl";
}

function renderDiffStat(additions: number, deletions: number): string {
  if (additions === 0 && deletions === 0) return "";
  const total = additions + deletions;
  const bucket = diffSizeBucket(total);
  const title = `${additions.toLocaleString()} additions · ${deletions.toLocaleString()} deletions · ${total.toLocaleString()} lines (${bucket.toUpperCase()})`;
  return `<span class="diffstat" title="${title}">` +
    `<span class="diffstat__dot diffstat__dot--${bucket}" aria-hidden="true"></span>` +
    `<span class="diffstat__add">+${formatDiffNum(additions)}</span>` +
    `<span class="diffstat__sep">·</span>` +
    `<span class="diffstat__del">−${formatDiffNum(deletions)}</span>` +
    `</span>`;
}

function renderPRRow(pr: PullRequestSummary, isLast: boolean, viewerLogin?: string): string {
  const isAging = Date.now() - Date.parse(pr.createdAtIso) > 14 * 24 * 60 * 60 * 1000;
  const priorityIconMap: Partial<Record<PullRequestSummary["jiraPriority"], string>> = {
    Highest: SVG.priorityHighest,
    High:    SVG.priorityHigh,
    Low:     SVG.priorityLow,
  };
  const priorityIconSvg = priorityIconMap[pr.jiraPriority];
  const priorityIcon = pr.jiraKey && priorityIconSvg
    ? `<span class="priority-icon" title="${pr.jiraPriority} priority">${priorityIconSvg}</span>`
    : "";

  const keyChip = pr.isDraft
    ? chip("draft", "DRAFT", SVG.draft)
    : pr.jiraKey
      ? chip("accent chip-key", pr.jiraKey, SVG.gitpr)
      : "";

  const authorChip =
    pr.authorType === "internal"
      ? chip("neutral", "Internal", `<span class="chip-dot"></span>`)
      : chip("ghost", "Collaborator");

  const agingChip = isAging ? ` ${chip("warn", "Older than 2 weeks", SVG.clock)}` : "";

  const pipelineChip =
    pr.pipelineState === "success"
      ? chip("ok", "CI OK", SVG.check)
      : pr.pipelineState === "failure"
        ? chip("fail", "CI Failed", SVG.x)
        : pr.pipelineState === "pending"
          ? chip("warn", "CI Running", SVG.clock)
          : pr.pipelineState === "action-required"
            ? chip("action", "Action required", SVG.x)
            : "";

  const diffChip = renderDiffStat(pr.additions, pr.deletions);

  const jiraBtn = pr.jiraUrl
    ? `<button class="icon-btn" data-jira-link="${pr.jiraUrl}" type="button">${SVG.jira}<span>Jira</span></button>`
    : "";

  return `
    <div class="pr-row" data-pr-id="${pr.repo}/${pr.id}" style="${isLast ? "" : "border-bottom:1px solid var(--border)"}">
      <div class="pr-row-bar"></div>
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
          ${keyChip}${priorityIcon}
          <span style="font-size:13.5px;font-weight:600;color:var(--ink);letter-spacing:-0.1px;line-height:1.3">${pr.title}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:${pr.jiraSummary ? "6" : "0"}px">
          ${avatarSm(pr.author, pr.authorAvatarUrl)}
          <span style="font-size:12px;color:var(--ink-soft);font-weight:500;font-family:var(--font-mono)">${pr.author}</span>
          ${diffChip}
          ${authorChip}${agingChip}
        </div>
        ${pr.jiraSummary ? `<div style="font-size:12.5px;color:var(--ink-muted);line-height:1.45;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${pr.jiraSummary}</div>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;padding-top:2px">
        ${renderReviewBadges(pr, viewerLogin)}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;padding-top:2px">
        <div style="font-size:12px;color:var(--ink-soft);font-weight:600">${pr.updatedAt}</div>
        ${pipelineChip ? `<div style="display:flex;gap:5px;flex-wrap:wrap">${pipelineChip}</div>` : ""}
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;padding-top:2px">
        <button class="icon-btn" data-pr-link="${pr.url}" type="button">${SVG.ext}<span>PR</span></button>
        ${jiraBtn}
      </div>
    </div>
  `;
}

function renderPRListWrap(prs: PullRequestSummary[], viewerLogin?: string): string {
  return `<div class="pr-list-wrap">${prs.map((pr, i) => renderPRRow(pr, i === prs.length - 1, viewerLogin)).join("")}</div>`;
}

function renderListTable(prs: PullRequestSummary[]) {
  const target = document.querySelector<HTMLElement>("[data-list-table]");
  if (!target) return;

  const viewerLogin = currentDashboard?.viewerLogin;

  if (prs.length === 0) {
    target.innerHTML = `<div class="list-empty">No pull requests available.</div>`;
    return;
  }

  if (!groupByRelease) {
    target.innerHTML = renderPRListWrap(prs, viewerLogin);
    return;
  }

  const groups = new Map<string, { label: string; prs: PullRequestSummary[]; releaseDate?: string }>();
  for (const pr of prs) {
    const key = `${pr.jiraRelease}::${pr.jiraReleaseDate ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.prs.push(pr);
    } else {
      groups.set(key, {
        label: pr.jiraRelease || "No release",
        prs: [pr],
        releaseDate: pr.jiraReleaseDate,
      });
    }
  }

  const sortedGroups = Array.from(groups.values()).sort((a, b) => {
    const aTime = a.releaseDate ? Date.parse(a.releaseDate) : Number.POSITIVE_INFINITY;
    const bTime = b.releaseDate ? Date.parse(b.releaseDate) : Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.label.localeCompare(b.label);
  });

  target.innerHTML = sortedGroups
    .map((group) => {
      const count = group.prs.length;
      const dateHtml = group.releaseDate
        ? `<span class="release-group-sep"></span><span class="release-group-date">${group.releaseDate}</span>`
        : "";
      return `
        <section class="release-group">
          <div class="release-group-header">
            <span class="release-group-dot"></span>
            <span class="release-group-label">${group.label}</span>
            ${dateHtml}
            <span class="release-group-count">${count} PR${count !== 1 ? "s" : ""}</span>
            <div class="release-group-line"></div>
          </div>
          ${renderPRListWrap(group.prs, viewerLogin)}
        </section>
      `;
    })
    .join("");
}

function renderListBoard(prs: PullRequestSummary[]) {
  renderListTable(prs);
}

function renderReviewerLoad(snapshot: DashboardSnapshot) {
  const target = document.querySelector<HTMLElement>("[data-reviewer-load]");
  if (!target) return;

  // Use the configured collaborator list as the fixed set of reviewers to display.
  if (currentCollaborators.length === 0) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }

  // Build counts from non-draft PRs.
  const pending = new Map<string, number>();
  const total   = new Map<string, number>();

  // Map from lowercased login → canonical login as typed in settings,
  // so matching is case-insensitive but we keep the original key for lookups.
  const collaboratorByLower = new Map(
    currentCollaborators.map(l => [l.toLowerCase(), l])
  );

  const touch = (login: string, isPending: boolean) => {
    const canonical = collaboratorByLower.get(login.toLowerCase());
    if (!canonical) return;
    total.set(canonical, (total.get(canonical) ?? 0) + 1);
    if (isPending) pending.set(canonical, (pending.get(canonical) ?? 0) + 1);
  };

  for (const pr of snapshot.prs) {
    if (pr.isDraft) continue;
    for (const r of pr.pendingReviewers)   touch(r.login, true);
    for (const r of pr.currentApprovers)   touch(r.login, false);
    for (const r of pr.blockingReviewers)  touch(r.login, false);
    for (const r of pr.staleApprovers)     touch(r.login, false);
    for (const r of pr.commentedReviewers) touch(r.login, false);
  }

  const viewer = snapshot.viewerLogin?.toLowerCase();

  // Sort: most pending first, then most total assigned; "me" always last.
  const sorted = [...currentCollaborators].sort((a, b) => {
    const aIsMe = viewer && a.toLowerCase() === viewer ? 1 : 0;
    const bIsMe = viewer && b.toLowerCase() === viewer ? 1 : 0;
    if (aIsMe !== bIsMe) return aIsMe - bIsMe;
    return (pending.get(b) ?? 0) - (pending.get(a) ?? 0) ||
           (total.get(b)   ?? 0) - (total.get(a)   ?? 0);
  });

  const avatars = snapshot.reviewerAvatars ?? {};
  const stripMarker = (login: string) =>
    currentInternalMarker ? login.replace(currentInternalMarker, "") : login;

  target.hidden = false;
  target.innerHTML =
    `<span class="reviewer-load-label">Review load</span>` +
    `<span class="reviewer-load-pills">` +
    sorted.map(login => {
      const p = pending.get(login) ?? 0;
      const t = total.get(login)   ?? 0;
      return `<span class="reviewer-load-item">` +
        avatarSm(login, avatars[login]) +
        `<span class="reviewer-load-name">${stripMarker(login)}</span>` +
        `<span class="reviewer-load-count">` +
          `<span class="reviewer-load-count__pending">${p}</span>` +
          `<span class="reviewer-load-count__sep">/</span>` +
          `<span class="reviewer-load-count__total">${t}</span>` +
        `</span>` +
        `</span>`;
    }).join("") +
    `</span>`;
}

function renderListFilters(snapshot: DashboardSnapshot) {
  const searchInput = document.querySelector<HTMLInputElement>("[data-list-search]");
  const myReviewToggle = document.querySelector<HTMLInputElement>("[data-filter-my-review-pending]");
  const myPrsToggle = document.querySelector<HTMLInputElement>("[data-filter-my-prs]");
  const internalToggle = document.querySelector<HTMLInputElement>("[data-filter-internal]");
  const collaboratorToggle = document.querySelector<HTMLInputElement>("[data-filter-collaborator]");
  const groupByReleaseToggle = document.querySelector<HTMLInputElement>("[data-filter-group-by-release]");
  const showDraftToggle = document.querySelector<HTMLInputElement>("[data-filter-show-draft]");
  const myReviewCountBadge = document.querySelector<HTMLElement>("[data-filter-my-review-count]");
  const myPrsCountBadge = document.querySelector<HTMLElement>("[data-filter-my-prs-count]");
  const myPendingReviewCount = countPendingReviewsForViewer(snapshot);
  const myChangesRequestedCount = countMyChangesRequested(snapshot);

  if (searchInput && searchInput.value !== listSearchQuery) {
    searchInput.value = listSearchQuery;
  }

  if (myReviewToggle) {
    myReviewToggle.checked = onlyMyPendingReviews;
    myReviewToggle.disabled = !snapshot.viewerLogin;
    myReviewToggle.title = snapshot.viewerLogin
      ? `Filter using ${snapshot.viewerLogin}`
      : "Unavailable until GitHub viewer info is loaded";
  }

  if (myReviewCountBadge) {
    myReviewCountBadge.textContent = `· ${myPendingReviewCount} need action`;
    myReviewCountBadge.toggleAttribute("hidden", myPendingReviewCount === 0);
  }

  if (myPrsToggle) {
    myPrsToggle.checked = onlyMyPullRequests;
    myPrsToggle.disabled = !snapshot.viewerLogin;
    myPrsToggle.title = snapshot.viewerLogin
      ? `Filter using ${snapshot.viewerLogin}`
      : "Unavailable until GitHub viewer info is loaded";
  }

  if (myPrsCountBadge) {
    myPrsCountBadge.textContent = `· ${myChangesRequestedCount} need action`;
    myPrsCountBadge.toggleAttribute("hidden", myChangesRequestedCount === 0);
  }

  if (internalToggle) internalToggle.checked = showInternalOnly;
  if (collaboratorToggle) collaboratorToggle.checked = showCollaboratorOnly;
  if (groupByReleaseToggle) groupByReleaseToggle.checked = groupByRelease;
  if (showDraftToggle) showDraftToggle.checked = showDraft;

  renderToolbarRepoFilters(snapshot);
}

async function notifyPendingReviewReminder(pendingReviewCount: number) {
  if (pendingReviewCount <= 0) return;

  try {
    await invoke("show_native_notification", {
      title: "ZuGit – PRs to review",
      body: pendingReviewCount === 1
        ? "Hai 1 PR da verificare."
        : `Hai ${pendingReviewCount} PR da verificare.`,
      silent: false,
    });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to show the native notification.",
      "danger",
    );
  }
}

async function notifyMyChangesRequested(newChangesRequestedCount: number) {
  if (newChangesRequestedCount <= 0) return;

  try {
    await invoke("show_native_notification", {
      title: "ZuGit – Changes requested",
      body: newChangesRequestedCount === 1
        ? "Hai 1 tua PR con changes requested."
        : `Hai ${newChangesRequestedCount} tue PR con changes requested.`,
      silent: false,
    });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to show the native notification.",
      "danger",
    );
  }
}

function relativeTime(isoString: string): string {
  const mins = Math.floor((Date.now() - Date.parse(isoString)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

function updateSyncLabel() {
  if (!lastSyncedAt) return;
  const message = lastSyncSource === "live"
    ? `Synced <strong>${relativeTime(lastSyncedAt)}</strong>`
    : `Sync failed · <strong>${relativeTime(lastSyncedAt)}</strong>`;
  setStatus(message, lastSyncSource === "live" ? "neutral" : "danger");
}

function startSyncLabelTicker() {
  if (syncLabelIntervalId !== null) window.clearInterval(syncLabelIntervalId);
  syncLabelIntervalId = window.setInterval(updateSyncLabel, 60000);
}

function stopSyncLabelTicker() {
  if (syncLabelIntervalId !== null) {
    window.clearInterval(syncLabelIntervalId);
    syncLabelIntervalId = null;
  }
}

function setStatus(message: string, tone: "neutral" | "danger" = "neutral") {
  const target = document.querySelector<HTMLElement>("[data-status]");
  if (target) {
    target.innerHTML = message;
  }

  const syncStatus = document.querySelector<HTMLElement>("[data-sync-status]");
  if (syncStatus) {
    syncStatus.dataset.tone = tone;
  }
}

function renderSummary(prs: PullRequestSummary[]) {
  const counters = prs.reduce(
    (acc, pr) => {
      acc.total += 1;
      if (pr.hasStaleApproval) acc.stale += 1;
      if (pr.jiraPriority === "Highest" || pr.jiraPriority === "High") acc.hot += 1;
      return acc;
    },
    { total: 0, stale: 0, hot: 0 },
  );

  const target = document.querySelector<HTMLElement>("[data-summary]");
  if (!target) return;

  target.innerHTML = `
    <article class="metric-card">
      <span class="metric-label">Open PRs</span>
      <strong>${counters.total}</strong>
    </article>
    <article class="metric-card">
      <span class="metric-label">Stale approvals</span>
      <strong>${counters.stale}</strong>
    </article>
    <article class="metric-card">
      <span class="metric-label">High priority</span>
      <strong>${counters.hot}</strong>
    </article>
  `;
}

function renderIntegrations(snapshot: DashboardSnapshot) {
  const target = document.querySelector<HTMLElement>("[data-integrations]");
  if (!target) return;

  target.innerHTML = snapshot.integrations
    .map(
      (integration) => `
        <article class="integration-card integration-${integration.ok ? "ok" : "warn"}">
          <div class="integration-header">
            <span class="metric-label">${integration.name}</span>
            <span class="integration-pill">${integration.ok ? "Connected" : integration.configured ? "Attention" : "Not configured"}</span>
          </div>
          <strong>${integration.ok ? "Ready" : integration.configured ? "Needs attention" : "Setup needed"}</strong>
          <p>${integration.detail}</p>
        </article>
      `,
    )
    .join("");
}

function renderList(prs: PullRequestSummary[]) {
  const target = document.querySelector<HTMLElement>("[data-pr-list]");
  const emptyTarget = document.querySelector<HTMLElement>("[data-pr-empty]");
  if (!target) return;

  if (prs.length === 0) {
    target.innerHTML = "";
    emptyTarget?.removeAttribute("hidden");
    return;
  }

  emptyTarget?.setAttribute("hidden", "");

  target.innerHTML = prs
    .map(
      (pr) => {
        const isAging =
          Date.now() - Date.parse(pr.createdAtIso) > 14 * 24 * 60 * 60 * 1000;

        return `
        <article class="pr-card">
          <div class="pr-main">
            <div class="pr-header">
              <span class="repo-pill">${pr.repo} · #${pr.id}</span>
              <span class="repo-pill">${authorTypeLabel[pr.authorType]}</span>
              ${pr.jiraBoard ? `<span class="repo-pill">${pr.jiraBoard}</span>` : ""}
              ${isAging ? `<span class="warning-pill">Older than 2 weeks</span>` : ""}
              <span class="review-pill review-${pr.reviewState}">${reviewStateLabel[pr.reviewState]}</span>
            </div>
            <h2>${pr.title}</h2>
            <p class="jira-summary">${pr.jiraKey} · ${pr.jiraSummary}</p>
            <div class="pr-people">
              ${renderUserIdentity(pr.author, "Author", pr.authorAvatarUrl, "sm")}
              ${
                pr.pendingReviewers[0]
                  ? renderUserIdentity(
                      pr.pendingReviewers[0].login,
                      `Pending reviewer${pr.pendingReviewers.length > 1 ? ` +${pr.pendingReviewers.length - 1}` : ""}`,
                      pr.pendingReviewers[0].avatarUrl,
                      "sm",
                    )
                  : pr.currentApprovers[0]
                    ? renderUserIdentity(
                        pr.currentApprovers[0].login,
                        `Approved${pr.currentApprovers.length > 1 ? ` +${pr.currentApprovers.length - 1}` : ""}`,
                        pr.currentApprovers[0].avatarUrl,
                        "sm",
                      )
                    : ""
              }
            </div>
            <div class="pr-actions">
              <button class="secondary-button" data-pr-link="${pr.url}" type="button">
                Open PR
              </button>
              ${pr.jiraUrl ? `
                <button class="secondary-button" data-jira-link="${pr.jiraUrl}" type="button">
                  Open Jira
                </button>
              ` : ""}
            </div>
          </div>
          <dl class="pr-meta">
            <div><dt>Priority</dt><dd>${pr.jiraPriority}</dd></div>
            <div><dt>Release</dt><dd>${pr.jiraRelease}${pr.jiraReleaseDate ? `<span class="meta-subline">Due ${pr.jiraReleaseDate}</span>` : ""}</dd></div>
            <div><dt>Current reviewer</dt><dd>${pr.pendingReviewers.map((actor) => actor.login).join(", ") || "None pending"}</dd></div>
            <div><dt>Approvers</dt><dd>${pr.currentApprovers.map((actor) => actor.login).join(", ") || "None"}</dd></div>
            <div><dt>Stale approvers</dt><dd>${pr.staleApprovers.map((actor) => actor.login).join(", ") || "None"}</dd></div>
            <div><dt>Updated</dt><dd>${pr.updatedAt}</dd></div>
          </dl>
        </article>
      `;
      },
    )
    .join("");
}

function renderRepoSyncs(snapshot: DashboardSnapshot) {
  const panel = document.querySelector<HTMLElement>(".repo-sync-panel");
  const target = document.querySelector<HTMLElement>("[data-repo-syncs]");
  if (!panel || !target) return;

  panel.toggleAttribute("hidden", snapshot.repoSyncs.length === 0);
  target.innerHTML = snapshot.repoSyncs
    .map(
      (repoSync) => `
        <article class="repo-sync-card repo-sync-${repoSync.ok ? "ok" : "warn"}">
          <div class="integration-header">
            <span class="metric-label">${repoSync.repo}</span>
            <span class="integration-pill">${repoSync.ok ? "Loaded" : "Error"}</span>
          </div>
          <strong>${repoSync.prCount} open PRs</strong>
          <p>${repoSync.detail}</p>
        </article>
      `,
    )
    .join("");
}

function renderTokenStore(ts: TokenStoreStatus) {
  const target = document.querySelector<HTMLElement>("[data-token-store]");
  if (!target) return;

  const providerLabel: Record<string, string> = {
    keychain: "macOS Keychain",
    "credential-manager": "Windows Credential Manager",
    "secret-service": "Linux Secret Service",
    "fallback-file": "File fallback (DPAPI-encrypted on Windows)",
    "": "Unknown",
  };

  const storeLabel = providerLabel[ts.provider] ?? ts.provider;
  const storeOk = ts.providerOk;

  const tokenRow = (label: string, present: boolean) =>
    `<div class="token-store-row">
       <span class="token-store-label">${label}</span>
       <span class="token-store-badge token-store-badge-${present ? "ok" : "missing"}">
         ${present ? "Present" : "Missing"}
       </span>
     </div>`;

  const saveRow = () => {
    if (ts.lastSaveUsedVault === null) {
      return `<div class="token-store-row">
        <span class="token-store-label">Last save</span>
        <span class="token-store-badge token-store-badge-neutral">Not saved this session</span>
      </div>`;
    }
    return `<div class="token-store-row">
      <span class="token-store-label">Last save</span>
      <span class="token-store-badge token-store-badge-${ts.lastSaveUsedVault ? "ok" : "warn"}">
        ${ts.lastSaveUsedVault ? "System vault" : "File fallback"}
      </span>
    </div>`;
  };

  target.innerHTML = `
    <article class="integration-card integration-${storeOk ? "ok" : "warn"}">
      <div class="integration-header">
        <span class="metric-label">Token storage</span>
        <span class="integration-pill">${storeOk ? "Vault active" : "Fallback active"}</span>
      </div>
      <strong>${storeLabel}</strong>
      <div class="token-store-rows">
        ${tokenRow("GitHub token", ts.githubTokenPresent)}
        ${tokenRow("Jira token", ts.jiraTokenPresent)}
        ${saveRow()}
      </div>
      ${ts.providerDetail ? `<p>${ts.providerDetail}</p>` : ""}
    </article>
  `;
}

function renderWarnings(snapshot: DashboardSnapshot) {
  const target = document.querySelector<HTMLElement>("[data-warnings]");
  if (!target) return;

  const errors: string[] = [];

  // Repo sync failures with full error text
  for (const repo of snapshot.repoSyncs ?? []) {
    if (!repo.ok) {
      errors.push(`<strong>${repo.repo}</strong>: ${repo.detail}`);
    }
  }

  // Integration-level issues
  for (const integration of snapshot.integrations ?? []) {
    if (integration.configured && !integration.ok) {
      errors.push(`<strong>${integration.name}</strong>: ${integration.detail}`);
    }
  }

  // Generic warnings (catch-all, deduplicated)
  const alreadyShown = new Set(errors.map((e) => e.toLowerCase()));
  for (const warning of snapshot.warnings ?? []) {
    if (!alreadyShown.has(warning.toLowerCase())) {
      errors.push(warning);
    }
  }

  target.innerHTML = errors.map((e) => `<li class="warning-item">${e}</li>`).join("");
  target.parentElement?.toggleAttribute("hidden", errors.length === 0);
}

function renderSettings(values: SettingsFormValues) {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  if (!form) return;

  for (const [key, value] of Object.entries(values)) {
    const field = form.elements.namedItem(key);
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = value === "on";
    } else if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = value;
    }
  }

  notificationsEnabled = values.notificationsEnabled === "on";
  setSettingsDirtyState(false);
}

function collectSettingsForm(): SettingsFormValues {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  const formData = new FormData(form ?? undefined);
  const values = Object.fromEntries(formData.entries());
  return serializeSettingsForm(normalizeSettings(values as Partial<SettingsFormValues>));
}

function renderDashboard(snapshot: DashboardSnapshot) {
  currentDashboard = snapshot;
  const myPendingReviewIds = getMyPendingReviewIds(snapshot);
  const myChangesRequestedIds = getMyChangesRequestedIds(snapshot);
  const filteredPrs = applyListFilters(snapshot);
  renderSummary(snapshot.prs);
  renderIntegrations(snapshot);
  renderRepoSyncs(snapshot);
  renderTokenStore(snapshot.tokenStore);
  renderListFilters(snapshot);
  renderReviewerLoad(snapshot);
  renderListBoard(filteredPrs);
  renderWarnings(snapshot);

  const github = snapshot.integrations.find((integration) => integration.name === "github");
  lastSyncedAt = snapshot.refreshedAt;
  lastSyncSource = snapshot.source === "live" ? "live" : "mock";
  if (!github?.configured) {
    setStatus("Not configured", "danger");
  } else {
    updateSyncLabel();
    startSyncLabelTicker();
  }

  if (notificationsEnabled) {
    if (lastMyPendingReviewIds !== null) {
      const newReviews = countNewIds(myPendingReviewIds, lastMyPendingReviewIds);
      if (newReviews > 0) void notifyPendingReviewReminder(newReviews);
    }
    if (lastMyChangesRequestedIds.size > 0) {
      void notifyMyChangesRequested(countNewIds(myChangesRequestedIds, lastMyChangesRequestedIds));
    }
  }
  lastMyPendingReviewIds = myPendingReviewIds;
  lastMyChangesRequestedIds = myChangesRequestedIds;

  if (!github?.configured) {
    setView("settings");
  }
}

async function bootstrap() {
  setStatus("Loading local settings…");
  setListLoading(true);

  try {
    const payload = await invoke<DashboardBootstrap>("bootstrap");
    renderSettings(payload.settings);
    renderSecretStoreInfo(payload.secretStore);
    onlyMyPendingReviews = payload.listFilters.onlyMyPendingReviews;
    onlyMyPullRequests = payload.listFilters.onlyMyPullRequests;
    showInternalOnly = payload.listFilters.includeInternal;
    showCollaboratorOnly = payload.listFilters.includeCollaborator;
    groupByRelease = payload.listFilters.groupByRelease;
    showDraft = payload.listFilters.showDraft;
    hiddenRepos = payload.listFilters.hiddenRepos;
    currentAutoRefreshMinutes = Number.parseInt(payload.settings.autoRefreshMinutes, 10) || defaultSettings.autoRefreshMinutes;
    currentInternalMarker = payload.settings.internalAuthorMarker || defaultSettings.internalAuthorMarker;
    currentCollaborators = payload.settings.collaboratorGithubUsers
      .split("\n").map(s => s.trim()).filter(Boolean);
    configureAutoRefresh();
  } catch (error) {
    stopSyncLabelTicker();
    renderSettings(serializeSettingsForm(defaultSettings));
    setStatus(
      error instanceof Error ? error.message : "Unable to load settings.",
      "danger",
    );
    setSettingsNotice("Unable to load settings.", "danger");
    setListLoading(false);
    return;
  }

  // Settings are shown — now load dashboard data in the background.
  void refreshDashboard("auto");
}

async function saveSettingsAndRefresh(event: SubmitEvent) {
  event.preventDefault();
  setStatus("Saving settings locally and refreshing integrations…");
  settingsSaving = true;
  syncSettingsSaveButton();
  setSettingsNotice("Saving settings and refreshing data…", "info");
  setListLoading(true, "Refreshing pull requests…");

  try {
    const payload = await invoke<SaveSettingsResult>("save_settings", {
      params: collectSettingsForm(),
    });
    currentAutoRefreshMinutes =
      Number.parseInt(payload.settings.autoRefreshMinutes, 10) || defaultSettings.autoRefreshMinutes;
    currentInternalMarker = payload.settings.internalAuthorMarker || defaultSettings.internalAuthorMarker;
    currentCollaborators = payload.settings.collaboratorGithubUsers
      .split("\n").map(s => s.trim()).filter(Boolean);
    configureAutoRefresh();
    renderSettings(payload.settings);
    renderDashboard(payload.dashboard);
    setView("list");
    settingsSaving = false;
    syncSettingsSaveButton();
    setSettingsNotice(
      `Settings saved correctly at ${new Date().toLocaleTimeString()}.`,
      "success",
    );
    setListLoading(false);
    if (payload.dashboard.source === "live") {
      setStatus(`Settings saved. GitHub sync succeeded with ${payload.dashboard.prs.length} PRs.`, "neutral");
    }
  } catch (error) {
    stopSyncLabelTicker();
    settingsSaving = false;
    syncSettingsSaveButton();
    setStatus(
      error instanceof Error ? error.message : "Unable to save settings.",
      "danger",
    );
    setSettingsNotice(
      error instanceof Error ? error.message : "Unable to save settings.",
      "danger",
    );
    setListLoading(false);
  }
}

async function refreshDashboard(mode: "manual" | "auto" = "manual") {
  if (refreshInProgress) {
    if (mode === "manual") setStatus("Refresh already in progress…");
    return;
  }
  refreshInProgress = true;
  configureAutoRefresh(); // reset the countdown on every refresh
  setStatus(
    mode === "auto" ? "Auto-refreshing GitHub and Jira data…" : "Refreshing GitHub and Jira data…",
  );
  setListLoading(true, mode === "auto" ? "Auto-refreshing pull requests…" : "Refreshing pull requests…");

  try {
    const payload = await invoke<DashboardSnapshot>("refresh_dashboard");
    renderDashboard(payload);
    setListLoading(false);
  } catch (error) {
    stopSyncLabelTicker();
    setStatus(
      error instanceof Error ? error.message : "Unable to refresh dashboard.",
      "danger",
    );
    setListLoading(false);
  } finally {
    refreshInProgress = false;
  }
}

async function openExternal(url: string) {
  try {
    await invoke("open_external", { url });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to open the URL in the browser.",
      "danger",
    );
  }
}

async function rerequestReview(button: HTMLButtonElement) {
  const { repo, prNumber, login } = button.dataset as { repo: string; prNumber: string; login: string };
  if (!repo || !prNumber || !login) return;

  button.disabled = true;
  button.classList.add("review-badge-rerequest--loading");

  try {
    await invoke("request_review", { repo, prNumber: Number(prNumber), login });
    button.innerHTML = SVG.check;
    button.classList.remove("review-badge-rerequest--loading");
    button.classList.add("review-badge-rerequest--done");
    setTimeout(() => {
      applyOptimisticRerequest(repo, Number(prNumber), login);
    }, 2000);
  } catch (error) {
    button.disabled = false;
    button.classList.remove("review-badge-rerequest--loading");
    setStatus(
      error instanceof Error ? error.message : `Failed to re-request review from ${login}.`,
      "danger",
    );
  }
}

function applyOptimisticRerequest(repo: string, prNumber: number, login: string) {
  if (!currentDashboard) return;

  const pr = currentDashboard.prs.find((p) => p.repo === repo && p.id === prNumber);
  if (!pr) return;

  const actor = pr.blockingReviewers.find((a) => a.login === login);
  pr.blockingReviewers = pr.blockingReviewers.filter((a) => a.login !== login);
  if (actor && !pr.pendingReviewers.some((a) => a.login === login)) {
    pr.pendingReviewers = [...pr.pendingReviewers, actor];
  }

  const row = document.querySelector<HTMLElement>(`[data-pr-id="${repo}/${prNumber}"]`);
  if (!row) return;

  const isLast = row.nextElementSibling === null;
  const tmp = document.createElement("div");
  tmp.innerHTML = renderPRRow(pr, isLast, currentDashboard.viewerLogin);
  const newRow = tmp.firstElementChild;
  if (newRow) row.replaceWith(newRow);
}

window.addEventListener("DOMContentLoaded", () => {
  document
    .querySelector<HTMLFormElement>("[data-settings-form]")
    ?.addEventListener("submit", (event) => void saveSettingsAndRefresh(event));
  document
    .querySelector<HTMLFormElement>("[data-settings-form]")
    ?.addEventListener("input", () => {
      if (!settingsSaving) {
        setSettingsDirtyState(true);
      }
    });
  document
    .querySelector<HTMLButtonElement>("[data-refresh-button]")
    ?.addEventListener("click", () => void refreshDashboard());
  document
    .querySelector<HTMLButtonElement>("[data-github-token-link]")
    ?.addEventListener("click", () => void openExternal("https://github.com/settings/personal-access-tokens/new"));
  document
    .querySelector<HTMLButtonElement>("[data-jira-token-link]")
    ?.addEventListener("click", () => void openExternal("https://id.atlassian.com/manage-profile/security/api-tokens"));
  document
    .querySelector<HTMLInputElement>("[data-list-search]")
    ?.addEventListener("input", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      listSearchQuery = target.value.trim();
      if (currentDashboard) {
        renderListBoard(applyListFilters(currentDashboard));
      }
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-my-review-pending]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      onlyMyPendingReviews = target.checked;
      if (target.checked) onlyMyPullRequests = false;
      if (currentDashboard) {
        renderListFilters(currentDashboard);
        renderListBoard(applyListFilters(currentDashboard));
      }
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-my-prs]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      onlyMyPullRequests = target.checked;
      if (target.checked) onlyMyPendingReviews = false;
      if (currentDashboard) {
        renderListFilters(currentDashboard);
        renderListBoard(applyListFilters(currentDashboard));
      }
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-internal]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.checked && !showCollaboratorOnly) { target.checked = true; return; }
      showInternalOnly = target.checked;
      if (currentDashboard) renderListBoard(applyListFilters(currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-collaborator]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.checked && !showInternalOnly) { target.checked = true; return; }
      showCollaboratorOnly = target.checked;
      if (currentDashboard) renderListBoard(applyListFilters(currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-group-by-release]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      groupByRelease = target.checked;
      if (currentDashboard) renderListBoard(applyListFilters(currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-show-draft]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      showDraft = target.checked;
      if (currentDashboard) renderListBoard(applyListFilters(currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLElement>("[data-toolbar-repo-filters]")
    ?.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.matches("[data-toolbar-repo-toggle]")) return;

      const repo = target.value;
      hiddenRepos = target.checked
        ? hiddenRepos.filter((entry) => entry !== repo)
        : Array.from(new Set([...hiddenRepos, repo]));

      if (currentDashboard) {
        renderListBoard(applyListFilters(currentDashboard));
        renderToolbarRepoFilters(currentDashboard);
      }

      void persistListFilters();
    });
  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.viewTab;
      if (view === "status" || view === "list" || view === "settings") {
        setView(view);
      }
    });
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const prButton = target.closest<HTMLElement>("[data-pr-link]");
    const prUrl = prButton?.dataset.prLink;
    if (prUrl) { void openExternal(prUrl); return; }

    const jiraButton = target.closest<HTMLElement>("[data-jira-link]");
    const jiraUrl = jiraButton?.dataset.jiraLink;
    if (jiraUrl) { void openExternal(jiraUrl); return; }

    const rerequestButton = target.closest<HTMLButtonElement>(".review-badge-rerequest");
    if (rerequestButton) { void rerequestReview(rerequestButton); }
  });
  document
    .querySelector<HTMLButtonElement>("[data-discard-button]")
    ?.addEventListener("click", () => {
      setSettingsDirtyState(false);
    });

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const kbdHint = document.querySelector<HTMLElement>("[data-search-kbd]");
  if (kbdHint) kbdHint.textContent = isMac ? "⌘F" : "Ctrl+F";

  document.addEventListener("keydown", (e) => {
    if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      setView("list");
      document.querySelector<HTMLInputElement>("[data-list-search]")?.focus();
    }
  });

  syncSettingsSaveButton();
  setView(currentView);
  void bootstrap();
});
