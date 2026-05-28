import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { maybeShowChangelog, showChangelog } from "./changelog";
import { state } from "./state";
import {
  setView, setSettingsDirtyState, syncSettingsSaveButton,
  renderListBoard, renderListFilters, renderToolbarRepoFilters, setStatus,
} from "./render";
import { applyListFilters } from "./filters";
import {
  bootstrap, refreshDashboard, saveSettingsAndRefresh,
  openExternal, rerequestReview, persistListFilters,
} from "./api";
import { loadDraftPrInfo, toggleDraftState, publishNewPr, openExistingDraftPr } from "./draft-pr";
import { openReleaseDiff } from "./release-diff";
import { escHtml, avatarColor, loginInitials } from "./utils";

window.addEventListener("DOMContentLoaded", () => {
  // ── Settings form ───────────────────────────────────────────────────────────
  document
    .querySelector<HTMLFormElement>("[data-settings-form]")
    ?.addEventListener("submit", (event) => void saveSettingsAndRefresh(event));
  document
    .querySelector<HTMLFormElement>("[data-settings-form]")
    ?.addEventListener("input", () => {
      if (!state.settingsSaving) setSettingsDirtyState(true);
    });
  document
    .querySelector<HTMLButtonElement>("[data-discard-button]")
    ?.addEventListener("click", () => setSettingsDirtyState(false));

  // ── Toolbar actions ─────────────────────────────────────────────────────────
  document
    .querySelector<HTMLButtonElement>("[data-refresh-button]")
    ?.addEventListener("click", () => void refreshDashboard());
  document
    .querySelector<HTMLButtonElement>("[data-changelog-button]")
    ?.addEventListener("click", () => void showChangelog());
  document
    .querySelector<HTMLButtonElement>("[data-add-pr-button]")
    ?.addEventListener("click", () => void loadDraftPrInfo());


  // ── Settings link buttons ───────────────────────────────────────────────────
  document
    .querySelector<HTMLButtonElement>("[data-github-token-link]")
    ?.addEventListener("click", () => void openExternal("https://github.com/settings/personal-access-tokens/new"));
  document
    .querySelector<HTMLButtonElement>("[data-jira-token-link]")
    ?.addEventListener("click", () => void openExternal("https://id.atlassian.com/manage-profile/security/api-tokens"));

  // ── Search ──────────────────────────────────────────────────────────────────
  document
    .querySelector<HTMLInputElement>("[data-list-search]")
    ?.addEventListener("input", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.listSearchQuery = target.value.trim();
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
    });

  // ── List filters ────────────────────────────────────────────────────────────
  document
    .querySelector<HTMLInputElement>("[data-filter-my-review-pending]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.onlyMyPendingReviews = target.checked;
      if (target.checked) { state.onlyMyPullRequests = false; state.filteredReviewer = null; }
      document.querySelectorAll<HTMLButtonElement>("[data-reviewer-filter]")
        .forEach(btn => btn.classList.remove("rlb__chip--active"));
      if (state.currentDashboard) {
        renderListFilters(state.currentDashboard);
        renderListBoard(applyListFilters(state.currentDashboard));
      }
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-my-prs]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.onlyMyPullRequests = target.checked;
      if (target.checked) { state.onlyMyPendingReviews = false; state.filteredReviewer = null; }
      document.querySelectorAll<HTMLButtonElement>("[data-reviewer-filter]")
        .forEach(btn => btn.classList.remove("rlb__chip--active"));
      if (state.currentDashboard) {
        renderListFilters(state.currentDashboard);
        renderListBoard(applyListFilters(state.currentDashboard));
      }
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-internal]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.checked && !state.showTeamOnly && !state.showCollaboratorOnly) { target.checked = true; return; }
      state.showInternalOnly = target.checked;
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-team]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.checked && !state.showInternalOnly && !state.showCollaboratorOnly) { target.checked = true; return; }
      state.showTeamOnly = target.checked;
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-collaborator]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.checked && !state.showInternalOnly && !state.showTeamOnly) { target.checked = true; return; }
      state.showCollaboratorOnly = target.checked;
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-group-by-release]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.groupByRelease = target.checked;
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
      void persistListFilters();
    });
  document
    .querySelector<HTMLInputElement>("[data-filter-show-draft]")
    ?.addEventListener("change", (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLInputElement)) return;
      state.showDraft = target.checked;
      if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
      void persistListFilters();
    });
  // Repos selector — search filter (input event on the container)
  document
    .querySelector<HTMLElement>("[data-toolbar-repo-filters]")
    ?.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.matches("[data-repos-selector-search]")) return;
      const query = target.value.toLowerCase();
      document.querySelectorAll<HTMLElement>("[data-repos-selector-repo]").forEach(item => {
        const name = (item.dataset.reposSelectorRepo ?? "").toLowerCase();
        item.hidden = !!query && !name.includes(query);
      });
    });

  // Close repos selector dropdown on outside click (setup-once)
  document.addEventListener("click", (e) => {
    const dropdown = document.querySelector<HTMLElement>("[data-repos-selector-dropdown]");
    if (!dropdown || dropdown.hidden) return;
    if (!(e.target as Element).closest("[data-repos-selector]")) {
      dropdown.hidden = true;
    }
  }, { capture: true });

  // ── View tabs ───────────────────────────────────────────────────────────────
  document.querySelectorAll<HTMLElement>("[data-view-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.viewTab;
      if (view === "status" || view === "list" || view === "settings") setView(view);
    });
  });

  // ── Global click delegation ─────────────────────────────────────────────────
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
    if (rerequestButton) { void rerequestReview(rerequestButton); return; }

    const addReviewerBtn = target.closest<HTMLButtonElement>("[data-add-reviewer]");
    if (addReviewerBtn) { showAddReviewerPopover(addReviewerBtn); return; }

    const promoteButton = target.closest<HTMLButtonElement>("[data-promote-draft]");
    if (promoteButton) {
      const prId = promoteButton.dataset.promoteDraft;
      const pr = state.currentDashboard?.prs.find(p => `${p.repo}/${p.id}` === prId);
      if (pr) void openExistingDraftPr(pr, promoteButton);
      return;
    }

    const releaseDiffBtn = target.closest<HTMLButtonElement>("[data-release-diff]");
    if (releaseDiffBtn) {
      const releaseName = releaseDiffBtn.dataset.releaseDiff;
      const releaseRepos = releaseDiffBtn.dataset.releaseRepos
        ? JSON.parse(releaseDiffBtn.dataset.releaseRepos)
        : undefined;
      if (releaseName) void openReleaseDiff(
        releaseName,
        releaseDiffBtn,
        releaseDiffBtn.dataset.releaseProject,
        releaseRepos
      );
      return;
    }

    // Repos selector — toggle dropdown open/close
    const reposSelectorToggle = target.closest<HTMLElement>("[data-repos-selector-toggle]");
    if (reposSelectorToggle) {
      const dropdown = document.querySelector<HTMLElement>("[data-repos-selector-dropdown]");
      if (dropdown) {
        dropdown.hidden = !dropdown.hidden;
        if (!dropdown.hidden) {
          dropdown.querySelector<HTMLInputElement>("[data-repos-selector-search]")?.focus();
        }
      }
      return;
    }

    // Repos selector — toggle a single repo
    const repoItem = target.closest<HTMLElement>("[data-repos-selector-repo]");
    if (repoItem) {
      const repo = repoItem.dataset.reposSelectorRepo;
      if (!repo) return;
      state.hiddenRepos = state.hiddenRepos.includes(repo)
        ? state.hiddenRepos.filter(r => r !== repo)
        : [...state.hiddenRepos, repo];
      if (state.currentDashboard) {
        renderListBoard(applyListFilters(state.currentDashboard));
        renderToolbarRepoFilters(state.currentDashboard);
      }
      void persistListFilters();
      return;
    }

    // Repos selector — "Add repository" → open settings
    const reposAdd = target.closest<HTMLElement>("[data-repos-selector-add]");
    if (reposAdd) {
      setView("settings");
      return;
    }

    const reviewerChip = target.closest<HTMLButtonElement>("[data-reviewer-filter]");
    if (reviewerChip && state.currentDashboard) {
      const login = reviewerChip.dataset.reviewerFilter ?? null;
      state.filteredReviewer = state.filteredReviewer?.toLowerCase() === login?.toLowerCase() ? null : login;
      if (state.filteredReviewer) {
        state.onlyMyPendingReviews = false;
        state.onlyMyPullRequests = false;
        renderListFilters(state.currentDashboard);
      }
      document.querySelectorAll<HTMLButtonElement>("[data-reviewer-filter]").forEach(btn => {
        const isActive = state.filteredReviewer !== null &&
          btn.dataset.reviewerFilter?.toLowerCase() === state.filteredReviewer.toLowerCase();
        btn.classList.toggle("rlb__chip--active", isActive);
      });
      renderListBoard(applyListFilters(state.currentDashboard));
    }
  });

  // ── Keyboard shortcut ───────────────────────────────────────────────────────
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const kbdHint = document.querySelector<HTMLElement>("[data-search-kbd]");
  if (kbdHint) kbdHint.textContent = isMac ? "⌘F" : "Ctrl+F";

  document.addEventListener("keydown", (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && e.key === "f") {
      e.preventDefault();
      setView("list");
      document.querySelector<HTMLInputElement>("[data-list-search]")?.focus();
      return;
    }

    if (state.draftPrInfo !== null) {
      if (mod && e.key === "Enter") {
        e.preventDefault();
        void publishNewPr(state.draftAsDraft);
        return;
      }
      if (mod && e.key === "d") {
        e.preventDefault();
        toggleDraftState();
        return;
      }
    }

    // ── Demo mode navigation (Alt + ← / →) ─────────────────────────────────
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      const cur = parseInt(document.body.dataset.demoStage ?? "0");
      if (e.key === "ArrowRight") {
        if (cur >= 11) return;
        document.body.dataset.demoStage = String(cur + 1);
        showDemoToast(cur + 1);
      } else {
        if (cur <= 0) return;
        if (cur === 1) delete document.body.dataset.demoStage;
        else document.body.dataset.demoStage = String(cur - 1);
        showDemoToast(cur <= 1 ? 0 : cur - 1);
      }
    }
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  syncSettingsSaveButton();
  setView(state.currentView);
  void bootstrap();

  void getVersion().then((v) => {
    const el = document.querySelector("[data-app-version]");
    if (el) el.textContent = `v${v}`;
  });

  void maybeShowChangelog();
});

