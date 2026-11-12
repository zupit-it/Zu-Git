import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { DashboardBootstrap, DashboardSnapshot, SaveSettingsResult } from "./shared/rpc";
import { defaultSettings, serializeSettingsForm } from "./shared/settings";
import { state } from "./state";
import { showUpdateNotes } from "./changelog";
import {
  setStatus, setListLoading, setView,
  setSettingsNotice, syncSettingsSaveButton,
  stopSyncLabelTicker,
  renderDashboard, renderSettings, renderSecretStoreInfo,
  collectSettingsForm, redrawList, settlePendingChanges,
} from "./render";
import { errorMessage } from "./utils";
import {
  nextPendingRead, pendingChange, reviewAskedOf, withPending,
  type PendingKind, type PendingOptions,
} from "./pending-changes";
import { processMergeQueue } from "./merge-queue";

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
      errorMessage(error, "Unable to save list filters."),
      "danger",
    );
  }
}

// ── Dashboard refresh ─────────────────────────────────────────────────────────

/**
 * A refresh asked for after a change on GitHub while one was already running:
 * the running one may have read GitHub before the change, so one more follows.
 */
let refreshAgain = false;

/**
 * `manual` from the Refresh button, `auto` from the timer and at start-up,
 * `after-change` after ZuGit wrote to GitHub: that one is never lost to a
 * refresh already in flight.
 */
export async function refreshDashboard(mode: "manual" | "auto" | "after-change" = "manual") {
  if (state.refreshInProgress) {
    if (mode === "manual") setStatus("Refresh already in progress…");
    if (mode === "after-change") refreshAgain = true;
    return;
  }
  state.refreshInProgress = true;
  const myId = ++state.refreshRequestId;
  configureAutoRefresh();
  // After a change, the status still says what was just done.
  if (mode !== "after-change") {
    setStatus(mode === "auto" ? "Auto-refreshing GitHub and Jira data…" : "Refreshing GitHub and Jira data…");
  }
  setListLoading(true, mode === "auto" ? "Auto-refreshing pull requests…" : "Refreshing pull requests…");

  const readAt = Date.now();
  let landed = false;
  try {
    const payload = await invoke<DashboardSnapshot>("refresh_dashboard");
    if (myId !== state.refreshRequestId) return;
    state.dashboardReadAt = readAt;
    renderDashboard(payload);
    landed = true;
    setListLoading(false);
    if (state.mergeQueueEnabled) void processMergeQueue(payload);
    // The Sprint tab shows PR state on its cards: tell it there is a new snapshot.
    window.dispatchEvent(new CustomEvent("zugit:dashboard"));
  } catch (error) {
    if (myId !== state.refreshRequestId) return;
    stopSyncLabelTicker();
    setStatus(
      errorMessage(error, "Unable to refresh dashboard."),
      "danger",
    );
    setListLoading(false);
  } finally {
    if (myId === state.refreshRequestId) {
      state.refreshInProgress = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refreshDashboard("after-change");
      } else {
        followPendingChanges(landed);
      }
    }
  }
}

// ── Changes made from ZuGit, until GitHub shows them ─────────────────────────

let followUpTimer = 0;
let giveUpTimer = 0;

/**
 * ZuGit just changed a PR on GitHub. Its row draws the change at once, as
 * waiting, over what GitHub last said (pending-changes.ts) — the snapshot
 * itself is never edited — and GitHub is read for it: now, or in `readIn` ms
 * when it needs a moment. A read is a whole refresh and counts against the
 * token's hourly limit, so there is one, as there always was after a change,
 * and one more only if it does not show the change.
 */
export function trackGitHubChange(pr: { repo: string; id: number }, kind: PendingKind, options: PendingOptions) {
  const known = state.currentDashboard?.prs.find((p) => p.repo === pr.repo && p.id === pr.id);
  if (known) {
    state.pendingChanges = withPending(state.pendingChanges, pendingChange(known, kind, options, Date.now()));
    redrawList();
    watchPendingTime();
  }
  window.clearTimeout(followUpTimer);
  if (options.readIn) followUpTimer = window.setTimeout(() => void refreshDashboard("after-change"), options.readIn);
  else void refreshDashboard("after-change");
}

/**
 * After a read that landed: a change it did not show gets its second and last
 * read a while later, and one whose first read is still due keeps its time.
 * A read that failed is not tried again from here: the next refresh, by the
 * timer or by hand, takes over.
 */
function followPendingChanges(landed: boolean) {
  watchPendingTime();
  if (!landed) return;
  window.clearTimeout(followUpTimer);
  const wait = nextPendingRead(state.pendingChanges, Date.now());
  if (wait !== null) followUpTimer = window.setTimeout(() => void refreshDashboard("after-change"), wait);
}

/** With no read landing at all, a change is still given up when its time is over: a timer, no request. */
function watchPendingTime() {
  window.clearTimeout(giveUpTimer);
  if (state.pendingChanges.length === 0) return;
  const due = Math.min(...state.pendingChanges.map((change) => change.expiresAt)) - Date.now();
  giveUpTimer = window.setTimeout(() => {
    const { changed, message } = settlePendingChanges(state.currentDashboard?.prs ?? [], 0);
    if (changed) redrawList();
    if (message) setStatus(message);
    watchPendingTime();
  }, Math.max(0, due) + 50);
}

// ── Settings save ─────────────────────────────────────────────────────────────

export async function saveSettingsAndRefresh(event: SubmitEvent) {
  event.preventDefault();
  setStatus("Saving settings locally and refreshing integrations…");
  state.settingsSaving = true;
  syncSettingsSaveButton();
  setSettingsNotice("Saving settings and refreshing data…", "info");
  setListLoading(true, "Refreshing pull requests…");

  const readAt = Date.now();
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
    state.dashboardReadAt = readAt;
    renderDashboard(payload.dashboard);
    if (state.mergeQueueEnabled) void processMergeQueue(payload.dashboard);
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
      errorMessage(error, "Unable to save settings."),
      "danger",
    );
    setSettingsNotice(
      errorMessage(error, "Unable to save settings."),
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
      errorMessage(error, "Unable to load settings."),
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

    // Show what is in the release before installing it, rather than restarting
    // the app on a single click.
    badge.addEventListener("click", () => showUpdateNotes(update.version, update.body));
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
      errorMessage(error, "Unable to open the URL in the browser."),
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
  } catch (error) {
    button.disabled = false;
    button.classList.remove("review-badge-rerequest--loading");
    setStatus(
      errorMessage(error, `Failed to re-request review from ${login}.`),
      "danger",
    );
    return;
  }
  // Asked again, they await a review whatever they said before — as GitHub's
  // Reviewers list shows them. The row says so until GitHub does.
  trackGitHubChange({ repo, id: Number(prNumber) }, "review-request", {
    subject: login,
    label: `Review asked again of ${login}`,
    patch: reviewAskedOf(login),
  });
}
