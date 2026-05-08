import { invoke } from "@tauri-apps/api/core";
import type { DashboardSnapshot, TokenStoreStatus } from "./shared/rpc";
import type { PullRequestSummary } from "./shared/pr-model";
import type { SettingsFormValues } from "./shared/settings";
import { normalizeSettings, serializeSettingsForm } from "./shared/settings";
import { state } from "./state";
import {
  escHtml, relativeTime, avatarColor, avatarSm, chip,
  SVG, formatDiffNum, diffSizeBucket, countNewIds,
  personLoadLevel, teamLoadLevel, loginInitials,
} from "./utils";
import {
  applyListFilters,
  countPendingReviewsForViewer, countMyChangesRequested,
  getMyPendingReviewIds, getMyChangesRequestedIds,
  getAvailableRepos,
} from "./filters";

// ── Status bar ────────────────────────────────────────────────────────────────

export function setStatus(message: string, tone: "neutral" | "danger" = "neutral") {
  const target = document.querySelector<HTMLElement>("[data-status]");
  if (target) {
    target.innerHTML = message;
  }
  const syncStatus = document.querySelector<HTMLElement>("[data-sync-status]");
  if (syncStatus) {
    syncStatus.dataset.tone = tone;
  }
}

// ── Sync label ticker ─────────────────────────────────────────────────────────

export function updateSyncLabel() {
  if (!state.lastSyncedAt) return;
  const message = state.lastSyncSource === "live"
    ? `Synced <strong>${relativeTime(state.lastSyncedAt)}</strong>`
    : `Sync failed · <strong>${relativeTime(state.lastSyncedAt)}</strong>`;
  setStatus(message, state.lastSyncSource === "live" ? "neutral" : "danger");
}

export function startSyncLabelTicker() {
  if (state.syncLabelIntervalId !== null) window.clearInterval(state.syncLabelIntervalId);
  state.syncLabelIntervalId = window.setInterval(updateSyncLabel, 60000);
}

export function stopSyncLabelTicker() {
  if (state.syncLabelIntervalId !== null) {
    window.clearInterval(state.syncLabelIntervalId);
    state.syncLabelIntervalId = null;
  }
}

// ── View switching ────────────────────────────────────────────────────────────

export function setView(view: "status" | "list" | "settings") {
  state.currentView = view;

  document.querySelectorAll<HTMLElement>("[data-view-panel]").forEach((panel) => {
    panel.toggleAttribute("hidden", panel.dataset.viewPanel !== view);
  });

  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach((tab) => {
    const isActive = tab.dataset.viewTab === view;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-pressed", String(isActive));
  });

  renderToolbarRepoFilters(state.currentDashboard);
}

// ── List loading indicator ────────────────────────────────────────────────────

export function setListLoading(isLoading: boolean, label = "Loading pull requests…") {
  const loading = document.querySelector<HTMLElement>("[data-list-loading]");
  const loadingLabel = document.querySelector<HTMLElement>("[data-list-loading-label]");
  const dashboardEmpty = document.querySelector<HTMLElement>("[data-pr-empty]");

  if (loading) loading.toggleAttribute("hidden", !isLoading);
  if (loadingLabel) loadingLabel.textContent = label;
  if (isLoading) dashboardEmpty?.setAttribute("hidden", "");
}

// ── Settings form ─────────────────────────────────────────────────────────────

export function setSettingsNotice(
  message: string,
  tone: "neutral" | "info" | "success" | "danger" = "neutral",
) {
  const target = document.querySelector<HTMLElement>("[data-settings-notice]");
  if (!target) return;
  target.innerHTML = message;
  target.dataset.tone = tone;
}

