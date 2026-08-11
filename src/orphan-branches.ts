import { invoke } from "@tauri-apps/api/core";
import type { OrphanBranch, OrphanBranchesResult } from "./shared/rpc";
import { state } from "./state";
import { escHtml, avatarSm, errorMessage, SVG } from "./utils";
import { getAvailableRepos } from "./filters";

// Remote branches with no open PR that nobody has pushed to in a while: branches
// someone opened and forgot. The scan walks every branch of every configured
// repo, so it runs on demand — opening the tab, or hitting Refresh — and never
// as part of the dashboard auto-refresh.

const ONLY_MINE_KEY = "zugit:orphanOnlyMine";
const GROUP_BY_AUTHOR_KEY = "zugit:orphanGroupByAuthor";
const SHOW_INTERNAL_KEY = "zugit:orphanShowInternal";
const SHOW_COLLABORATOR_KEY = "zugit:orphanShowCollaborator";

export function restoreOrphanFilter() {
  state.orphanOnlyMine = localStorage.getItem(ONLY_MINE_KEY) === "1";
  state.orphanGroupByAuthor = localStorage.getItem(GROUP_BY_AUTHOR_KEY) === "1";
  // Absent key = first run: keep the defaults (internal on, collaborator off).
  const internal = localStorage.getItem(SHOW_INTERNAL_KEY);
  const collaborator = localStorage.getItem(SHOW_COLLABORATOR_KEY);
  if (internal !== null) state.orphanShowInternal = internal === "1";
  if (collaborator !== null) state.orphanShowCollaborator = collaborator === "1";
}

/**
 * Applies an author-type filter, refusing the change that would untick the last
 * one — an empty list with every filter off reads as "no stale branches".
 * Returns whether the change was kept.
 */
export function setOrphanAuthorType(type: "internal" | "collaborator", show: boolean): boolean {
  const other = type === "internal" ? state.orphanShowCollaborator : state.orphanShowInternal;
  if (!show && !other) {
    renderOrphanBranches();
    return false;
  }

  if (type === "internal") {
    state.orphanShowInternal = show;
    localStorage.setItem(SHOW_INTERNAL_KEY, show ? "1" : "0");
  } else {
    state.orphanShowCollaborator = show;
    localStorage.setItem(SHOW_COLLABORATOR_KEY, show ? "1" : "0");
  }
  renderOrphanBranches();
  return true;
}

export function setOrphanOnlyMine(onlyMine: boolean) {
  state.orphanOnlyMine = onlyMine;
  localStorage.setItem(ONLY_MINE_KEY, onlyMine ? "1" : "0");
  renderOrphanBranches();
}

