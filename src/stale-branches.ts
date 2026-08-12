import { invoke } from "@tauri-apps/api/core";
import type { StaleBranch, StaleBranchesResult } from "./shared/rpc";
import { state } from "./state";
import { escHtml, avatarSm, errorMessage, SVG } from "./utils";
import { getAvailableRepos } from "./filters";

// Remote branches with no open PR that nobody has pushed to in a while: branches
// someone opened and forgot. The scan walks every branch of every configured
// repo, so it runs on demand — opening the tab, or hitting Refresh — and never
// as part of the dashboard auto-refresh.

const ONLY_MINE_KEY = "zugit:staleOnlyMine";
const GROUP_BY_AUTHOR_KEY = "zugit:staleGroupByAuthor";
const SHOW_INTERNAL_KEY = "zugit:staleShowInternal";
const SHOW_COLLABORATOR_KEY = "zugit:staleShowCollaborator";

export function restoreStaleFilters() {
  state.staleOnlyMine = localStorage.getItem(ONLY_MINE_KEY) === "1";
  state.staleGroupByAuthor = localStorage.getItem(GROUP_BY_AUTHOR_KEY) === "1";
  // Absent key = first run: keep the defaults (internal on, collaborator off).
  const internal = localStorage.getItem(SHOW_INTERNAL_KEY);
  const collaborator = localStorage.getItem(SHOW_COLLABORATOR_KEY);
  if (internal !== null) state.staleShowInternal = internal === "1";
  if (collaborator !== null) state.staleShowCollaborator = collaborator === "1";
}

/**
 * Applies an author-type filter, refusing the change that would untick the last
 * one — an empty list with every filter off reads as "no stale branches".
 * Returns whether the change was kept.
 */
export function setStaleAuthorType(type: "internal" | "collaborator", show: boolean): boolean {
  const other = type === "internal" ? state.staleShowCollaborator : state.staleShowInternal;
  if (!show && !other) {
    renderStaleBranches();
    return false;
  }

  if (type === "internal") {
    state.staleShowInternal = show;
    localStorage.setItem(SHOW_INTERNAL_KEY, show ? "1" : "0");
  } else {
    state.staleShowCollaborator = show;
    localStorage.setItem(SHOW_COLLABORATOR_KEY, show ? "1" : "0");
  }
  renderStaleBranches();
  return true;
}

export function setStaleOnlyMine(onlyMine: boolean) {
  state.staleOnlyMine = onlyMine;
  localStorage.setItem(ONLY_MINE_KEY, onlyMine ? "1" : "0");
  renderStaleBranches();
}

export function setStaleGroupByAuthor(groupByAuthor: boolean) {
  state.staleGroupByAuthor = groupByAuthor;
  localStorage.setItem(GROUP_BY_AUTHOR_KEY, groupByAuthor ? "1" : "0");
  renderStaleBranches();
}

/**
 * The repositories the toolbar selector currently keeps visible — the same set
 * the PR list works on. `null` means the dashboard has not loaded yet, so the
 * selection is unknown and the backend falls back to every configured repo.
 */
function activeRepos(): string[] | null {
  const snapshot = state.currentDashboard;
  if (!snapshot) return null;
  return getAvailableRepos(snapshot).filter((repo) => !state.hiddenRepos.includes(repo));
}

function sameRepos(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((repo, i) => repo === b[i]);
}

/**
 * Loads the scan, reusing the previous result unless `force` is set — or unless
 * the repository selection changed since, which makes the cache wrong rather
 * than merely old.
 */
export async function loadStaleBranches(force = false) {
  if (state.staleLoading) return;

  const repos = activeRepos();
  if (!force && state.staleBranches && sameRepos(repos, state.staleScannedRepos)) return;

  // Every repo hidden: scanning nothing would render as "nothing to clean up".
  if (repos !== null && repos.length === 0) {
    state.staleBranches = null;
    state.staleError = null;
    state.staleScannedRepos = repos;
    state.staleNotice = "No repository selected — pick at least one from the repositories selector.";
    renderStaleBranches();
    return;
  }

  state.staleLoading = true;
  state.staleError = null;
  state.staleNotice = null;
  renderStaleBranches();

  try {
    state.staleBranches = await invoke<StaleBranchesResult>("fetch_stale_branches", {
      activeRepos: repos,
    });
    state.staleScannedRepos = repos;
  } catch (error) {
    state.staleBranches = null;
    state.staleScannedRepos = null;
    state.staleError = errorMessage(error, "Unable to scan the branches.");
  } finally {
    state.staleLoading = false;
    renderStaleBranches();
  }
}

function matchingAuthorType(result: StaleBranchesResult): StaleBranch[] {
  return result.branches.filter((branch) =>
    branch.authorType === "internal"
      ? state.staleShowInternal
      : state.staleShowCollaborator,
  );
}

/** The age in days is already on the row, so the second line carries the date. */
function commitDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
}

function authorName(branch: StaleBranch): string {
  return branch.authorLogin || branch.authorName || "unknown";
}

/**
 * Branches keyed by the author of their last commit, both the groups and the
 * branches inside them ascending by last commit: `branches` is already in that
 * order, so first appearance orders the groups by their oldest branch.
 */
function groupByAuthor(branches: StaleBranch[]): Map<string, StaleBranch[]> {
  const groups = new Map<string, StaleBranch[]>();
  for (const branch of branches) {
    const key = authorName(branch);
    const group = groups.get(key);
    if (group) group.push(branch);
    else groups.set(key, [branch]);
  }
  return groups;
}