// ── Demo mode toast ───────────────────────────────────────────────────────────

const DEMO_STAGE_LABELS: Record<number, string> = {
  0:  "Normal",
  1:  "Base list",
  2:  "+ Review status",
  3:  "+ Need action",
  4:  "+ Diff stats",
  5:  "+ CI & merge",
  6:  "+ Group by release",
  7:  "+ Reviewer load",
  8:  "+ My Score",
  9:  "+ New PR",
  10: "+ Promote",
  11: "+ Release status",
};

let _demoToastTimer: number | null = null;
let _demoToastEl: HTMLElement | null = null;

function showDemoToast(stage: number) {
  if (_demoToastEl) {
    _demoToastEl.remove();
    _demoToastEl = null;
  }
  if (_demoToastTimer !== null) {
    clearTimeout(_demoToastTimer);
    _demoToastTimer = null;
  }
  const label = DEMO_STAGE_LABELS[stage] ?? "";
  const el = document.createElement("div");
  el.className = "demo-toast";
  el.innerHTML = `<span class="demo-toast-step">${stage}/11</span>${escHtml(label)}`;
  document.body.appendChild(el);
  _demoToastEl = el;
  _demoToastTimer = window.setTimeout(() => {
    el.classList.add("demo-toast--fade");
    _demoToastTimer = window.setTimeout(() => {
      el.remove();
      if (_demoToastEl === el) _demoToastEl = null;
    }, 420);
  }, 1500);
}