export function syncSettingsSaveButton() {
  const saveBar = document.querySelector<HTMLElement>("[data-save-bar]");
  const saveButton = document.querySelector<HTMLButtonElement>("[data-save-button]");
  const discardButton = document.querySelector<HTMLButtonElement>("[data-discard-button]");

  if (state.settingsSaving) {
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

  if (saveBar) saveBar.toggleAttribute("hidden", !state.settingsDirty);
}

export function setSettingsDirtyState(isDirty: boolean) {
  state.settingsDirty = isDirty;
  syncSettingsSaveButton();

  if (state.settingsSaving) return;

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

export function renderSecretStoreInfo(secretStore: {
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

export function renderSettings(values: SettingsFormValues) {
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

  state.notificationsEnabled = values.notificationsEnabled === "on";
  document.documentElement.toggleAttribute("data-colorblind", values.colorBlindMode === "on");
  setSettingsDirtyState(false);
}

export function collectSettingsForm(): SettingsFormValues {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  const formData = new FormData(form ?? undefined);
  const values = Object.fromEntries(formData.entries());
  return serializeSettingsForm(normalizeSettings(values as Partial<SettingsFormValues>));
}

// ── Toolbar repo filters ──────────────────────────────────────────────────────

export function renderToolbarRepoFilters(snapshot: DashboardSnapshot | null) {
  const container = document.querySelector<HTMLElement>("[data-toolbar-repo-filters]");
  const sep = document.querySelector<HTMLElement>("[data-repo-filter-sep]");
  if (!container) return;

  if (!snapshot || state.currentView !== "list") {
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
      const checked = !state.hiddenRepos.includes(repo);
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

// ── List filters panel ────────────────────────────────────────────────────────

export function renderListFilters(snapshot: DashboardSnapshot) {
  const searchInput = document.querySelector<HTMLInputElement>("[data-list-search]");
  const myReviewToggle = document.querySelector<HTMLInputElement>("[data-filter-my-review-pending]");
  const myPrsToggle = document.querySelector<HTMLInputElement>("[data-filter-my-prs]");
  const internalToggle = document.querySelector<HTMLInputElement>("[data-filter-internal]");
  const teamToggle = document.querySelector<HTMLInputElement>("[data-filter-team]");
  const collaboratorToggle = document.querySelector<HTMLInputElement>("[data-filter-collaborator]");
  const groupByReleaseToggle = document.querySelector<HTMLInputElement>("[data-filter-group-by-release]");
  const showDraftToggle = document.querySelector<HTMLInputElement>("[data-filter-show-draft]");
  const myReviewCountBadge = document.querySelector<HTMLElement>("[data-filter-my-review-count]");
  const myPrsCountBadge = document.querySelector<HTMLElement>("[data-filter-my-prs-count]");
  const myPendingReviewCount = countPendingReviewsForViewer(snapshot);
  const myChangesRequestedCount = countMyChangesRequested(snapshot);

  if (searchInput && searchInput.value !== state.listSearchQuery) {
    searchInput.value = state.listSearchQuery;
  }

  if (myReviewToggle) {
    myReviewToggle.checked = state.onlyMyPendingReviews;
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
    myPrsToggle.checked = state.onlyMyPullRequests;
    myPrsToggle.disabled = !snapshot.viewerLogin;
    myPrsToggle.title = snapshot.viewerLogin
      ? `Filter using ${snapshot.viewerLogin}`
      : "Unavailable until GitHub viewer info is loaded";
  }

  if (myPrsCountBadge) {
    myPrsCountBadge.textContent = `· ${myChangesRequestedCount} need action`;
    myPrsCountBadge.toggleAttribute("hidden", myChangesRequestedCount === 0);
  }

  if (internalToggle) internalToggle.checked = state.showInternalOnly;
  if (teamToggle) teamToggle.checked = state.showTeamOnly;
  if (collaboratorToggle) collaboratorToggle.checked = state.showCollaboratorOnly;
  if (groupByReleaseToggle) groupByReleaseToggle.checked = state.groupByRelease;
  if (showDraftToggle) showDraftToggle.checked = state.showDraft;

  renderToolbarRepoFilters(snapshot);
}

// ── PR row rendering ──────────────────────────────────────────────────────────

export function renderReviewBadges(pr: PullRequestSummary, viewerLogin?: string): string {
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

export function renderDiffStat(additions: number, deletions: number): string {
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

export function renderPRRow(pr: PullRequestSummary, isLast: boolean, viewerLogin?: string): string {
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
      : pr.authorType === "team"
        ? chip("neutral", "Team", `<span class="chip-dot"></span>`)
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
          <span style="font-size:13.5px;font-weight:600;color:var(--ink);letter-spacing:-0.1px;line-height:1.3">${escHtml(pr.title)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:${pr.jiraSummary ? "6" : "0"}px">
          ${avatarSm(pr.author, pr.authorAvatarUrl)}
          <span style="font-size:12px;color:var(--ink-soft);font-weight:500;font-family:var(--font-mono)">${escHtml(pr.author)}</span>
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

export function renderListTable(prs: PullRequestSummary[]) {
  const target = document.querySelector<HTMLElement>("[data-list-table]");
  if (!target) return;

  const viewerLogin = state.currentDashboard?.viewerLogin;

  if (prs.length === 0) {
    target.innerHTML = `<div class="list-empty">No pull requests available.</div>`;
    return;
  }

  if (!state.groupByRelease) {
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

export function renderListBoard(prs: PullRequestSummary[]) {
  renderListTable(prs);
}

// ── Reviewer load bar ─────────────────────────────────────────────────────────

export function renderReviewerLoad(snapshot: DashboardSnapshot) {
  const target = document.querySelector<HTMLElement>("[data-reviewer-load]");
  if (!target) return;

  if (state.currentCollaborators.length === 0) {
    target.hidden = true;
    target.innerHTML = "";
    return;
  }

  const pending = new Map<string, number>();
  const total   = new Map<string, number>();

  const collaboratorByLower = new Map(
    state.currentCollaborators.map(l => [l.toLowerCase(), l])
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

  const sorted = [...state.currentCollaborators].sort((a, b) => {
    const aIsMe = viewer && a.toLowerCase() === viewer ? 1 : 0;
    const bIsMe = viewer && b.toLowerCase() === viewer ? 1 : 0;
    if (aIsMe !== bIsMe) return aIsMe - bIsMe;
    return (pending.get(b) ?? 0) - (pending.get(a) ?? 0) ||
           (total.get(b)   ?? 0) - (total.get(a)   ?? 0);
  });

  const avatars = snapshot.reviewerAvatars ?? {};
  const stripMarker = (login: string) =>
    state.currentInternalMarker ? login.replace(state.currentInternalMarker, "") : login;

  const teamPending = sorted.reduce((s, l) => s + (pending.get(l) ?? 0), 0);
  const teamTotal   = sorted.reduce((s, l) => s + (total.get(l)   ?? 0), 0);

  const renderAvatar = (login: string) => {
    const url = avatars[login];
    const color = avatarColor(login);
    const initials = loginInitials(stripMarker(login));
    return `<span class="rlb__avatar" style="background:${color}">` +
      (url ? `<img src="${url}" alt="${login}" loading="lazy" />` : initials) +
      `</span>`;
  };

  const renderChip = (login: string) => {
    const isMe = viewer && login.toLowerCase() === viewer;
    const p = pending.get(login) ?? 0;
    const t = total.get(login)   ?? 0;
    const isEmpty = t === 0;
    const level = personLoadLevel(p);
    const name = isMe ? "you" : stripMarker(login);
    const tooltip = isEmpty
      ? "Nessuna PR assegnata. Buon candidato per nuove review."
      : `${p} da fare su ${t} totali`;
    const isActive = state.filteredReviewer?.toLowerCase() === login.toLowerCase();
    const classes = ["rlb__chip", isMe ? "rlb__chip--me" : "", isEmpty ? "rlb__chip--empty" : "", isActive ? "rlb__chip--active" : ""]
      .filter(Boolean).join(" ");
    return `<button class="${classes}" title="${tooltip}" data-reviewer-filter="${login}">` +
      renderAvatar(login) +
      `<span class="rlb__name">${name}</span>` +
      `<span class="rlb__nums">` +
        `<span class="rlb__num-strong rlb__num-strong--load-${level}">${p}</span>` +
        `<span class="rlb__num-sep">/</span>` +
        `<span class="rlb__num-total">${t}</span>` +
      `</span>` +
      `</button>`;
  };

  const meIndex = sorted.findIndex(l => viewer && l.toLowerCase() === viewer);
  const chips = sorted.map((login, i) =>
    (i === meIndex && meIndex > 0 ? `<span class="rlb__divider"></span>` : "") +
    renderChip(login)
  ).join("");

  target.hidden = false;
  target.innerHTML =
    `<div class="rlb__tag">` +
      `<span class="rlb__tag-dot"></span>` +
      `<span class="rlb__tag-label">Review load</span>` +
    `</div>` +
    `<div class="rlb__chips">${chips}</div>` +
    `<div class="rlb__team">` +
      `<span class="rlb__team-label">Team</span>` +
      `<span class="rlb__team-actionable rlb__team-actionable--load-${teamLoadLevel(teamPending)}">${teamPending}</span>` +
      `<span class="rlb__team-total">/ ${teamTotal}</span>` +
    `</div>`;
}

// ── Status panel ──────────────────────────────────────────────────────────────

export function renderSummary(prs: PullRequestSummary[]) {
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

export function renderIntegrations(snapshot: DashboardSnapshot) {
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

export function renderRepoSyncs(snapshot: DashboardSnapshot) {
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

export function renderTokenStore(ts: TokenStoreStatus) {
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

export function renderWarnings(snapshot: DashboardSnapshot) {
  const target = document.querySelector<HTMLElement>("[data-warnings]");
  if (!target) return;

  const errors: string[] = [];

  for (const repo of snapshot.repoSyncs ?? []) {
    if (!repo.ok) {
      errors.push(`<strong>${repo.repo}</strong>: ${repo.detail}`);
    }
  }

  for (const integration of snapshot.integrations ?? []) {
    if (integration.configured && !integration.ok) {
      errors.push(`<strong>${integration.name}</strong>: ${integration.detail}`);
    }
  }

  const alreadyShown = new Set(errors.map((e) => e.toLowerCase()));
  for (const warning of snapshot.warnings ?? []) {
    if (!alreadyShown.has(warning.toLowerCase())) {
      errors.push(warning);
    }
  }

  target.innerHTML = errors.map((e) => `<li class="warning-item">${e}</li>`).join("");
  target.parentElement?.toggleAttribute("hidden", errors.length === 0);
}

// ── Notifications ─────────────────────────────────────────────────────────────

export async function notifyPendingReviewReminder(pendingReviewCount: number) {
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

export async function notifyMyChangesRequested(newChangesRequestedCount: number) {
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

// ── Full dashboard render ─────────────────────────────────────────────────────

export function renderDashboard(snapshot: DashboardSnapshot) {
  state.currentDashboard = snapshot;
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
  state.lastSyncedAt = snapshot.refreshedAt;
  state.lastSyncSource = snapshot.source === "live" ? "live" : "mock";
  if (!github?.configured) {
    setStatus("Not configured", "danger");
  } else {
    updateSyncLabel();
    startSyncLabelTicker();
  }

  if (state.notificationsEnabled) {
    if (state.lastMyPendingReviewIds !== null) {
      const newReviews = countNewIds(myPendingReviewIds, state.lastMyPendingReviewIds);
      if (newReviews > 0) void notifyPendingReviewReminder(newReviews);
    }
    if (state.lastMyChangesRequestedIds.size > 0) {
      void notifyMyChangesRequested(countNewIds(myChangesRequestedIds, state.lastMyChangesRequestedIds));
    }
  }
  state.lastMyPendingReviewIds = myPendingReviewIds;
  state.lastMyChangesRequestedIds = myChangesRequestedIds;

  if (!github?.configured) {
    setView("settings");
  }
}
