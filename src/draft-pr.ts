import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { escHtml, avatarColor, loginInitials } from "./utils";
import { setStatus, setView } from "./render";
import { refreshDashboard } from "./api";

// ── Module-level SVG constants (reused in DOM patches) ────────────────────────
const SVG_BRANCH  = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="5" r="1.4"/><path d="M3 4.4v3.2M3 4.5C3 6 5 7 7.6 5.8"/></svg>`;
const SVG_ARROW   = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>`;
const SVG_SPARKLE = `<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1l1.1 3 3 1.1-3 1.1L6 9.2 4.9 6.2 1.9 5.1 4.9 4z"/></svg>`;
const SVG_CHECK   = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`;
const SVG_X       = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`;
const SVG_PLUS    = `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`;
const SVG_JIRA    = `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1L1 6l5 5 1.3-1.3L3.6 6 7.3 2.3z" opacity=".7"/><path d="M6 4.7L8.4 7.1 6 9.5V11l5-5-5-5z"/></svg>`;

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
        <span class="pr-new-badge">${svgSparkle} New pull request</span>
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

        <div class="pr-new-branch-row">
          <span class="pr-new-branch-tag is-source">
            <span style="color:var(--ink-muted);display:inline-flex">${svgBranch}</span>
            ${escHtml(state.draftPrInfo.branch)}
          </span>
          <span style="color:var(--ink-muted);display:inline-flex;flex-shrink:0">${svgArrow}</span>
          <span class="pr-new-branch-tag is-target">
            <span style="color:#a8a8b3;display:inline-flex">${svgBranch}</span>
            <input class="pr-new-base-input" data-new-pr-base type="text"
              value="${escHtml(state.draftBaseBranch)}"
              placeholder="${escHtml(state.draftPrInfo.baseBranch)}"
              title="Base branch" />
          </span>
        </div>

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
      </div>

      <div class="pr-new-footer">
        <label class="pr-new-draft-label${isDraft ? " is-checked" : ""}" data-draft-toggle>
          <span class="pr-new-draft-check">${isDraft ? svgCheck : ""}</span>
          Open as <strong>draft</strong> · skip CI notifications
        </label>
        <div style="flex:1"></div>
        <span class="pr-new-kbd-hint">⌘ + ↵ to open</span>
        <button class="secondary-button" data-close-new-pr type="button">Cancel</button>
        <button class="pr-new-submit-btn${isDraft ? " is-draft" : ""}" data-publish-pr type="button">
          ${isDraft ? "Open draft PR" : "Open pull request"} ${svgArrow}
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

  container.querySelector("[data-draft-toggle]")
    ?.addEventListener("click", () => {
      state.draftAsDraft = !state.draftAsDraft;
      const isDraft = state.draftAsDraft;

      // Patch label check
      const label = container.querySelector<HTMLElement>("[data-draft-toggle]");
      label?.classList.toggle("is-checked", isDraft);
      const check = label?.querySelector<HTMLElement>(".pr-new-draft-check");
      if (check) check.innerHTML = isDraft ? SVG_CHECK : "";

      // Patch submit button label + style
      const submitBtn = container.querySelector<HTMLButtonElement>("[data-publish-pr]");
      if (submitBtn) {
        submitBtn.classList.toggle("is-draft", isDraft);
        submitBtn.innerHTML = `${isDraft ? "Open draft PR" : "Open pull request"} ${SVG_ARROW}`;
      }
    });

  container.querySelectorAll<HTMLButtonElement>("[data-close-new-pr]")
    .forEach(btn => btn.addEventListener("click", closeDraftPrCard));

  container.querySelector("[data-publish-pr]")
    ?.addEventListener("click", () => void publishNewPr(state.draftAsDraft));

  // ⌘/Ctrl + Enter from any input/textarea in the card → publish
  container.querySelectorAll<HTMLElement>("input, textarea")
    .forEach(el => el.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void publishNewPr(state.draftAsDraft);
    }));
}

// ── Close draft PR card ───────────────────────────────────────────────────────

export function closeDraftPrCard() {
  state.draftPrInfo = null;
  state.draftReviewers = [];
  state.draftBody = "";
  state.draftBaseBranch = "";
  state.draftAsDraft = false;
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
    const info = await invoke<{ repo: string; branch: string; baseBranch: string; suggestedTitle: string } | null>("get_draft_pr_info");
    if (!info) {
      setStatus("No unpublished branch found for your account.", "neutral");
      return;
    }
    state.draftPrInfo = info;
    state.draftReviewers = [];
    state.draftBody = "";
    state.draftBaseBranch = info.baseBranch;
    setView("list");
    renderDraftPrCard();
    document.querySelector(".list-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not fetch branch info.", "danger");
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
  }
}

// ── Publish new PR ────────────────────────────────────────────────────────────

export async function publishNewPr(draft: boolean) {
  if (!state.draftPrInfo) return;
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
    const prUrl = await invoke<string>("create_pull_request", {
      repo: state.draftPrInfo.repo,
      title,
      body: state.draftBody,
      head: state.draftPrInfo.branch,
      base: state.draftBaseBranch || state.draftPrInfo.baseBranch,
      reviewers: state.draftReviewers,
      draft,
    });
    closeDraftPrCard();
    setStatus("PR created successfully.", "neutral");
    void refreshDashboard("auto");
    void invoke("open_external", { url: prUrl });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to create pull request.", "danger");
    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.textContent = draft ? "Open draft PR" : "Open pull request";
    }
  }
}
