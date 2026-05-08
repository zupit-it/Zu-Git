import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { escHtml } from "./utils";
import { setStatus, setView } from "./render";
import { refreshDashboard } from "./api";

// ── Draft PR card render ──────────────────────────────────────────────────────

export function renderDraftPrCard() {
  const container = document.querySelector<HTMLElement>("[data-new-pr-container]");
  if (!container || !state.draftPrInfo) return;

  const reviewerPillsHtml = state.draftReviewers
    .map(login =>
      `<span class="pr-new-reviewer-pill">
        ${escHtml(login)}
        <button class="pr-new-reviewer-pill-remove" data-remove-reviewer="${escHtml(login)}" type="button" title="Remove">×</button>
      </span>`)
    .join("");

  const pickerItemsHtml = state.currentCollaborators
    .filter(login => login !== (state.currentDashboard?.viewerLogin ?? ""))
    .map(login => {
      const selected = state.draftReviewers.includes(login);
      return `<button class="pr-new-reviewer-picker-item${selected ? " is-selected" : ""}" data-pick-reviewer="${escHtml(login)}" type="button">
        ${selected ? "✓ " : ""}${escHtml(login)}
      </button>`;
    })
    .join("");

  container.innerHTML = `
    <div class="pr-list-wrap pr-new-wrap" data-new-pr-card>
      <div class="pr-row">
        <div class="pr-row-bar"></div>
        <div style="min-width:0">
          <input class="pr-new-title-input" data-new-pr-title type="text"
            value="${escHtml(state.draftPrInfo.suggestedTitle)}"
            placeholder="Pull request title…" />
          <textarea class="pr-new-title-input" data-new-pr-body
            rows="2" placeholder="Description (optional)"
            style="resize:vertical;margin-bottom:8px">${escHtml(state.draftBody)}</textarea>
          <div class="pr-new-meta">
            <span class="chip ghost" style="font-family:var(--font-mono);font-size:11px">${escHtml(state.draftPrInfo.repo)}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 5h6M5 2l3 3-3 3"/></svg>
            <span class="chip neutral" style="font-family:var(--font-mono);font-size:11px">${escHtml(state.draftPrInfo.branch)}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 5h6M5 2l3 3-3 3"/></svg>
            <input class="pr-new-base-input" data-new-pr-base type="text"
              value="${escHtml(state.draftBaseBranch)}"
              placeholder="${escHtml(state.draftPrInfo.baseBranch)}"
              title="Base branch" />
          </div>
        </div>
        <div class="pr-new-reviewers">
          <div class="pr-new-reviewer-pills">${reviewerPillsHtml}</div>
          ${pickerItemsHtml
            ? `<button class="chip ghost pr-new-add-reviewer" data-toggle-reviewer-picker type="button">+ Add reviewer</button>
               <div class="pr-new-reviewer-picker" data-reviewer-picker hidden>${pickerItemsHtml}</div>`
            : ""}
        </div>
        <div>
          <span class="pr-new-hint">New pull request</span>
        </div>
        <div class="pr-new-actions">
          <button class="secondary-button" data-publish-draft type="button">Publish draft</button>
          <button class="primary-button" data-publish-pr type="button">Publish</button>
          <button class="pr-new-close" data-close-new-pr type="button" title="Dismiss">×</button>
        </div>
      </div>
    </div>`;

  container.querySelector<HTMLInputElement>("[data-new-pr-title]")
    ?.addEventListener("input", e => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      state.draftPrInfo!.suggestedTitle = (e.target as HTMLInputElement).value;
    });

  container.querySelector<HTMLTextAreaElement>("[data-new-pr-body]")
    ?.addEventListener("input", e => {
      state.draftBody = (e.target as HTMLTextAreaElement).value;
    });

  container.querySelector<HTMLInputElement>("[data-new-pr-base]")
    ?.addEventListener("input", e => {
      state.draftBaseBranch = (e.target as HTMLInputElement).value;
    });

  container.querySelector("[data-toggle-reviewer-picker]")
    ?.addEventListener("click", () => {
      const picker = container.querySelector<HTMLElement>("[data-reviewer-picker]");
      if (picker) picker.hidden = !picker.hidden;
    });

  container.querySelectorAll<HTMLButtonElement>("[data-pick-reviewer]")
    .forEach(btn => btn.addEventListener("click", () => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const login = btn.dataset.pickReviewer!;
      if (state.draftReviewers.includes(login)) {
        state.draftReviewers = state.draftReviewers.filter(r => r !== login);
      } else {
        state.draftReviewers = [...state.draftReviewers, login];
      }
      renderDraftPrCard();
    }));

  container.querySelectorAll<HTMLButtonElement>("[data-remove-reviewer]")
    .forEach(btn => btn.addEventListener("click", () => {
      state.draftReviewers = state.draftReviewers.filter(r => r !== btn.dataset.removeReviewer);
      renderDraftPrCard();
    }));

  container.querySelector("[data-close-new-pr]")
    ?.addEventListener("click", closeDraftPrCard);

  container.querySelector("[data-publish-draft]")
    ?.addEventListener("click", () => void publishNewPr(true));
  container.querySelector("[data-publish-pr]")
    ?.addEventListener("click", () => void publishNewPr(false));
}

// ── Close draft PR card ───────────────────────────────────────────────────────

export function closeDraftPrCard() {
  state.draftPrInfo = null;
  state.draftReviewers = [];
  state.draftBody = "";
  state.draftBaseBranch = "";
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

  const publishBtn = container?.querySelector<HTMLButtonElement>(draft ? "[data-publish-draft]" : "[data-publish-pr]");
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
    setStatus(`PR created successfully.`, "neutral");
    void refreshDashboard("auto");
    void invoke("open_external", { url: prUrl });
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to create pull request.", "danger");
    if (publishBtn) { publishBtn.disabled = false; publishBtn.textContent = draft ? "Publish draft" : "Publish"; }
  }
}
