import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { DashboardBootstrap, DashboardSnapshot, SaveSettingsResult } from "./shared/rpc";
import type { PullRequestSummary } from "./shared/pr-model";
import { defaultSettings, serializeSettingsForm } from "./shared/settings";
import { state } from "./state";
import { showUpdateNotes } from "./changelog";
import {
  setStatus, setListLoading, setView,
  setSettingsNotice, syncSettingsSaveButton,
  stopSyncLabelTicker,
  renderDashboard, renderSettings, renderSecretStoreInfo,
  collectSettingsForm, redrawList, redrawPullRequests, settlePendingChanges,
} from "./render";
import { errorMessage, escHtml } from "./utils";
import {
  duePendingPrs, pendingChange, reviewAskedOf, withAnswer, withPending, withoutOwnRead,
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
  try {
    const payload = withNewerAnswers(await invoke<DashboardSnapshot>("refresh_dashboard"), readAt);
    if (myId !== state.refreshRequestId) return;
    state.dashboardReadAt = readAt;
    renderDashboard(payload);
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
        followPendingChanges();
      }
    }
  }
}

// ── Changes made from ZuGit, until GitHub shows them ─────────────────────────

/** PRs being read on their own right now, by `repo/id`. */
const reading = new Set<string>();
let pendingTimer = 0;

/**
 * ZuGit just changed a PR on GitHub. Its row draws the change at once, as
 * waiting, over what GitHub last said (pending-changes.ts) — the snapshot is
 * never edited by a guess — and GitHub is asked for that PR alone: now, or in
 * `readIn` ms when it needs a moment. One point of the token's hourly limit,
 * where a refresh of the list costs three per repository; and once more only
 * if that answer does not show the change.
 */
export function trackGitHubChange(pr: { repo: string; id: number }, kind: PendingKind, options: PendingOptions) {
  const known = state.currentDashboard?.prs.find((p) => p.repo === pr.repo && p.id === pr.id);
  if (!known) {
    // Not a PR of the list (yet): there is no row to keep true, and only a refresh can bring one.
    void refreshDashboard("after-change");
    return;
  }
  state.pendingChanges = withPending(state.pendingChanges, pendingChange(known, kind, options, Date.now()));
  redrawList();
  followPendingChanges();
}

/**
 * Reads the PRs whose change is due its read, each on its own, and comes back
 * when the next is due or a change's time is over. Called after anything that
 * may have moved them: a change, an answer, a refresh.
 */
function followPendingChanges() {
  window.clearTimeout(pendingTimer);
  if (state.pendingChanges.length === 0) return;
  // Time over with no answer to say so (GitHub out of reach): the rows are GitHub's again.
  const { changed, message } = settlePendingChanges();
  if (changed) redrawList();
  if (message) setStatus(message);

  const now = Date.now();
  for (const key of duePendingPrs(state.pendingChanges, now)) {
    if (!reading.has(key)) void readPullRequest(key);
  }
  const waits = state.pendingChanges
    .flatMap((change) => [reading.has(change.pr) ? Infinity : change.readAt - now, change.expiresAt - now])
    .filter(Number.isFinite);
  if (waits.length) pendingTimer = window.setTimeout(followPendingChanges, Math.max(50, Math.min(...waits)));
}

/** Asks GitHub for one PR as the list has it, and takes its answer for that PR's row. */
async function readPullRequest(key: string) {
  const slash = key.lastIndexOf("/");
  reading.add(key);
  const askedAt = Date.now();
  try {
    const pr = await invoke<PullRequestSummary | null>("fetch_pull_request", {
      repo: key.slice(0, slash), number: Number(key.slice(slash + 1)),
    });
    reading.delete(key);
    takeAnswer(key, pr, askedAt);
  } catch {
    reading.delete(key);
    // GitHub out of reach: not asked again from here. The next refresh, by the timer or by hand, takes over.
    state.pendingChanges = withoutOwnRead(state.pendingChanges, key);
    setStatus(`GitHub did not answer for ${escHtml(key.slice(0, slash))}#${key.slice(slash + 1)}: its row waits for the next refresh.`);
  }
  followPendingChanges();
}

/**
 * GitHub's answer for one PR, asked for at `askedAt`: it takes that PR's place
 * in the snapshot (or takes it out, when it is no longer open) — GitHub's own
 * newer word, not an edit — unless the snapshot was asked for later still.
 */
function takeAnswer(key: string, pr: PullRequestSummary | null, askedAt: number) {
  const snapshot = state.currentDashboard;
  if (!snapshot || askedAt < state.dashboardReadAt) return;
  if ((state.prAnswers.get(key)?.askedAt ?? 0) > askedAt) return;
  state.prAnswers.set(key, { askedAt, pr });
  state.currentDashboard = { ...snapshot, prs: withAnswer(snapshot.prs, key, pr) };
  const { message } = settlePendingChanges();
  redrawPullRequests();
  if (message) setStatus(message);
  // The Sprint tab and an open popover follow the list.
  window.dispatchEvent(new CustomEvent("zugit:dashboard"));
}

/**
 * A snapshot asked for at `askedAt`, with GitHub's newer answer in place of
 * each PR read on its own since: a refresh that was already on its way cannot
 * put an older PR back. Answers the snapshot has caught up with are forgotten.
 */
function withNewerAnswers(snapshot: DashboardSnapshot, askedAt: number): DashboardSnapshot {
  let prs = snapshot.prs;
  for (const [key, answer] of state.prAnswers) {
    if (answer.askedAt > askedAt) prs = withAnswer(prs, key, answer.pr);
    else state.prAnswers.delete(key);
  }
  return prs === snapshot.prs ? snapshot : { ...snapshot, prs };
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
    const dashboard = withNewerAnswers(payload.dashboard, readAt);
    state.dashboardReadAt = readAt;
    renderDashboard(dashboard);
    if (state.mergeQueueEnabled) void processMergeQueue(dashboard);
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
