// ── Auto-merge and rebase from the PR list ───────────────────────────────────
// Both are GitHub's own operations, done by GitHub under its rules (branch
// protection, required reviews and checks): ZuGit never touches a local clone.
// What the viewer may do comes from GitHub (`mergeActions`), never from a guess.
//
// The list is only ever what GitHub said. An auto-merge switch is answered by
// GitHub with the PR as it now is, and that answer is the row at once. A rebase
// GitHub does after answering: its row says so, as waiting, until the PR is
// read again (`trackGitHubChange`).
//
// Auto-merge waits for those rules and can be turned off until it merges. From
// ZuGit it goes on by "Squash and merge" only — one commit on the base for the
// whole PR: a merge commit, or the PR's commits rebased onto the base, are not
// offered even where the repo allows them.
// Rebase rewrites the branch, so it always asks first — more plainly on someone
// else's PR, whose author may be working on it — and only ever rebases the
// commit on screen (`expectedHeadOid`): a push meanwhile, or a conflict, and
// GitHub refuses with nothing changed.

import { invoke } from "@tauri-apps/api/core";
import type { PullRequestSummary } from "./shared/pr-model";
import { state } from "./state";
import { setStatus } from "./render";
import { gitHubAnswered, gitHubSaysNow, trackGitHubChange } from "./api";
import { autoMergeIs } from "./pending-changes";
import { firstName, rebaseNoticeMessage, slackMember } from "./slack-people";
import { openSlackDm } from "./slack";
import { closePopover, holdPopover, openPopover } from "./popover";
import { escHtml, errorMessage, relativeTime } from "./utils";

/** How GitHub calls the method an auto-merge is on with — set there, it may be any of the three. */
const METHOD_LABELS: Record<string, string> = {
  SQUASH: "Squash and merge",
  MERGE: "Create a merge commit",
  REBASE: "Rebase and merge",
};
/** The one ZuGit turns it on with. */
const SQUASH = "SQUASH";

/** GitHub takes a moment to rebase: the PR's read waits for it, so that one is enough. */
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

/** In the popover that asked; in the status, should it be gone (GitHub took too long and it was closed). */
function showError(el: HTMLElement, message: string) {
  const target = el.querySelector<HTMLElement>("[data-pra-error]");
  if (!el.isConnected || !target) { setStatus(escHtml(message), "danger"); return; }
  // It stays until closed by hand: a list drawn again meanwhile must not take the message away unread.
  el.setAttribute("data-popover-stay", "");
  target.textContent = message;
  target.hidden = false;
}

/** What a refusal comes to: the message to show in the popover, or null when it has been said already. */
type Refused = (error: unknown) => string | null | Promise<string | null>;

/**
 * Asks GitHub for what the popover's button says, the popover staying up until
 * the answer: it cannot be closed meanwhile, so a refusal is read where it was
 * asked. Gives the answer back; on a refusal, says it there and gives nothing.
 */
async function ask<T>(el: HTMLElement, go: HTMLButtonElement, request: () => Promise<T>, refused: Refused = refusal): Promise<{ answer: T } | null> {
  busy(go, true);
  const release = holdPopover(el);
  try {
    return { answer: await request() };
  } catch (error) {
    const message = await refused(error);
    busy(go, false);
    if (message !== null) showError(el, message);
    return null;
  } finally {
    release();
  }
}

/**
 * GitHub refused something asked for the commit on screen (`expectedHeadOid`).
 * The likeliest reason is that the list was behind: someone pushed to the
 * branch, or rebased it already, or the PR was merged. So the PR is read, at
 * once — and that is its row from here on. If its head is no longer the one
 * the popover was about, the popover says that, plainly, in place of GitHub's
 * own wording, and offers nothing more: it was about a commit that is gone.
 * Otherwise the refusal is GitHub's to explain (a conflict, a rule).
 */
