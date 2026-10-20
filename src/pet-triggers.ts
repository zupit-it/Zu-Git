// ── Tiny King: what brings him out ────────────────────────────────────────────
// Meme mode only. Each dashboard refresh is compared with the one before: your
// PRs merged; your CIs turning red or changes asked on your PRs; reviews newly
// asking for you or new comments on your PRs. He plays each kind of news in
// turn, the best first, his bubble going through the PRs. Between those, every
// so often (Settings → Fun), he comes knocking about what still waits on you:
// approved PRs of yours not merged, changes to make, reviews to do.

import { invoke } from "@tauri-apps/api/core";
import { getMyChangesRequestedIds, getMyPendingReviewIds } from "./filters";
import { memeMode } from "./meme";
import {
  changesAskedPages, ciFailedPages, commentedPages, mergedPages, reminderPages, reviewAskedPages,
  type PetPage, type PetPr, type PetPrBy,
} from "./pet-lines";
import type { PetAnimation, PetPlay } from "./pet-sprites";
import type { DashboardSnapshot } from "./shared/rpc";
import { normalizeSettings } from "./shared/settings";
import { state } from "./state";

/** PRs of yours gone from the list asked about per refresh, at most. */
const MAX_GONE_CHECKED = 5;
/** How often the reminder looks at whether it is time. */
const NAG_CHECK_MS = 60_000;

/** When he last came out: a reminder waits its whole interval after any visit. */
let lastShownAt = Date.now();

type PetNews = Pick<PetPlay, "animation" | "pages">;

/** Shows him for `news`, one after the other, in one call (pet_play says why). */
export function playPet(
  news: PetNews[],
  { cycles, lingerSeconds } = { cycles: state.petCycles, lingerSeconds: state.petLingerSeconds },
) {
  if (!news.length) return;
  lastShownAt = Date.now();
  const plays: PetPlay[] = news.map((item) => ({ ...item, cycles, lingerMs: lingerSeconds * 1000 }));
  void invoke("pet_play", { plays }).catch(() => {});
}

export async function petReactToDashboard(previous: DashboardSnapshot | null, next: DashboardSnapshot) {
  if (!memeMode() || !previous || previous === next) return;
  if (previous.source !== "live" || next.source !== "live") return;
  const viewer = next.viewerLogin?.toLowerCase();
  if (!viewer) return;

  const key = (pr: { repo: string; id: number }) => `${pr.repo}#${pr.id}`;
  const mine = (pr: { author: string }) => pr.author.toLowerCase() === viewer;
  const before = new Map(previous.prs.map((pr) => [key(pr), pr]));
  const now = new Set(next.prs.map(key));

  // Gone from the open list: merged, closed, or its repo dropped from the settings.
  const gone = previous.prs.filter((pr) => mine(pr) && !now.has(key(pr))).slice(0, MAX_GONE_CHECKED);
  const states = await Promise.all(
    gone.map((pr) => invoke<string>("fetch_pr_state", { repo: pr.repo, number: pr.id }).catch(() => "")),
  );
  const merged = gone.filter((_, i) => states[i] === "merged");

  const red = next.prs.filter(
    (pr) => mine(pr) && pr.hasFailedPipeline && before.get(key(pr))?.hasFailedPipeline === false,
  );

  // Changes newly asked on your PRs, and by whom.
  const changesBefore = getMyChangesRequestedIds(previous);
  const changesNow = getMyChangesRequestedIds(next);
  const changes: PetPrBy[] = next.prs
    .filter((pr) => changesNow.has(key(pr)) && !changesBefore.has(key(pr)))
    .map((pr) => ({ pr, by: pr.blockingReviewers.map((r) => r.login) }));

  // New comments on your PRs: conversations opened, or someone new reviewing
  // with comments only. Yours are not news; nor are those asking for changes,
  // told already.
  const told = new Set(changes.map(({ pr }) => key(pr)));
  const commented: PetPrBy[] = next.prs.flatMap((pr) => {
    const then = before.get(key(pr));
    if (!mine(pr) || !then || told.has(key(pr))) return [];
    const seen = new Set(then.commentedReviewers.map((r) => r.login.toLowerCase()));
    const by = pr.commentedReviewers
      .map((r) => r.login)
      .filter((login) => login.toLowerCase() !== viewer && !seen.has(login.toLowerCase()));
    const threads = Math.max(0, pr.unresolvedThreads - then.unresolvedThreads);
    return by.length || threads ? [{ pr, by, threads }] : [];
  });

  const waitingBefore = getMyPendingReviewIds(previous);
  const asked = [...getMyPendingReviewIds(next)].filter((id) => !waitingBefore.has(id));
  const askedPrs = next.prs.filter((pr) => asked.includes(key(pr)));

  // Bad news is played once, its pages going through each; the same for knocks.
  const today = new Date();
  const bad = [...ciFailedPages(red), ...changesAskedPages(changes)];
  const knocks = [...reviewAskedPages(askedPrs, today), ...commentedPages(commented)];
  const news: PetNews[] = [];
  if (merged.length) news.push({ animation: "pr_merged", pages: mergedPages(merged) });
  if (bad.length) news.push({ animation: "ci_failed", pages: bad });
  if (knocks.length) news.push({ animation: "review_wait", pages: knocks });
  playPet(news);
}