function renderGroupHeader(name: string, branches: StaleBranch[]): string {
  const oldest = branches[0];
  const avatar = avatarSm(name, oldest.authorAvatarUrl || undefined);
  return `<div class="stale-group-header">
    ${avatar}
    <span class="stale-group-name">${escHtml(name)}</span>
    <span class="stale-group-count">${branches.length} branch${branches.length === 1 ? "" : "es"}</span>
    <span class="stale-group-oldest">oldest ${oldest.ageDays} d</span>
  </div>`;
}

function renderRow(branch: StaleBranch): string {
  const displayName = authorName(branch);
  const avatar = avatarSm(displayName, branch.authorAvatarUrl || undefined);

  return `<div class="stale-row" data-stale-open="${escHtml(branch.url)}" role="button" tabindex="0">
    <div class="stale-row-main">
      <div class="stale-row-title">
        <span class="stale-branch-icon">${SVG.gitpr}</span>
        <span class="stale-branch-name">${escHtml(branch.branch)}</span>
        <span class="stale-repo">${escHtml(branch.repo)}</span>
      </div>
      <div class="stale-row-commit">
        ${escHtml(branch.lastCommitMessage || "(no commit message)")}
      </div>
    </div>
    <div class="stale-row-author">
      ${avatar}
      <span class="stale-author-name">${escHtml(displayName)}</span>
    </div>
    <div class="stale-row-age">
      <span class="stale-age-days">${branch.ageDays} d</span>
      <span class="stale-age-rel">${escHtml(commitDate(branch.lastCommitAt))}</span>
    </div>
    <span class="stale-row-ext">${SVG.ext}</span>
  </div>`;
}

export function renderStaleBranches() {
  const list = document.querySelector<HTMLElement>("[data-stale-list]");
  const summary = document.querySelector<HTMLElement>("[data-stale-summary]");
  const warnings = document.querySelector<HTMLElement>("[data-stale-warnings]");
  const refreshButton = document.querySelector<HTMLButtonElement>("[data-stale-refresh]");
  if (!list || !summary || !warnings) return;

  document.querySelectorAll<HTMLButtonElement>("[data-stale-scope]").forEach((button) => {
    const isActive = (button.dataset.staleScope === "mine") === state.staleOnlyMine;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  const groupToggle = document.querySelector<HTMLInputElement>("[data-stale-group-by-author]");
  if (groupToggle) groupToggle.checked = state.staleGroupByAuthor;
  const internalToggle = document.querySelector<HTMLInputElement>("[data-stale-filter-internal]");
  if (internalToggle) internalToggle.checked = state.staleShowInternal;
  const collaboratorToggle =
    document.querySelector<HTMLInputElement>("[data-stale-filter-collaborator]");
  if (collaboratorToggle) collaboratorToggle.checked = state.staleShowCollaborator;
  if (refreshButton) refreshButton.disabled = state.staleLoading;
  list.classList.toggle("stale-list--grouped", state.staleGroupByAuthor);

  if (state.staleLoading) {
    summary.textContent = "Scanning the branches of every configured repository…";
    list.innerHTML = `<div class="stale-empty">This takes a few seconds on repositories with many branches.</div>`;
    warnings.hidden = true;
    return;
  }

  if (state.staleError) {
    summary.textContent = "";
    list.innerHTML = `<div class="stale-empty stale-empty--danger">${escHtml(state.staleError)}</div>`;
    warnings.hidden = true;
    return;
  }

  if (state.staleNotice) {
    summary.textContent = "";
    list.innerHTML = `<div class="stale-empty">${escHtml(state.staleNotice)}</div>`;
    warnings.hidden = true;
    return;
  }

  const result = state.staleBranches;
  if (!result) {
    summary.textContent = "";
    list.innerHTML = `<div class="stale-empty">Nothing scanned yet.</div>`;
    warnings.hidden = true;
    return;
  }

  const byAuthorType = matchingAuthorType(result);
  const branches = state.staleOnlyMine ? byAuthorType.filter((b) => b.isMine) : byAuthorType;
  const mineCount = byAuthorType.filter((b) => b.isMine).length;

  const repoCount = state.staleScannedRepos?.length;
  summary.innerHTML = `<strong>${branches.length}</strong> branch${branches.length === 1 ? "" : "es"}
    with no open PR, untouched for more than ${result.staleDays} days`
    + (state.staleOnlyMine ? "" : ` · <strong>${mineCount}</strong> of them yours`)
    // The scan follows the toolbar's repository selector, so say what it covered.
    + (repoCount ? ` · across <strong>${repoCount}</strong> selected repositor${repoCount === 1 ? "y" : "ies"}` : "");

  if (result.warnings.length > 0) {
    warnings.hidden = false;
    warnings.innerHTML = result.warnings.map((w) => `<li>${escHtml(w)}</li>`).join("");
  } else {
    warnings.hidden = true;
    warnings.innerHTML = "";
  }

  if (branches.length === 0) {
    // Saying "nothing to clean up" would be a lie when a filter is doing the hiding.
    let message = "No stale branches — nothing to clean up.";
    if (result.branches.length > 0) {
      message = state.staleOnlyMine && mineCount === 0 && byAuthorType.length > 0
        ? "None of your branches are stale. Switch to <strong>Everyone</strong> to see the rest."
        : "No branch matches the current filters.";
    }
    list.innerHTML = `<div class="stale-empty">${message}</div>`;
    return;
  }

  if (!state.staleGroupByAuthor) {
    list.innerHTML = branches.map(renderRow).join("");
    return;
  }

  list.innerHTML = [...groupByAuthor(branches).entries()]
    .map(([name, group]) => `<div class="stale-group">
      ${renderGroupHeader(name, group)}
      ${group.map(renderRow).join("")}
    </div>`)
    .join("");
}
