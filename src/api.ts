import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { DashboardBootstrap, DashboardSnapshot, SaveSettingsResult } from "./shared/rpc";
import { defaultSettings, serializeSettingsForm } from "./shared/settings";
import { state } from "./state";
import {
  setStatus, setListLoading, setView,
  setSettingsNotice, syncSettingsSaveButton,
  stopSyncLabelTicker,
  renderDashboard, renderSettings, renderSecretStoreInfo,
  renderPRRow, collectSettingsForm,
} from "./render";
import { SVG } from "./utils";

// ── Auto-refresh ──────────────────────────────────────────────────────────────

export function configureAutoRefresh() {
  if (state.autoRefreshIntervalId !== null) {
    window.clearInterval(state.autoRefreshIntervalId);
    state.autoRefreshIntervalId = null;
  }
  if (state.currentAutoRefreshMinutes <= 0) return;
  state.autoRefreshIntervalId = window.setInterval(() => {
    void refreshDashboard("auto");
  }, state.currentAutoRefreshMinutes * 60 * 1000);
}

// ── Persist list filters ──────────────────────────────────────────────────────

export async function persistListFilters() {
  try {
    const saved = await invoke<{
      onlyMyPendingReviews: boolean;
      onlyMyPullRequests: boolean;
      includeInternal: boolean;
      includeTeam: boolean;
      includeCollaborator: boolean;
      groupByRelease: boolean;
      showDraft: boolean;
      hiddenRepos: string[];
    }>("save_list_filters", {
      params: {
        onlyMyPendingReviews: state.onlyMyPendingReviews,
        onlyMyPullRequests: state.onlyMyPullRequests,
        includeInternal: state.showInternalOnly,
        includeTeam: state.showTeamOnly,
        includeCollaborator: state.showCollaboratorOnly,
        groupByRelease: state.groupByRelease,
        showDraft: state.showDraft,
        hiddenRepos: state.hiddenRepos,
      },
    });
    state.onlyMyPendingReviews = saved.onlyMyPendingReviews;
    state.onlyMyPullRequests = saved.onlyMyPullRequests;
    state.showInternalOnly = saved.includeInternal;
    state.showTeamOnly = saved.includeTeam;
    state.showCollaboratorOnly = saved.includeCollaborator;
    state.groupByRelease = saved.groupByRelease;
    state.showDraft = saved.showDraft;
    state.hiddenRepos = saved.hiddenRepos;
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to save list filters.",
      "danger",
    );
  }
}

// ── Dashboard refresh ─────────────────────────────────────────────────────────

export async function refreshDashboard(mode: "manual" | "auto" = "manual") {
  if (state.refreshInProgress) {
    if (mode === "manual") setStatus("Refresh already in progress…");
    return;
  }
  state.refreshInProgress = true;
  const myId = ++state.refreshRequestId;
  configureAutoRefresh();
  setStatus(
    mode === "auto" ? "Auto-refreshing GitHub and Jira data…" : "Refreshing GitHub and Jira data…",
  );
  setListLoading(true, mode === "auto" ? "Auto-refreshing pull requests…" : "Refreshing pull requests…");

  try {
    const payload = await invoke<DashboardSnapshot>("refresh_dashboard");
    if (myId !== state.refreshRequestId) return;
    renderDashboard(payload);
    setListLoading(false);
  } catch (error) {
    if (myId !== state.refreshRequestId) return;
    stopSyncLabelTicker();
    setStatus(
      error instanceof Error ? error.message : "Unable to refresh dashboard.",
      "danger",
    );
    setListLoading(false);
  } finally {
    if (myId === state.refreshRequestId) state.refreshInProgress = false;
  }
}

// ── Settings save ─────────────────────────────────────────────────────────────