async function refusedOnHead(el: HTMLElement, pr: PullRequestSummary, error: unknown, undone: string): Promise<string | null> {
  const now = await gitHubSaysNow(pr);
  if (now === undefined || (now !== null && now.headSha === pr.headSha)) return refusal(error);
  const name = `${escHtml(pr.repo)}#${pr.id}`;
  const head = `<code>${escHtml(pr.headRef)}</code>`;
  const why = now === null
    ? `${name} is no longer open: it was merged or closed since ZuGit last read the list.`
    : `${head} has moved since ZuGit last read it: someone pushed to it, or rebased it already. GitHub changed nothing.`;
  const next = now === null
    ? ""
    : now.mergeStatus === "behind"
      ? ` Its row now shows it as it is — still behind <code>${escHtml(now.baseRef)}</code>: open it again from there.`
      : " Its row now shows it as it is.";
  if (!el.isConnected) { setStatus(`${undone}: ${why}${next}`); return null; }
  // No longer about the row it opened from: it stays when the list is drawn again.
  el.setAttribute("data-popover-stay", "");
  el.innerHTML = `
    <div class="arv-header">${undone}</div>
    <p class="pra-text">${why}${next}</p>
    <div class="pra-actions">
      <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-popover-close>Close</button>
    </div>`;
  el.querySelector<HTMLElement>("[data-popover-close]")?.focus();
  return null;
}

function busy(button: HTMLButtonElement | null, on: boolean) {
  if (!button) return;
  button.disabled = on;
  button.classList.toggle("is-loading", on);
}

// ── Auto-merge ────────────────────────────────────────────────────────────────

/** What the backend gives back of an auto-merge switch (`set_auto_merge`). */
interface AutoMergeSet {
  /** The method it is on with, as GitHub answered; null when it is off. */
  method: string | null;
  /** The PR after the switch, as the list holds it, when GitHub's answer brought it. */
  pullRequest: PullRequestSummary | null;
}

/**
 * Auto-merge went on or off, and GitHub answered with the PR as it now is:
 * that is the row at once, what the viewer may do next included, with nothing
 * to wait for or to read. Should the answer come without the PR, the row shows
 * the switch as waiting and the PR is read, as after any other change.
 */