export function setOrphanGroupByAuthor(groupByAuthor: boolean) {
  state.orphanGroupByAuthor = groupByAuthor;
  localStorage.setItem(GROUP_BY_AUTHOR_KEY, groupByAuthor ? "1" : "0");
  renderOrphanBranches();
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
export async function loadOrphanBranches(force = false) {
  if (state.orphanLoading) return;

  const repos = activeRepos();
  if (!force && state.orphanBranches && sameRepos(repos, state.orphanScannedRepos)) return;

  // Every repo hidden: scanning nothing would render as "nothing to clean up".
  if (repos !== null && repos.length === 0) {
    state.orphanBranches = null;
    state.orphanError = null;
    state.orphanScannedRepos = repos;
    state.orphanNotice = "No repository selected — pick at least one from the repositories selector.";
    renderOrphanBranches();
    return;
  }

  state.orphanLoading = true;
  state.orphanError = null;
  state.orphanNotice = null;
  renderOrphanBranches();

  try {
    state.orphanBranches = await invoke<OrphanBranchesResult>("fetch_orphan_branches", {
      activeRepos: repos,
    });
    state.orphanScannedRepos = repos;
  } catch (error) {
    state.orphanBranches = null;
    state.orphanScannedRepos = null;
    state.orphanError = errorMessage(error, "Unable to scan the branches.");
  } finally {
    state.orphanLoading = false;
    renderOrphanBranches();
  }
}

function matchingAuthorType(result: OrphanBranchesResult): OrphanBranch[] {
  return result.branches.filter((branch) =>
    branch.authorType === "internal"
      ? state.orphanShowInternal
      : state.orphanShowCollaborator,
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

function authorName(branch: OrphanBranch): string {
  return branch.authorLogin || branch.authorName || "unknown";
}

/**
 * Branches keyed by the author of their last commit, both the groups and the
 * branches inside them ascending by last commit: `branches` is already in that
 * order, so first appearance orders the groups by their oldest branch.
 */
function groupByAuthor(branches: OrphanBranch[]): Map<string, OrphanBranch[]> {
  const groups = new Map<string, OrphanBranch[]>();
  for (const branch of branches) {
    const key = authorName(branch);
    const group = groups.get(key);
    if (group) group.push(branch);
    else groups.set(key, [branch]);
  }
  return groups;
}

function renderGroupHeader(name: string, branches: OrphanBranch[]): string {
  const oldest = branches[0];
  const avatar = avatarSm(name, oldest.authorAvatarUrl || undefined);
  return `<div class="orphan-group-header">
    ${avatar}
    <span class="orphan-group-name">${escHtml(name)}</span>
    <span class="orphan-group-count">${branches.length} branch${branches.length === 1 ? "" : "es"}</span>
    <span class="orphan-group-oldest">oldest ${oldest.ageDays} d</span>
  </div>`;
}

function renderRow(branch: OrphanBranch): string {
  const displayName = authorName(branch);
  const avatar = avatarSm(displayName, branch.authorAvatarUrl || undefined);

  return `<div class="orphan-row" data-orphan-open="${escHtml(branch.url)}" role="button" tabindex="0">
    <div class="orphan-row-main">
      <div class="orphan-row-title">
        <span class="orphan-branch-icon">${SVG.gitpr}</span>
        <span class="orphan-branch-name">${escHtml(branch.branch)}</span>
        <span class="orphan-repo">${escHtml(branch.repo)}</span>
      </div>
      <div class="orphan-row-commit">
        ${escHtml(branch.lastCommitMessage || "(no commit message)")}
      </div>
    </div>
    <div class="orphan-row-author">
      ${avatar}
      <span class="orphan-author-name">${escHtml(displayName)}</span>
    </div>
    <div class="orphan-row-age">
      <span class="orphan-age-days">${branch.ageDays} d</span>
      <span class="orphan-age-rel">${escHtml(commitDate(branch.lastCommitAt))}</span>
    </div>
    <span class="orphan-row-ext">${SVG.ext}</span>
  </div>`;
}

export function renderOrphanBranches() {
  const list = document.querySelector<HTMLElement>("[data-orphan-list]");
  const summary = document.querySelector<HTMLElement>("[data-orphan-summary]");
  const warnings = document.querySelector<HTMLElement>("[data-orphan-warnings]");
  const refreshButton = document.querySelector<HTMLButtonElement>("[data-orphan-refresh]");
  if (!list || !summary || !warnings) return;

  document.querySelectorAll<HTMLButtonElement>("[data-orphan-scope]").forEach((button) => {
    const isActive = (button.dataset.orphanScope === "mine") === state.orphanOnlyMine;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  const groupToggle = document.querySelector<HTMLInputElement>("[data-orphan-group-by-author]");
  if (groupToggle) groupToggle.checked = state.orphanGroupByAuthor;
  const internalToggle = document.querySelector<HTMLInputElement>("[data-orphan-filter-internal]");
  if (internalToggle) internalToggle.checked = state.orphanShowInternal;
  const collaboratorToggle =
    document.querySelector<HTMLInputElement>("[data-orphan-filter-collaborator]");
  if (collaboratorToggle) collaboratorToggle.checked = state.orphanShowCollaborator;
  if (refreshButton) refreshButton.disabled = state.orphanLoading;
  list.classList.toggle("orphan-list--grouped", state.orphanGroupByAuthor);

  if (state.orphanLoading) {
    summary.textContent = "Scanning the branches of every configured repository…";
    list.innerHTML = `<div class="orphan-empty">This takes a few seconds on repositories with many branches.</div>`;
    warnings.hidden = true;
    return;
  }

  if (state.orphanError) {
    summary.textContent = "";
    list.innerHTML = `<div class="orphan-empty orphan-empty--danger">${escHtml(state.orphanError)}</div>`;
    warnings.hidden = true;
    return;
  }

  if (state.orphanNotice) {
    summary.textContent = "";
    list.innerHTML = `<div class="orphan-empty">${escHtml(state.orphanNotice)}</div>`;
    warnings.hidden = true;
    return;
  }

  const result = state.orphanBranches;
  if (!result) {
    summary.textContent = "";
    list.innerHTML = `<div class="orphan-empty">Nothing scanned yet.</div>`;
    warnings.hidden = true;
    return;
  }

  const byAuthorType = matchingAuthorType(result);
  const branches = state.orphanOnlyMine ? byAuthorType.filter((b) => b.isMine) : byAuthorType;
  const mineCount = byAuthorType.filter((b) => b.isMine).length;

  const repoCount = state.orphanScannedRepos?.length;
  summary.innerHTML = `<strong>${branches.length}</strong> branch${branches.length === 1 ? "" : "es"}
    with no open PR, untouched for more than ${result.staleDays} days`
    + (state.orphanOnlyMine ? "" : ` · <strong>${mineCount}</strong> of them yours`)
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
      message = state.orphanOnlyMine && mineCount === 0 && byAuthorType.length > 0
        ? "None of your branches are stale. Switch to <strong>Everyone</strong> to see the rest."
        : "No branch matches the current filters.";
    }
    list.innerHTML = `<div class="orphan-empty">${message}</div>`;
    return;
  }

  if (!state.orphanGroupByAuthor) {
    list.innerHTML = branches.map(renderRow).join("");
    return;
  }

  list.innerHTML = [...groupByAuthor(branches).entries()]
    .map(([name, group]) => `<div class="orphan-group">
      ${renderGroupHeader(name, group)}
      ${group.map(renderRow).join("")}
    </div>`)
    .join("");
}
