import { invoke } from "@tauri-apps/api/core";
import { state, type ChecklistItem, type DraftPrInfo, type BranchStats } from "./state";
import { escHtml, avatarColor, loginInitials } from "./utils";
import { setStatus, setView } from "./render";
import { getAvailableRepos } from "./filters";
import { refreshDashboard } from "./api";
import type { PullRequestSummary } from "./shared/pr-model";

// ── Module-level SVG constants (reused in DOM patches) ────────────────────────
const SVG_BRANCH  = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/><path d="M3 4.4v3.2M3 4.5C3 6 5 7 7.6 5.8"/></svg>`;
const SVG_ARROW   = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>`;
const SVG_SPARKLE = `<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.1 3 3 1.1-3 1.1L6 9.2 4.9 6.2 1.9 5.1 4.9 4z"/></svg>`;
const SVG_CHECK   = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`;
const SVG_X       = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`;
const SVG_PLUS    = ``;
const SVG_JIRA    = `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1L1 6l5 5 1.3-1.3L3.6 6 7.3 2.3z" opacity=".7"/><path d="M6 4.7L8.4 7.1 6 9.5V11l5-5-5-5z"/></svg>`;
const SVG_CHEV    = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>`;

// ── Branch flow box helpers ───────────────────────────────────────────────────

function commitTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderBranchFlowBox(): string {
  const stats = state.draftPrInfo?.stats;
  const info  = state.draftPrInfo!;
  const statsHtml = stats
    ? `<span class="pr-new-diff-stats">
        <span class="is-add">+${stats.additions}</span>
        <span class="pr-new-diff-sep">·</span>
        <span class="is-del">−${stats.deletions}</span>
        <span class="pr-new-diff-sep">·</span>
        <span class="is-files">${stats.files} files</span>
      </span>
      <button class="pr-new-commits-btn" data-toggle-commits type="button">
        ${stats.commits.length} commits ${SVG_CHEV}
      </button>`
    : "";

  const commitsHtml = stats?.commits.map(c => `
    <div class="pr-new-commit-row">
      <span class="pr-new-commit-sha">${escHtml(c.sha)}</span>
      <span class="pr-new-commit-msg">${escHtml(c.message)}</span>
      <span class="pr-new-commit-when">${commitTimeAgo(c.committedAt)}</span>
    </div>`).join("") ?? "";

  return `
    <div class="pr-new-branch-row">
      <span class="pr-new-branch-tag is-source">
        <span style="color:var(--ink-muted);display:inline-flex">${SVG_BRANCH}</span>
        ${escHtml(info.branch)}
      </span>
      <span style="color:var(--ink-muted);display:inline-flex;flex-shrink:0">${SVG_ARROW}</span>
      <span class="pr-new-branch-tag is-target">
        <span style="color:#a8a8b3;display:inline-flex">${SVG_BRANCH}</span>
        <input class="pr-new-base-input" data-new-pr-base type="text"
          value="${escHtml(state.draftBaseBranch)}"
          placeholder="${escHtml(info.baseBranch)}"
          title="Base branch" />
      </span>
      <div style="flex:1"></div>
      ${statsHtml}
    </div>
    ${stats?.commits.length ? `<div class="pr-new-commits-list" data-commits-list hidden>${commitsHtml}</div>` : ""}`;
}

// ── Draft PR card render ──────────────────────────────────────────────────────

export function renderDraftPrCard() {
  const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
  if (!container || !state.draftPrInfo) return;

  const svgBranch   = SVG_BRANCH;
  const svgArrow    = SVG_ARROW;
  const svgSparkle  = SVG_SPARKLE;
  const svgCheck    = SVG_CHECK;
  const svgX        = SVG_X;
  const svgPlus     = SVG_PLUS;
  const svgJira     = SVG_JIRA;

  // ── Data ─────────────────────────────────────────────────────────────────────
  // Extract Jira key from branch name (e.g. "PENT-5834/feature" → "PENT-5834")
  const jiraKey = state.draftPrInfo.branch.match(/^([A-Z]+-\d+)/)?.[1] ?? null;

  const dashboard = state.currentDashboard;
  const avatarUrls = dashboard?.reviewerAvatars ?? {};

  // Strip internal author marker from display names (same as RLB)
  const stripMarker = (login: string) =>
    state.currentInternalMarker ? login.replace(state.currentInternalMarker, "") : login;

  // Compute pending / total review load per collaborator from current PRs
  const pendingLoad = new Map<string, number>();
  const totalLoad   = new Map<string, number>();
  if (dashboard) {
    const colByLower = new Map(state.currentCollaborators.map(l => [l.toLowerCase(), l]));
    const touch = (login: string, isPending: boolean) => {
      const canonical = colByLower.get(login.toLowerCase());
      if (!canonical) return;
      totalLoad.set(canonical, (totalLoad.get(canonical) ?? 0) + 1);
      if (isPending) pendingLoad.set(canonical, (pendingLoad.get(canonical) ?? 0) + 1);
    };
    for (const pr of dashboard.prs) {
      if (pr.isDraft) continue;
      for (const r of pr.pendingReviewers)   touch(r.login, true);
      for (const r of pr.currentApprovers)   touch(r.login, false);
      for (const r of pr.blockingReviewers)  touch(r.login, false);
      for (const r of pr.staleApprovers)     touch(r.login, false);
      for (const r of pr.commentedReviewers) touch(r.login, false);
    }
  }

  // Collaborators excluding viewer, sorted by load ascending (fewest pending first)
  const collaborators = state.currentCollaborators
    .filter(login => login !== (dashboard?.viewerLogin ?? ""))
    .sort((a, b) => {
      const ap = pendingLoad.get(a) ?? 0;
      const bp = pendingLoad.get(b) ?? 0;
      if (ap !== bp) return ap - bp;
      return (totalLoad.get(a) ?? 0) - (totalLoad.get(b) ?? 0);
    });

  const pickedCount = state.draftReviewers.length;
  const isDraft = state.draftAsDraft;
  const isPromoteMode = state.draftPrNumber !== null;

  // ── Reviewer chips ────────────────────────────────────────────────────────────
  const reviewerChipsHtml = collaborators.map(login => {
    const isPicked = state.draftReviewers.includes(login);
    const displayName = stripMarker(login);
    const open = pendingLoad.get(login) ?? 0;
    const cap  = totalLoad.get(login)   ?? 0;
    const avatarUrl = avatarUrls[login];
    const avatarHtml = avatarUrl
      ? `<img class="pr-new-reviewer-chip-avatar" src="${escHtml(avatarUrl)}" alt="${escHtml(login)}" loading="lazy" />`
      : `<span class="pr-new-reviewer-chip-avatar" style="background:${avatarColor(login)}">${escHtml(loginInitials(displayName))}</span>`;
    return `<button class="pr-new-reviewer-chip${isPicked ? " is-picked" : ""}"
              data-pick-reviewer="${escHtml(login)}" type="button">
      ${avatarHtml}
      <span class="pr-new-reviewer-chip-name">${escHtml(displayName)}</span>
      <span class="pr-new-reviewer-chip-load">${open}/${cap}</span>
      <span class="pr-new-reviewer-chip-toggle">${isPicked ? svgCheck : svgPlus}</span>
    </button>`;
  }).join("");

  // ── HTML ─────────────────────────────────────────────────────────────────────
  container.innerHTML = `
    <div class="pr-new-card" data-new-pr-card>
      <div class="pr-new-accent-strip"></div>

      <div class="pr-new-header">
        <span class="pr-new-badge">${svgSparkle} ${isPromoteMode ? "Promote pull request" : "New pull request"}</span>
        <span class="pr-new-repo-tag">${escHtml(state.draftPrInfo.repo)}</span>
        ${jiraKey ? `<span class="pr-new-jira-tag">${svgJira} ${escHtml(jiraKey)}</span>` : ""}
        <div style="flex:1"></div>
        <button class="pr-new-close-btn" data-close-new-pr type="button" title="Dismiss">${svgX}</button>
      </div>

      <div class="pr-new-body">
        <div class="pr-new-section-label">Title</div>
        <div class="pr-new-title-wrap">
          <input class="pr-new-title-input" data-new-pr-title type="text"
            value="${escHtml(state.draftPrInfo.suggestedTitle)}"
            placeholder="Pull request title…" />
          <span class="pr-new-title-hint">${svgSparkle} from last commit</span>
        </div>

        ${renderBranchFlowBox()}

        <div class="pr-new-section-label">
          Description
          <span class="pr-new-section-label-aside" data-desc-char-count>Markdown · ${state.draftBody.length} chars</span>
        </div>
        <textarea class="pr-new-body-input" data-new-pr-body
          rows="4" placeholder="Describe the changes, motivation, linked issues…">${escHtml(state.draftBody)}</textarea>

        ${collaborators.length > 0 ? `
        <div class="pr-new-section-label">
          Reviewers
          <span class="pr-new-reviewers-count" data-reviewers-count
                style="${pickedCount === 0 ? "opacity:0" : ""}">${pickedCount} selected</span>
        </div>
        <div class="pr-new-reviewers-grid">${reviewerChipsHtml}</div>
        <p class="pr-new-reviewer-hint">Team members ordered by current review load <span style="font-family:var(--font-mono);color:var(--ink-soft)">(open / capacity)</span></p>
        ` : ""}

        ${renderChecklistSection()}
      </div>

      <div class="pr-new-footer">
        ${!isPromoteMode ? `<label class="pr-new-draft-label${isDraft ? " is-checked" : ""}" data-draft-toggle>
          <span class="pr-new-draft-check">${isDraft ? svgCheck : ""}</span>
          Open as <strong>draft</strong> · skip CI notifications
        </label>` : ""}
        <div style="flex:1"></div>
        <span class="pr-new-kbd-hint" data-pr-new-kbd-hint></span>
        <button class="secondary-button" data-close-new-pr type="button">Cancel</button>
        <button class="pr-new-submit-btn${!isPromoteMode && isDraft ? " is-draft" : ""}${checklistBlocking() && !isDraft ? " is-blocked" : ""}"
                data-publish-pr type="button" ${checklistBlocking() && !isDraft ? 'title="Check all acceptance criteria first"' : ""}>
          ${!isPromoteMode && isDraft ? "Open draft PR" : "Open pull request"} ${svgArrow}
        </button>
      </div>
    </div>`;

  // ── Event listeners ───────────────────────────────────────────────────────────
  container.querySelector<HTMLInputElement>("[data-new-pr-title]")
    ?.addEventListener("input", e => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      state.draftPrInfo!.suggestedTitle = (e.target as HTMLInputElement).value;
    });

  container.querySelector<HTMLTextAreaElement>("[data-new-pr-body]")
    ?.addEventListener("input", e => {
      state.draftBody = (e.target as HTMLTextAreaElement).value;
      const hint = container.querySelector<HTMLElement>("[data-desc-char-count]");
      if (hint) hint.textContent = `Markdown · ${state.draftBody.length} chars`;
    });

  container.querySelector<HTMLInputElement>("[data-new-pr-base]")
    ?.addEventListener("input", e => {
      state.draftBaseBranch = (e.target as HTMLInputElement).value;
    });

  container.querySelector<HTMLButtonElement>("[data-toggle-commits]")
    ?.addEventListener("click", () => {
      const list = container.querySelector<HTMLElement>("[data-commits-list]");
      const btn  = container.querySelector<HTMLButtonElement>("[data-toggle-commits]");
      if (!list || !btn) return;
      const open = list.hidden;
      list.hidden = !open;
      btn.classList.toggle("is-open", open);
    });

  container.querySelectorAll<HTMLButtonElement>("[data-pick-reviewer]")
    .forEach(btn => btn.addEventListener("click", () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const login = btn.dataset.pickReviewer!;
      const nowPicked = !state.draftReviewers.includes(login);
      state.draftReviewers = nowPicked
        ? [...state.draftReviewers, login]
        : state.draftReviewers.filter(r => r !== login);

      // Patch only the affected chip — no full re-render, no flicker
      btn.classList.toggle("is-picked", nowPicked);
      const toggle = btn.querySelector<HTMLElement>(".pr-new-reviewer-chip-toggle");
      if (toggle) toggle.innerHTML = nowPicked ? SVG_CHECK : SVG_PLUS;

      // Update the count badge in-place
      const badge = container.querySelector<HTMLElement>("[data-reviewers-count]");
      if (badge) {
        const count = state.draftReviewers.length;
        badge.textContent = `${count} selected`;
        badge.style.opacity = count === 0 ? "0" : "1";
      }
    }));

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const mod = isMac ? "⌘" : "Ctrl+";
  const kbdHint = container.querySelector<HTMLElement>("[data-pr-new-kbd-hint]");
  if (kbdHint) kbdHint.textContent = isPromoteMode ? `${mod}↵ promote` : `${mod}↵ open · ${mod}D draft`;

  container.querySelector("[data-draft-toggle]")
    ?.addEventListener("click", () => toggleDraftState());

  container.querySelectorAll<HTMLButtonElement>("[data-close-new-pr]")
    .forEach(btn => btn.addEventListener("click", closeDraftPrCard));

  container.querySelector("[data-publish-pr]")
    ?.addEventListener("click", () => {
      if (checklistBlocking() && !state.draftAsDraft) return;
      void publishNewPr(state.draftAsDraft);
    });

  wireChecklistListeners(container);
}

// ── Checklist helpers ─────────────────────────────────────────────────────────

function checklistBlocking(): boolean {
  return state.draftChecklist.length > 0 && state.draftChecklist.some(i => !i.done);
}

function renderChecklistSection(): string {
  if (state.draftChecklistLoading) {
    return `<div class="pr-new-section-label">Acceptance criteria <span class="pr-new-checklist-loading">loading…</span></div>`;
  }
  if (state.draftChecklist.length === 0) return "";

  const doneCount = state.draftChecklist.filter(i => i.done).length;
  const total = state.draftChecklist.length;
  const allDone = doneCount === total;

  const itemsHtml = state.draftChecklist.map((item, idx) => `
    <label class="pr-new-checklist-item${item.done ? " is-done" : ""}" data-checklist-item="${idx}">
      <span class="pr-new-checklist-check">${item.done ? SVG_CHECK : ""}</span>
      <span class="pr-new-checklist-text">${escHtml(item.text)}</span>
    </label>`).join("");

  return `
    <div class="pr-new-section-label">
      Acceptance criteria
      <span class="pr-new-checklist-count${allDone ? " is-done" : ""}">${doneCount}/${total}</span>
    </div>
    <div class="pr-new-checklist" data-checklist>${itemsHtml}</div>
    ${!allDone ? `<p class="pr-new-checklist-hint">Check all criteria to enable publish</p>` : ""}`;
}

function wireChecklistListeners(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>("[data-checklist-item]").forEach(label => {
    label.addEventListener("click", () => {
      const idx = Number(label.dataset.checklistItem);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.draftChecklist.length) return;
      state.draftChecklist[idx].done = !state.draftChecklist[idx].done;

      // Patch label
      label.classList.toggle("is-done", state.draftChecklist[idx].done);
      const check = label.querySelector<HTMLElement>(".pr-new-checklist-check");
      if (check) check.innerHTML = state.draftChecklist[idx].done ? SVG_CHECK : "";

      // Patch count badge
      const doneCount = state.draftChecklist.filter(i => i.done).length;
      const total = state.draftChecklist.length;
      const allDone = doneCount === total;
      const badge = container.querySelector<HTMLElement>(".pr-new-checklist-count");
      if (badge) {
        badge.textContent = `${doneCount}/${total}`;
        badge.classList.toggle("is-done", allDone);
      }

      // Show/hide hint
      const hint = container.querySelector<HTMLElement>(".pr-new-checklist-hint");
      if (hint) hint.style.display = allDone ? "none" : "";

      // Enable/disable publish button (only blocked in non-draft mode)
      const publishBtn = container.querySelector<HTMLButtonElement>("[data-publish-pr]");
      if (publishBtn) {
        const isBlocked = !allDone && !state.draftAsDraft;
        publishBtn.classList.toggle("is-blocked", isBlocked);
        if (isBlocked) publishBtn.title = "Check all acceptance criteria first";
        else publishBtn.removeAttribute("title");
      }
    });
  });
}

// ── Toggle draft state (surgical DOM patch) ───────────────────────────────────

export function toggleDraftState() {
  if (state.draftPrNumber !== null) return; // promote mode: no draft toggle
  const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
  if (!container) return;
  state.draftAsDraft = !state.draftAsDraft;
  const isDraft = state.draftAsDraft;
  const label = container.querySelector<HTMLElement>("[data-draft-toggle]");
  label?.classList.toggle("is-checked", isDraft);
  const check = label?.querySelector<HTMLElement>(".pr-new-draft-check");
  if (check) check.innerHTML = isDraft ? SVG_CHECK : "";
  const submitBtn = container.querySelector<HTMLButtonElement>("[data-publish-pr]");
  if (submitBtn) {
    submitBtn.classList.toggle("is-draft", isDraft);
    submitBtn.innerHTML = `${isDraft ? "Open draft PR" : "Open pull request"} ${SVG_ARROW}`;
    const isBlocked = checklistBlocking() && !isDraft;
    submitBtn.classList.toggle("is-blocked", isBlocked);
    if (isBlocked) submitBtn.title = "Check all acceptance criteria first";
    else submitBtn.removeAttribute("title");
  }
}

// ── Close draft PR card ───────────────────────────────────────────────────────

export function closeDraftPrCard() {
  state.draftPrInfo = null;
  state.draftReviewers = [];
  state.draftBody = "";
  state.draftBaseBranch = "";
  state.draftAsDraft = false;
  state.draftJiraKey = null;
  state.draftChecklist = [];
  state.draftChecklistLoading = false;
  state.draftPrNumber = null;
  state.draftPrNodeId = null;
  const container = document.querySelector("[data-new-pr-container]");
  if (container) container.innerHTML = "";
}

// ── Load draft PR info ────────────────────────────────────────────────────────

export async function loadDraftPrInfo() {
  const btn = document.querySelector<HTMLButtonElement>("[data-add-pr-button]");

  if (state.draftPrInfo !== null) {
    closeDraftPrCard();
    return;
  }

  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
  try {
    const allRepos = state.currentDashboard ? getAvailableRepos(state.currentDashboard) : [];
    const activeRepos = allRepos.filter(r => !state.hiddenRepos.includes(r));
    const info = await invoke<DraftPrInfo | null>("get_draft_pr_info", {
      activeRepos: activeRepos.length > 0 ? activeRepos : null,
    });
    if (!info) {
      setStatus("No unpublished branch found for your account.", "neutral");
      return;
    }
    state.draftPrInfo = info;
    state.draftReviewers = [];
    state.draftBody = "";
    state.draftBaseBranch = info.baseBranch;
    state.draftJiraKey = info.branch.match(/^([A-Z]+-\d+)/)?.[1] ?? null;
    state.draftChecklist = [];
    state.draftChecklistLoading = state.draftJiraKey !== null;
    setView("list");
    renderDraftPrCard();
    document.querySelector(".list-scroll")?.scrollTo({ top: 0, behavior: "smooth" });

    // Fetch checklist asynchronously — re-render only the checklist section when ready
    if (state.draftJiraKey) {
      const jiraKey = state.draftJiraKey;
      invoke<ChecklistItem[]>("fetch_draft_checklist", { jiraKey })
        .then(items => {
          if (state.draftJiraKey !== jiraKey) return; // card was closed
          state.draftChecklist = items;
          state.draftChecklistLoading = false;
          // Patch the checklist section in-place
          const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
          if (!container) return;
          const existing = container.querySelector<HTMLElement>("[data-checklist]");
          const wrapper = existing?.closest(".pr-new-body > :last-child") ?? container.querySelector<HTMLElement>(".pr-new-body");
          if (wrapper) {
            // Re-render only the checklist section by replacing innerHTML of pr-new-body's last child
            // Simpler: re-render the full card (checklist is fetched once, no flicker risk here)
            renderDraftPrCard();
          }
        })
        .catch(() => {
          state.draftChecklistLoading = false;
        });
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not fetch branch info.", "danger");
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
  }
}

// ── Open existing draft PR for promotion ──────────────────────────────────────

export async function openExistingDraftPr(pr: PullRequestSummary, triggerBtn?: HTMLButtonElement) {
  if (state.draftPrInfo !== null) closeDraftPrCard();

  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.classList.add("is-loading"); }

  const stats = await invoke<BranchStats | null>(
    "fetch_branch_stats",
    { repo: pr.repo, base: pr.baseRef, head: pr.headRef },
  ).catch(() => null);

  if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.classList.remove("is-loading"); }

  state.draftPrInfo = {
    repo: pr.repo,
    branch: pr.headRef,
    baseBranch: pr.baseRef,
    suggestedTitle: pr.title,
    stats,
  };
  state.draftPrNumber = pr.id;
  state.draftPrNodeId = pr.nodeId;
  state.draftReviewers = pr.pendingReviewers.map(r => r.login);
  state.draftBody = pr.body;
  state.draftBaseBranch = pr.baseRef;
  state.draftAsDraft = false;
  state.draftJiraKey = pr.headRef.match(/^([A-Z]+-\d+)/)?.[1] ?? null;
  state.draftChecklist = [];
  state.draftChecklistLoading = state.draftJiraKey !== null;

  setView("list");
  renderDraftPrCard();
  document.querySelector(".list-scroll")?.scrollTo({ top: 0, behavior: "smooth" });

  if (state.draftJiraKey) {
    const jiraKey = state.draftJiraKey;
    invoke<ChecklistItem[]>("fetch_draft_checklist", { jiraKey })
      .then(items => {
        if (state.draftJiraKey !== jiraKey) return;
        state.draftChecklist = items;
        state.draftChecklistLoading = false;
        const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
        if (container) renderDraftPrCard();
      })
      .catch(() => { state.draftChecklistLoading = false; });
  }
}

// ── Publish new PR ────────────────────────────────────────────────────────────

export async function publishNewPr(draft: boolean) {
  if (!state.draftPrInfo) return;
  if (checklistBlocking() && !draft) return; // keyboard shortcut guard
  const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
  const titleInput = container?.querySelector<HTMLInputElement>("[data-new-pr-title]");
  const title = titleInput?.value.trim() ?? state.draftPrInfo.suggestedTitle;
  if (!title) {
    titleInput?.focus();
    return;
  }

  const publishBtn = container?.querySelector<HTMLButtonElement>("[data-publish-pr]");
  if (publishBtn) { publishBtn.disabled = true; publishBtn.textContent = "Publishing…"; }

  try {
    let prUrl: string;
    if (state.draftPrNumber !== null && state.draftPrNodeId !== null) {
      prUrl = await invoke<string>("promote_draft_pr", {
        repo: state.draftPrInfo.repo,
        prNumber: state.draftPrNumber,
        nodeId: state.draftPrNodeId,
        title,
        body: state.draftBody,
        reviewers: state.draftReviewers,
      });
    } else {
      prUrl = await invoke<string>("create_pull_request", {
        repo: state.draftPrInfo.repo,
        title,
        body: state.draftBody,
        head: state.draftPrInfo.branch,
        base: state.draftBaseBranch || state.draftPrInfo.baseBranch,
        reviewers: state.draftReviewers,
        draft,
      });
    }
    const jiraKey = state.draftJiraKey;
    const checklist = [...state.draftChecklist];
    const wasPromotion = state.draftPrNumber !== null;
    closeDraftPrCard();
    setStatus(wasPromotion ? "PR promoted successfully." : "PR created successfully.", "neutral");
    void refreshDashboard("auto");
    void invoke("open_external", { url: prUrl });
    if (jiraKey) {
      if (draft) {
        if (checklist.length > 0) {
          void invoke("update_jira_checklist", { jiraKey, items: checklist });
        }
      } else {
        // Non-draft publish: mark all done + transition to merge state
        void invoke("complete_jira_story", { jiraKey, items: checklist });
      }
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to publish pull request.", "danger");
    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.textContent = draft ? "Open draft PR" : "Open pull request";
    }
  }
}
