// ── Auto-merge and rebase from the PR list ───────────────────────────────────
// Both are GitHub's own operations, done by GitHub under its rules (branch
// protection, required reviews and checks): ZuGit never touches a local clone.
// What the viewer may do comes from GitHub (`mergeActions`), never from a guess.
//
// What was just done shows on the row at once, as waiting, until GitHub shows
// it too (`trackGitHubChange`): the list itself is only ever what GitHub said.
//
// Auto-merge waits for those rules and can be turned off until it merges.
// Rebase rewrites the branch, so it always asks first — more plainly on someone
// else's PR, whose author may be working on it — and only ever rebases the
// commit on screen (`expectedHeadOid`): a push meanwhile, or a conflict, and
// GitHub refuses with nothing changed.

import { invoke } from "@tauri-apps/api/core";
import type { PullRequestSummary } from "./shared/pr-model";
import { state } from "./state";
import { setStatus } from "./render";
import { trackGitHubChange } from "./api";
import { autoMergeIs } from "./pending-changes";
import { firstName, rebaseNoticeMessage, slackMember } from "./slack-people";
import { openSlackDm } from "./slack";
import { closePopover, openPopover } from "./popover";
import { escHtml, errorMessage, relativeTime } from "./utils";

const METHOD_LABELS: Record<string, string> = {
  SQUASH: "Squash and merge",
  MERGE: "Create a merge commit",
  REBASE: "Rebase and merge",
};

/** GitHub takes a moment to rebase: the read of the list waits for it, so that one is enough. */
const REBASE_READ_MS = 5000;

/**
 * GitHub refuses auto-merge on a PR it could merge right now ("Pull request is
 * in clean status", or unstable, or has_hooks). The list does not offer it
 * then; this is for a status that went stale since. Any other status GitHub
 * names is not that, and is shown as GitHub said it.
 */
const MERGEABLE_NOW = "GitHub can merge this PR right now, so auto-merge has nothing to wait for: merge it on GitHub.";
const MERGEABLE_NOW_REFUSAL = /is in (clean|unstable|has_hooks) status/i;

function prOf(trigger: HTMLElement, attribute: "autoMerge" | "rebase"): PullRequestSummary | undefined {
  const key = trigger.dataset[attribute];
  return state.currentDashboard?.prs.find((p) => `${p.repo}/${p.id}` === key);
}

/** The popover under the chip that opened it; `focus` names what takes the focus. */
function openActionPopover(trigger: HTMLElement, html: string, focus: string): HTMLElement {
  return openPopover(trigger, html, { className: "pra-popover", focus });
}

/** What GitHub said, and what to do about it when it is the token's doing. */
function refusal(error: unknown): string {
  const message = errorMessage(error, "GitHub refused.");
  if (/not accessible|permission|forbidden|\b403\b/i.test(message)) {
    return `${message} — the GitHub token in Settings needs write access: Pull requests and Contents, Read and write.`;
  }
  return message;
}

function showError(el: HTMLElement, message: string) {
  const target = el.querySelector<HTMLElement>("[data-pra-error]");
  if (target) { target.textContent = message; target.hidden = false; }
}

function busy(button: HTMLButtonElement | null, on: boolean) {
  if (!button) return;
  button.disabled = on;
  button.classList.toggle("is-loading", on);
}

// ── Auto-merge ────────────────────────────────────────────────────────────────

/**
 * Auto-merge went on with `method`, or off, and GitHub said so: the row shows
 * it at once, as waiting. Whether its chip is a button again — what the viewer
 * may do next — comes with GitHub's next snapshot, not from a guess.
 */
function autoMergeTurned(pr: PullRequestSummary, method: string | null) {
  closePopover();
  trackGitHubChange(pr, "auto-merge", { label: method ? "Auto-merge on" : "Auto-merge off", patch: autoMergeIs(method) });
}

export function showAutoMergePopover(trigger: HTMLButtonElement) {
  const pr = prOf(trigger, "autoMerge");
  const actions = pr?.mergeActions;
  if (!pr || !actions) return;
  const name = `${escHtml(pr.repo)}#${pr.id}`;

  if (pr.autoMergeMethod) {
    const method = METHOD_LABELS[pr.autoMergeMethod] ?? pr.autoMergeMethod.toLowerCase();
    const el = openActionPopover(trigger, `
      <div class="arv-header">Auto-merge is on</div>
      <p class="pra-text">GitHub will merge ${name} with <strong>${escHtml(method)}</strong> as soon as its reviews and checks allow it.</p>
      <p class="pra-error" data-pra-error hidden></p>
      <div class="pra-actions">
        <button class="pd-ai-btn" type="button" data-popover-close>Keep it</button>
        <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Turn off auto-merge</button>
      </div>`, "[data-pra-go]");
    const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
    go?.addEventListener("click", async () => {
      busy(go, true);
      try {
        await invoke("set_auto_merge", { repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, method: null, headSha: pr.headSha });
        setStatus(`Auto-merge off for ${name}.`);
        autoMergeTurned(pr, null);
      } catch (error) {
        busy(go, false);
        showError(el, refusal(error));
      }
    });
    return;
  }

  const methods = actions.autoMergeMethods;
  const only = methods[0];
  if (only === undefined) return;
  const options = methods.map((method, i) => `
    <label class="pra-method">
      <input type="radio" name="pra-method" value="${escHtml(method)}"${i === 0 ? " checked" : ""}>
      <span>${escHtml(METHOD_LABELS[method] ?? method)}${i === 0 ? ` <span class="pra-default">default</span>` : ""}</span>
    </label>`).join("");
  const queue = state.mergeQueueEnabled
    ? `<p class="pra-note">The merge queue is on: once this PR is first in its queue, ZuGit may rebase it on its own.</p>`
    : "";
  const el = openActionPopover(trigger, `
    <div class="arv-header">Auto-merge</div>
    <p class="pra-text">GitHub merges ${name} by itself once its required reviews and checks pass. Until then you can turn it off here.</p>
    ${methods.length > 1 ? `<div class="pra-methods">${options}</div>` : `<p class="pra-text">With <strong>${escHtml(METHOD_LABELS[only] ?? only)}</strong>, the only method this repo allows.</p>`}
    ${queue}
    <p class="pra-error" data-pra-error hidden></p>
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>Cancel</button>
      <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Turn on auto-merge</button>
    </div>`, "[data-pra-go]");
  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  go?.addEventListener("click", async () => {
    const method = el.querySelector<HTMLInputElement>("input[name=pra-method]:checked")?.value ?? only;
    busy(go, true);
    try {
      const on = await invoke<string | null>("set_auto_merge", {
        repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, method, headSha: pr.headSha,
      });
      setStatus(`Auto-merge on for ${name}: GitHub merges it once reviews and checks allow it.`);
      autoMergeTurned(pr, on ?? method);
    } catch (error) {
      busy(go, false);
      const message = errorMessage(error, "");
      showError(el, MERGEABLE_NOW_REFUSAL.test(message) ? MERGEABLE_NOW : refusal(error));
    }
  });
}