function autoMergeTurned(el: HTMLElement, pr: PullRequestSummary, set: AutoMergeSet) {
  closePopover(el);
  if (set.pullRequest) gitHubAnswered(pr, set.pullRequest);
  else trackGitHubChange(pr, "auto-merge", { label: set.method ? "Auto-merge on" : "Auto-merge off", patch: autoMergeIs(set.method) });
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
      const done = await ask(el, go, () =>
        invoke<AutoMergeSet>("set_auto_merge", { repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, on: false, headSha: pr.headSha }));
      if (!done) return;
      setStatus(`Auto-merge off for ${name}.`);
      autoMergeTurned(el, pr, done.answer);
    });
    return;
  }

  if (!actions.canEnableAutoMerge) return;
  const queue = state.mergeQueueEnabled
    ? `<p class="pra-note">The merge queue is on: once this PR is first in its queue, ZuGit may rebase it on its own.</p>`
    : "";
  const el = openActionPopover(trigger, `
    <div class="arv-header">Auto-merge</div>
    <p class="pra-text">GitHub merges ${name} by itself once its required reviews and checks pass, by <strong>${METHOD_LABELS[SQUASH]}</strong>: one commit on <code>${escHtml(pr.baseRef)}</code> for the whole PR. Until then you can turn it off here.</p>
    <label class="pra-field">
      <span>Commit message</span>
      <input type="text" data-pra-headline value="${escHtml(`${pr.title.trim()} (#${pr.id})`)}" spellcheck="false">
    </label>
    ${queue}
    <p class="pra-error" data-pra-error hidden></p>
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>Cancel</button>
      <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Turn on auto-merge</button>
    </div>`, "[data-pra-go]");
  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  // The message of the one commit the squash makes, as GitHub proposes it: the PR's title and number.
  const headline = el.querySelector<HTMLInputElement>("[data-pra-headline]");
  headline?.addEventListener("keydown", (event) => { if (event.key === "Enter") go?.click(); });
  go?.addEventListener("click", async () => {
    const done = await ask(
      el, go,
      () => invoke<AutoMergeSet>("set_auto_merge", {
        repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, on: true, headSha: pr.headSha,
        commitHeadline: headline?.value.trim() || null,
      }),
      (error) => (MERGEABLE_NOW_REFUSAL.test(errorMessage(error, ""))
        ? MERGEABLE_NOW
        : refusedOnHead(el, pr, error, "Auto-merge not turned on")),
    );
    if (!done) return;
    setStatus(`Auto-merge on for ${name}: GitHub squashes and merges it once reviews and checks allow it.`);
    autoMergeTurned(el, pr, { ...done.answer, method: done.answer.method ?? SQUASH });
  });
}

// ── Rebase ────────────────────────────────────────────────────────────────────

function isMine(pr: PullRequestSummary): boolean {
  const viewer = state.currentDashboard?.viewerLogin?.toLowerCase();
  return !!viewer && pr.author.toLowerCase() === viewer;
}

export function showRebasePopover(trigger: HTMLButtonElement) {
  const pr = prOf(trigger, "rebase");
  if (!pr?.mergeActions?.canUpdateBranch || !pr.nodeId || !pr.headSha) return;
  const head = `<code>${escHtml(pr.headRef)}</code>`;
  const base = `<code>${escHtml(pr.baseRef)}</code>`;
  const mine = isMine(pr);
  const authored = pr.mergeActions.headAuthoredAt;

  // Whose branch it is, its row says: here, only that it is not the viewer's, and how fresh its last commit.
  const what = mine
    ? `<p class="pra-text">Replays the commits of ${head} on top of ${base}, as GitHub's “Update with rebase”. They get new SHAs: if you have the branch locally, run <code>git pull --rebase</code> before working on it.</p>`
    : `<div class="pra-warn"><strong>Not your branch</strong>${authored ? ` · last commit ${escHtml(relativeTime(authored))}` : ""}</div>
       <p class="pra-text">Replays the commits of ${head} on top of ${base}, rewriting them. If its author has work not pushed yet, they will need <code>git pull --rebase</code> before their next push — and a force-push of theirs would undo the rebase.</p>`;
  // It rewrites a branch: the focus starts on Cancel, so a repeated Enter does nothing.
  const el = openActionPopover(trigger, `
    <div class="arv-header">Rebase on ${escHtml(pr.baseRef)}</div>
    ${what}
    <p class="pra-note">If someone pushes meanwhile, or there are conflicts, GitHub refuses and nothing changes.</p>
    <p class="pra-error" data-pra-error hidden></p>
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>Cancel</button>
      <button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Rebase</button>
    </div>`, "[data-popover-close]");

  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  go?.addEventListener("click", async () => {
    const key = `${pr.repo}/${pr.id}`;
    const rebased = await ask(
      el, go,
      () => invoke("rebase_pull_request", { repo: pr.repo, prNumber: pr.id, nodeId: pr.nodeId, headSha: pr.headSha }),
      (error) => refusedOnHead(el, pr, error, "Not rebased"),
    );
    if (!rebased) return;
    // The merge queue, if on, does not ask GitHub for the same rebase again.
    state.queueRebaseTriggeredFor.add(key);
    // Nor does the row: it says "Rebasing…" until the branch shows its new head.
    trackGitHubChange(pr, "rebase", { label: "Rebase", readIn: REBASE_READ_MS });
    const done = `Rebase of ${escHtml(pr.repo)}#${pr.id} on ${escHtml(pr.baseRef)} started: GitHub updates the branch in a few seconds. It was at <code>${escHtml(pr.headSha.slice(0, 7))}</code>.`;
    setStatus(done);
    if (mine) { closePopover(el); return; }
    offerNotice(el, pr);
  });
}

/** After rebasing someone else's branch: tell them, on Slack, in a message they read before working on it. */
function offerNotice(el: HTMLElement, pr: PullRequestSummary) {
  // No longer about the row it opened from: it stays when the list is read again.
  el.setAttribute("data-popover-stay", "");
  const person = slackMember(state.slackDirectory, pr.author);
  // By first name when Slack has a real one; a login would only be long.
  const who = escHtml(firstName(person?.slackName) ?? "them");
  el.innerHTML = `
    <div class="arv-header">Rebase started</div>
    <p class="pra-text">GitHub updates <code>${escHtml(pr.headRef)}</code> in a few seconds.</p>
    ${person
      ? `<p class="pra-text">Let ${who} know? Slack opens on your chat with a message on the clipboard: what happened and to run <code>git pull --rebase</code>. You paste it and send it.</p>`
      : `<p class="pra-text">The author is not in the Slack table (Settings → Slack): let them know yourself that their branch was rebased.</p>`}
    <div class="pra-actions">
      <button class="pd-ai-btn" type="button" data-popover-close>${person ? "Not now" : "Close"}</button>
      ${person ? `<button class="pd-ai-btn pd-ai-btn--primary" type="button" data-pra-go>Tell ${who} on Slack</button>` : ""}
    </div>`;
  const go = el.querySelector<HTMLButtonElement>("[data-pra-go]");
  go?.focus();
  go?.addEventListener("click", async () => {
    if (!person) return;
    busy(go, true);
    await openSlackDm(person, rebaseNoticeMessage(pr, person.slackName));
    closePopover(el);
  });
}