/** What still waits on you, as his bubble would say it; no pages if all is done. */
export function petReminder(snapshot: DashboardSnapshot): PetPage[] {
  const viewer = snapshot.viewerLogin?.toLowerCase();
  if (!viewer) return [];
  // Approved, green, nothing in the way and not set to merge by itself.
  const ready = snapshot.prs.filter(
    (pr) =>
      pr.author.toLowerCase() === viewer &&
      !pr.isDraft &&
      pr.reviewState === "approved" &&
      pr.mergeStatus === "clean" &&
      !pr.hasFailedPipeline &&
      !pr.autoMergeMethod,
  );
  const changeIds = getMyChangesRequestedIds(snapshot);
  const changes = snapshot.prs
    .filter((pr) => changeIds.has(`${pr.repo}#${pr.id}`))
    .map((pr) => ({ pr, by: pr.blockingReviewers.map((r) => r.login) }));
  const reviewIds = getMyPendingReviewIds(snapshot);
  const reviews = snapshot.prs.filter((pr) => reviewIds.has(`${pr.repo}#${pr.id}`));
  return reminderPages({ ready, changes, reviews }, new Date());
}

/** Every so often, in meme mode, he comes knocking about what still waits on you. */
export function installPetReminder() {
  setInterval(() => {
    const snapshot = state.currentDashboard;
    if (!memeMode() || !state.petNagMinutes || !snapshot || snapshot.source !== "live") return;
    if (Date.now() - lastShownAt < state.petNagMinutes * 60_000) return;
    const pages = petReminder(snapshot);
    if (pages.length) playPet([{ animation: "review_wait", pages }]);
  }, NAG_CHECK_MS);
}

/** A PR to try him out with, opened three days ago and touched this morning. */
function samplePr(extra: Partial<PetPr> = {}): PetPr {
  const day = 86_400_000;
  return {
    repo: "zupit-it/zugit",
    id: 42,
    title: "Prova del Tiny King: così ti avviso",
    author: "marco",
    createdAtIso: new Date(Date.now() - 3 * day).toISOString(),
    updatedAtIso: new Date(Date.now() - day / 8).toISOString(),
    ...extra,
  };
}

/** Settings → Fun: tries him out with the form as it is, saved or not. The
 *  knock brings the real reminder when something does wait on you. */
export function petTry(animation: Exclude<PetAnimation, "idle">, form: HTMLFormElement | null) {
  const field = (name: string) => (form?.elements.namedItem(name) as HTMLInputElement | null)?.value;
  const settings = normalizeSettings({ petCycles: field("petCycles"), petLingerSeconds: field("petLingerSeconds") });
  const real = animation === "review_wait" && state.currentDashboard ? petReminder(state.currentDashboard) : [];
  // The sample PR is not real: a click on him then only brings ZuGit up.
  const sample = (pages: PetPage[]) => pages.map(({ pr: _, ...page }) => page);
  const pages =
    animation === "pr_merged" ? sample(mergedPages([samplePr()]))
    : animation === "ci_failed" ? sample(ciFailedPages([samplePr({ failedChecks: ["build", "lint"] })]))
    : real.length ? real
    : sample(reviewAskedPages([samplePr()], new Date()));
  playPet([{ animation, pages }], { cycles: settings.petCycles, lingerSeconds: settings.petLingerSeconds });
}
