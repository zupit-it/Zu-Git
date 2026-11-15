// ── GitHub's hourly limits, in the top bar ───────────────────────────────────
// Settings → GitHub turns it on: beside the sync status, how much of the token's
// hourly limit is used, both limits in full on hover. The backend tells when a
// number changed (it reads them off GitHub's answers), so nothing polls: the
// bar is drawn on that, and once more when a limit's hour ends.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { state } from "./state";
import { quotaView, type GithubQuota } from "./github-quota";

let quota: GithubQuota | null = null;
let resetTimer = 0;

/** Draws the limit beside the sync status, or hides it: off in Settings, or nothing heard from GitHub yet. */
export function drawGithubQuota() {
  const el = document.querySelector<HTMLElement>("[data-github-quota]");
  if (!el) return;
  window.clearTimeout(resetTimer);
  const now = Date.now();
  const view = state.githubQuotaEnabled ? quotaView(quota, now) : null;
  el.hidden = !view;
  if (!view) return;
  const value = el.querySelector<HTMLElement>("[data-github-quota-value]");
  if (value && value.textContent !== view.text) value.textContent = view.text;
  el.title = view.title;
  el.dataset.level = view.level;
  // Past its hour's end a limit reads zero again: drawn then, with no answer to say so.
  if (view.nextReset !== null) resetTimer = window.setTimeout(drawGithubQuota, view.nextReset - now + 500);
}

/** Once, at start: what the backend knows already, and every change after that. */
export function initGithubQuota() {
  void listen<GithubQuota>("github-quota", (event) => {
    quota = event.payload;
    drawGithubQuota();
  });
  void invoke<GithubQuota>("github_quota").then((known) => {
    // An answer of GitHub's may have told more already.
    quota ??= known;
    drawGithubQuota();
  }).catch(() => { /* an older backend: nothing to show */ });
}