// ── Add-reviewer popover ──────────────────────────────────────────────────────

let _arvPopover: HTMLElement | null = null;
let _arvOutsideListener: ((e: MouseEvent) => void) | null = null;

function closeAddReviewerPopover() {
  if (_arvPopover) { _arvPopover.remove(); _arvPopover = null; }
  if (_arvOutsideListener) {
    document.removeEventListener("click", _arvOutsideListener, { capture: true });
    _arvOutsideListener = null;
  }
}

function showAddReviewerPopover(triggerBtn: HTMLButtonElement) {
  closeAddReviewerPopover();

  const prKey = triggerBtn.dataset.addReviewer ?? "";
  const slashIdx = prKey.lastIndexOf("/");
  if (slashIdx < 0) return;
  const repo = prKey.slice(0, slashIdx);
  const prNumber = Number(prKey.slice(slashIdx + 1));
  if (!repo || !prNumber) return;

  // Find the PR to get its current reviewers
  const pr = state.currentDashboard?.prs.find(p => p.repo === repo && p.id === prNumber);
  const existingLower = new Set(
    [
      ...(pr?.pendingReviewers ?? []),
      ...(pr?.currentApprovers ?? []),
      ...(pr?.blockingReviewers ?? []),
      ...(pr?.staleApprovers ?? []),
      ...(pr?.commentedReviewers ?? []),
    ].map(a => a.login.toLowerCase()),
  );

  const dashboard = state.currentDashboard;
  const avatarUrls = dashboard?.reviewerAvatars ?? {};
  const stripMarker = (login: string) =>
    state.currentInternalMarker ? login.replace(state.currentInternalMarker, "") : login;

  const authorLower = (pr?.author ?? "").toLowerCase();
  const candidates = state.currentCollaborators.filter(l => {
    const ll = l.toLowerCase();
    return !existingLower.has(ll) && ll !== authorLower;
  });

  if (candidates.length === 0) {
    setStatus("All team members are already reviewing this PR.", "neutral");
    return;
  }

  const chipsHtml = candidates.map(login => {
    const displayName = stripMarker(login);
    const avatarUrl = avatarUrls[login];
    const avatarHtml = avatarUrl
      ? `<img class="arv-chip-avatar" src="${escHtml(avatarUrl)}" alt="" loading="lazy" />`
      : `<span class="arv-chip-avatar" style="background:${avatarColor(login)}">${escHtml(loginInitials(displayName))}</span>`;
    return `<button class="arv-chip" data-arv-login="${escHtml(login)}" type="button">
      ${avatarHtml}<span class="arv-chip-name">${escHtml(displayName)}</span>
    </button>`;
  }).join("");

  const popover = document.createElement("div");
  popover.className = "arv-popover";
  popover.innerHTML = `<div class="arv-header">Add reviewer</div><div class="arv-chips">${chipsHtml}</div>`;
  document.body.appendChild(popover);
  _arvPopover = popover;

  // Position below/above the trigger
  const rect = triggerBtn.getBoundingClientRect();
  const pw = popover.offsetWidth || 220;
  const ph = popover.offsetHeight || 160;
  let top = rect.bottom + 6;
  let left = rect.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  popover.style.top = `${Math.max(8, top)}px`;
  popover.style.left = `${Math.max(8, left)}px`;

  // Chip click — call backend
  popover.querySelectorAll<HTMLButtonElement>("[data-arv-login]").forEach(chip => {
    chip.addEventListener("click", async () => {
      const login = chip.dataset.arvLogin;
      if (!login) return;
      chip.disabled = true;
      chip.classList.add("arv-chip--loading");
      try {
        await invoke("request_review", { repo, prNumber, login });
        closeAddReviewerPopover();
        void refreshDashboard("auto");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Failed to add reviewer.", "danger");
        chip.disabled = false;
        chip.classList.remove("arv-chip--loading");
      }
    });
  });

  // Close on outside click (deferred so the triggering click doesn't immediately close it)
  setTimeout(() => {
    _arvOutsideListener = (e: MouseEvent) => {
      if (!_arvPopover?.contains(e.target as Node) && e.target !== triggerBtn) {
        closeAddReviewerPopover();
      }
    };
    document.addEventListener("click", _arvOutsideListener, { capture: true });
  }, 0);
}