// ── Rebase ────────────────────────────────────────────────────────────────────

function isMine(pr: PullRequestSummary): boolean {
  const viewer = state.currentDashboard?.viewerLogin?.toLowerCase();
  return !!viewer && pr.author.toLowerCase() === viewer;
}

/** The author as the team calls them: their Slack first name, else their login. */
function authorName(pr: PullRequestSummary): string {
  return firstName(slackMember(state.slackDirectory, pr.author)?.slackName) ?? pr.author;
}

export function showRebasePopover(trigger: HTMLButtonElement) {
  const pr = prOf(trigger, "rebase");
  if (!pr?.mergeActions?.canUpdateBranch || !pr.nodeId || !pr.headSha) return;
  const head = `<code>${escHtml(pr.headRef)}</code>`;
  const base = `<code>${escHtml(pr.baseRef)}</code>`;
  const mine = isMine(pr);
  const author = escHtml(authorName(pr));
  const authored = pr.mergeActions.headAuthoredAt;

  const what = mine
    ? `<p class="pra-text">Replays the commits of ${head} on top of ${base}, as GitHub's “Update with rebase”. They get new SHAs: if you have the branch locally, run <code>git pull --rebase</code> before working on it.</p>`
    : `<div class="pra-warn">This branch is <strong>${author}</strong>'s${authored ? `, last commit ${escHtml(relativeTime(authored))}` : ""}.</div>
       <p class="pra-text">Replays the commits of ${head} on top of ${base}, rewriting them. If ${author} has work not pushed yet, they will need <code>git pull --rebase</code> before their next push — and a force-push of theirs would undo the rebase.</p>`;
  // It rewrites a branch: the focus starts on Cancel, so a repeated Enter does nothing.
  const el = openActionPopover(trigger, `
    <div class="arv-header">Rebase on ${escHtml(pr.baseRef)}</div>
    ${what}
    <p class="pra-note">If someone pushes meanwhile, or there are conflicts, GitHub refuses and nothing changes.</p>
    <p class="pra-error" data-pra-error hidden></p>
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>Cancel</button>
      <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>${mine ? "Rebase" : `Rebase ${author}'s branch`}</button>
    </div>`, "[data-popover-close]");

  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  go?.addEventListener("click", async () => {
    busy(go, true);
    const key = `${pr.repo}/${pr.id}`;
    try {
      await invoke("rebase_pull_request", { repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, headSha: pr.headSha });
    } catch (error) {
      busy(go, false);
      showError(el, refusal(error));
      return;
    }
    // The merge queue, if on, does not ask GitHub for the same rebase again.
    state.queueRebaseTriggeredFor.add(key);
    // Nor does the row: it says "Rebasing…" until the branch shows its new head.
    trackGitHubChange(pr, "rebase", { label: "Rebase", readIn: REBASE_READ_MS });
    const done = `Rebase of ${escHtml(pr.repo)}#${pr.id} on ${escHtml(pr.baseRef)} started: GitHub updates the branch in a few seconds. It was at <code>${escHtml(pr.headSha.slice(0, 7))}</code>.`;
    setStatus(done);
    if (mine) { closePopover(); return; }
    offerNotice(el, pr);
  });
}

/** After rebasing someone else's branch: tell them, on Slack, in a message they read before working on it. */
function offerNotice(el: HTMLElement, pr: PullRequestSummary) {
  // No longer about the row it opened from: it stays when the list is read again.
  el.setAttribute("data-popover-stay", "");
  const author = escHtml(authorName(pr));
  const person = slackMember(state.slackDirectory, pr.author);
  el.innerHTML = `
    <div class="arv-header">Rebase started</div>
    <p class="pra-text">GitHub updates <code>${escHtml(pr.headRef)}</code> in a few seconds.</p>
    ${person
      ? `<p class="pra-text">Let ${author} know? Slack opens on your chat with a message on the clipboard: what happened and to run <code>git pull --rebase</code>. You paste it and send it.</p>`
      : `<p class="pra-text">${author} is not in the Slack table (Settings → Slack): let them know yourself that their branch was rebased.</p>`}
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>${person ? "Not now" : "Close"}</button>
      ${person ? `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Tell ${author} on Slack</button>` : ""}
    </div>`;
  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  go?.focus();
  go?.addEventListener("click", async () => {
    if (!person) return;
    busy(go, true);
    await openSlackDm(person, rebaseNoticeMessage(pr, person.slackName));
    closePopover();
  });
}
