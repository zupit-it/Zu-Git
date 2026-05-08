import { getVersion } from "@tauri-apps/api/app";
import { maybeShowChangelog } from "./changelog";
import { state } from "./state";
import {
  setView, setSettingsDirtyState, syncSettingsSaveButton,
  renderListBoard, renderListFilters, renderToolbarRepoFilters,
} from "./render";
import { applyListFilters } from "./filters";
import {
  bootstrap, refreshDashboard, saveSettingsAndRefresh,
  openExternal, rerequestReview, persistListFilters,
} from "./api";
import { loadDraftPrInfo, toggleDraftState, publishNewPr, openExistingDraftPr } from "./draft-pr";

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

    const promoteButton = target.closest<HTMLButtonElement>("[data-promote-draft]");
    if (promoteButton) {
      const prId = promoteButton.dataset.promoteDraft;
      const pr = state.currentDashboard?.prs.find(p => `${p.repo}/${p.id}` === prId);
      if (pr) void openExistingDraftPr(pr, promoteButton);
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