export async function saveSettingsAndRefresh(event: SubmitEvent) {
  event.preventDefault();
  setStatus("Saving settings locally and refreshing integrations…");
  state.settingsSaving = true;
  syncSettingsSaveButton();
  setSettingsNotice("Saving settings and refreshing data…", "info");
  setListLoading(true, "Refreshing pull requests…");

  try {
    const payload = await invoke<SaveSettingsResult>("save_settings", {
      params: collectSettingsForm(),
    });
    state.currentAutoRefreshMinutes =
      Number.parseInt(payload.settings.autoRefreshMinutes, 10) || defaultSettings.autoRefreshMinutes;
    state.currentInternalMarker = payload.settings.internalAuthorMarker || defaultSettings.internalAuthorMarker;
    state.currentCollaborators = payload.settings.teamMemberGithubUsers
      .split("\n").map(s => s.trim()).filter(Boolean);
    configureAutoRefresh();
    renderSettings(payload.settings);
    renderDashboard(payload.dashboard);
    if (payload.settings.notificationsEnabled === "on") void ensureNotificationPermission();
    setView("list");
    state.settingsSaving = false;
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
    state.settingsSaving = false;
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

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export async function bootstrap() {
  setStatus("Loading local settings…");
  setListLoading(true);

  try {
    const payload = await invoke<DashboardBootstrap>("bootstrap");
    renderSettings(payload.settings);
    renderSecretStoreInfo(payload.secretStore);
    state.onlyMyPendingReviews = payload.listFilters.onlyMyPendingReviews;
    state.onlyMyPullRequests = payload.listFilters.onlyMyPullRequests;
    state.showInternalOnly = payload.listFilters.includeInternal;
    state.showTeamOnly = payload.listFilters.includeTeam;
    state.showCollaboratorOnly = payload.listFilters.includeCollaborator;
    state.groupByRelease = payload.listFilters.groupByRelease;
    state.showDraft = payload.listFilters.showDraft;
    state.hiddenRepos = payload.listFilters.hiddenRepos;
    state.currentAutoRefreshMinutes = Number.parseInt(payload.settings.autoRefreshMinutes, 10) || defaultSettings.autoRefreshMinutes;
    state.currentInternalMarker = payload.settings.internalAuthorMarker || defaultSettings.internalAuthorMarker;
    state.currentCollaborators = payload.settings.teamMemberGithubUsers
      .split("\n").map(s => s.trim()).filter(Boolean);
    configureAutoRefresh();
    if (payload.settings.notificationsEnabled === "on") void ensureNotificationPermission();
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

  void refreshDashboard("auto");
  void checkForUpdate();
  startDailyMaintenance();
}

// ── Notifications permission ──────────────────────────────────────────────────

export async function ensureNotificationPermission() {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    if (!granted) {
      // OS denied notifications — disable in state so we stop trying on every refresh.
      state.notificationsEnabled = false;
      setStatus("Notification permission denied. Enable notifications for ZuGit in system settings.", "danger");
    }
  } catch {
    // Silently ignore — some platforms (older Windows) don't implement the permission API.
  }
}

// ── Daily maintenance (cache invalidation + update check) ─────────────────────

const DAILY_MAINTENANCE_KEY = "zugit:lastDailyMaintenance";
const ONE_DAY_MS = 12 * 60 * 60 * 1000;

async function runDailyMaintenance() {
  await Promise.all([
    invoke("invalidate_jira_cache").catch(() => {}),
    checkForUpdate(),
  ]);
  localStorage.setItem(DAILY_MAINTENANCE_KEY, Date.now().toString());
}

export function startDailyMaintenance() {
  const last = Number(localStorage.getItem(DAILY_MAINTENANCE_KEY) ?? "0");
  if (Date.now() - last >= ONE_DAY_MS) void runDailyMaintenance();
  window.setInterval(() => void runDailyMaintenance(), ONE_DAY_MS);
}

// ── Update check ──────────────────────────────────────────────────────────────

interface UpdateInfo {
  version: string;
  body: string | null;
}

export async function checkForUpdate() {
  try {
    const update = await invoke<UpdateInfo | null>("check_for_update");
    if (!update) return;

    const badge = document.querySelector<HTMLButtonElement>("[data-update-badge]");
    const label = badge?.querySelector<HTMLElement>("[data-update-badge-label]");
    if (!badge || !label) return;

    label.textContent = `v${update.version} available`;
    badge.hidden = false;

    badge.addEventListener("click", async () => {
      badge.classList.add("is-loading");
      badge.disabled = true;
      label.textContent = "Installing…";
      try {
        await invoke("install_update");
      } catch (err) {
        badge.classList.remove("is-loading");
        badge.disabled = false;
        label.textContent = `v${update.version} available`;
        // eslint-disable-next-line no-console
        console.error("Update install failed:", err);
      }
    }, { once: true });
  } catch {
    // Silently ignore: no internet, endpoint unavailable, etc.
  }
}

// ── Open external URL ─────────────────────────────────────────────────────────

export async function openExternal(url: string) {
  try {
    await invoke("open_external", { url });
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to open the URL in the browser.",
      "danger",
    );
  }
}

// ── Re-request review ─────────────────────────────────────────────────────────

export async function rerequestReview(button: HTMLButtonElement) {
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

export function applyOptimisticRerequest(repo: string, prNumber: number, login: string) {
  if (!state.currentDashboard) return;

  const pr = state.currentDashboard.prs.find((p) => p.repo === repo && p.id === prNumber);
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
  tmp.innerHTML = renderPRRow(pr, isLast, state.currentDashboard.viewerLogin);
  const newRow = tmp.firstElementChild;
  if (newRow) row.replaceWith(newRow);
}
