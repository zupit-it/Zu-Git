// ── Tiny King: what he says ───────────────────────────────────────────────────
// His bubble's pages, in his own voice: a line picked at random for the news,
// the PR's title under it, and a note on who waits and since when, or on which
// checks failed. Pure, so it can be tested: the random pick is passed in.

import type { PullRequestSummary } from "./shared/pr-model";

export interface PetPage {
  title: string;
  /** The PR's title, as a rule. */
  detail?: string;
  /** Who, since when, which checks: small print under the rest. */
  note?: string;
}

/** Picks one of `count` lines. */
export type Choose = (count: number) => number;
export const chooseAtRandom: Choose = (count) => Math.floor(Math.random() * count);

export type PetPr = Pick<
  PullRequestSummary,
  "repo" | "id" | "title" | "author" | "createdAtIso" | "updatedAtIso" | "failedChecks"
>;

/** A PR of yours and who did something on it: asked for changes, or commented. */
export interface PetPrBy {
  pr: PetPr;
  by: string[];
  /** Conversations opened on it since the last look, for comments. */
  threads?: number;
}

/** Pages in one bubble, at most: each stays a few seconds. */
export const MAX_PAGES = 4;
/** Failed checks named in a note, at most. */
const MAX_CHECKS = 3;

const LINES = {
  merged: [
    "Evviva! {ref} entra nel regno",
    "Squillino le trombe: {ref} è mergiata!",
    "{ref} è mergiata: festa a corte!",
  ],
  mergedMany: [
    "Giornata di festa: {n} PR mergiate!",
    "Squillino le trombe: {n} PR entrano nel regno",
  ],
  ciFailed: [
    "Sventura! La CI di {ref} è caduta",
    "La CI di {ref} piange, messere",
    "{ref}: la CI è rossa come il mio mantello",
  ],
  ciFailedMany: [
    "Sventura! {n} CI sono cadute",
    "Il regno trema: {n} CI rosse",
  ],
  // {who} may be one person or several: no verb agrees with it.
  changesAsked: [
    "Sventura! Modifiche chieste su {ref} da {who}",
    "{ref} rimandata a corte da {who}",
    "Ahimè, niente approvazione per {ref}: parola di {who}",
  ],
  changesAskedMany: [
    "Sventura! Modifiche chieste su {n} PR",
    "Il regno vacilla: {n} PR da correggere",
  ],
  commented: [
    "Nuovi commenti su {ref} da {who}",
    "Messere, si discute di {ref}",
    "Voci di corte su {ref}: parola di {who}",
  ],
  commentedMany: [
    "Nuovi commenti su {n} tue PR",
    "Si mormora a corte: {n} PR commentate",
  ],
  reviewAsked: [
    "Toc toc! {ref} chiede udienza",
    "Un suddito chiede la tua review: {ref}",
    "{ref} implora il tuo giudizio",
  ],
  reviewsAsked: [
    "{n} sudditi chiedono udienza",
    "{n} nuove review per te, messere",
  ],
  readyToMerge: [
    "{ref} è approvata: che aspetti a mergiarla?",
    "Il popolo attende il merge di {ref}",
  ],
  changesStillWaiting: [
    "{ref} aspetta ancora le tue modifiche",
    "Le modifiche a {ref} non si fanno da sole",
  ],
  reviewStillWaiting: [
    "{ref} attende ancora la tua review",
    "Toc toc! {ref} è ancora in anticamera",
  ],
  reminder: [
    "Messere, ti aspettano {what}",
    "Il regno attende: {what}",
  ],
};

function line(pool: string[], choose: Choose, vars: Record<string, string | number>): string {
  const template = pool[Math.min(pool.length - 1, Math.max(0, choose(pool.length)))];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}

/** `zugit#42`: the repo without its owner, enough to tell PRs apart. */
export function prRef(pr: Pick<PetPr, "repo" | "id">): string {
  return `${pr.repo.split("/").pop()}#${pr.id}`;
}

/** "da 3 giorni", for how long something has been waiting. */
export function since(iso: string, now: Date): string {
  const minutes = (now.getTime() - new Date(iso).getTime()) / 60_000;
  if (!Number.isFinite(minutes) || minutes < 60) return "da poco";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "da un'ora" : `da ${hours} ore`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "da un giorno" : `da ${days} giorni`;
}

/** One PR's page, or for several a count first and then the first few. */
function onePerPr<T>(items: T[], many: string[], choose: Choose, page: (item: T) => PetPage): PetPage[] {
  if (items.length <= 1) return items.map(page);
  return [{ title: line(many, choose, { n: items.length }) }, ...items.slice(0, MAX_PAGES - 1).map(page)];
}

/** "marco", "marco e luca", "marco, luca e altri 2"; someone when nobody is named. */
export function people(logins: string[]): string {
  if (!logins.length) return "qualcuno";
  if (logins.length === 1) return logins[0];
  if (logins.length === 2) return `${logins[0]} e ${logins[1]}`;
  return `${logins[0]}, ${logins[1]} e altri ${logins.length - 2}`;
}

export function mergedPages(prs: PetPr[], choose: Choose = chooseAtRandom): PetPage[] {
  return onePerPr(prs, LINES.mergedMany, choose, (pr) => ({
    title: line(LINES.merged, choose, { ref: prRef(pr) }),
    detail: pr.title,
  }));
}

export function ciFailedPages(prs: PetPr[], choose: Choose = chooseAtRandom): PetPage[] {
  return onePerPr(prs, LINES.ciFailedMany, choose, (pr) => {
    const checks = pr.failedChecks ?? [];
    const named = checks.slice(0, MAX_CHECKS).join(", ");
    const more = checks.length > MAX_CHECKS ? ` e altri ${checks.length - MAX_CHECKS}` : "";
    return {
      title: line(LINES.ciFailed, choose, { ref: prRef(pr) }),
      detail: pr.title,
      note: checks.length ? `${checks.length === 1 ? "Check fallito" : "Check falliti"}: ${named}${more}` : undefined,
    };
  });
}

/** Changes newly asked on your PRs, by whom. */
export function changesAskedPages(items: PetPrBy[], choose: Choose = chooseAtRandom): PetPage[] {
  return onePerPr(items, LINES.changesAskedMany, choose, ({ pr, by }) => ({
    title: line(LINES.changesAsked, choose, { ref: prRef(pr), who: people(by) }),
    detail: pr.title,
  }));
}

/** New comments on your PRs: who, and how many conversations to resolve. */
export function commentedPages(items: PetPrBy[], choose: Choose = chooseAtRandom): PetPage[] {
  return onePerPr(items, LINES.commentedMany, choose, ({ pr, by, threads = 0 }) => ({
    title: line(LINES.commented, choose, { ref: prRef(pr), who: people(by) }),
    detail: pr.title,
    note: threads > 0 ? (threads === 1 ? "1 nuova conversazione da risolvere" : `${threads} nuove conversazioni da risolvere`) : undefined,
  }));
}

function reviewPage(pr: PetPr, pool: string[], choose: Choose, now: Date): PetPage {
  return {
    title: line(pool, choose, { ref: prRef(pr) }),
    detail: pr.title,
    note: `${pr.author} ti aspetta · aperta ${since(pr.createdAtIso, now)}`,
  };
}

/** Reviews newly asked of you: the PR itself, or a count and then the first few. */
export function reviewAskedPages(prs: PetPr[], now: Date, choose: Choose = chooseAtRandom): PetPage[] {
  return onePerPr(prs, LINES.reviewsAsked, choose, (pr) => reviewPage(pr, LINES.reviewAsked, choose, now));
}

/** "a, b e c". */
function list(parts: string[]): string {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/** What still waits on you: your approved PRs not merged, your PRs with changes
 *  asked, then reviews to do. */
export function reminderPages(
  { ready, changes, reviews }: { ready: PetPr[]; changes: PetPrBy[]; reviews: PetPr[] },
  now: Date,
  choose: Choose = chooseAtRandom,
): PetPage[] {
  const pages: PetPage[] = [
    ...ready.map((pr) => ({
      title: line(LINES.readyToMerge, choose, { ref: prRef(pr) }),
      detail: pr.title,
      note: `Approvata, ferma ${since(pr.updatedAtIso, now)}`,
    })),
    ...changes.map(({ pr, by }) => ({
      title: line(LINES.changesStillWaiting, choose, { ref: prRef(pr) }),
      detail: pr.title,
      note: `Chieste da ${people(by)}`,
    })),
    ...reviews.map((pr) => reviewPage(pr, LINES.reviewStillWaiting, choose, now)),
  ];
  if (pages.length <= 1) return pages;
  const what = list([
    ready.length ? `${ready.length} PR da mergiare` : "",
    changes.length ? `${changes.length} PR da correggere` : "",
    reviews.length ? `${reviews.length} review` : "",
  ].filter(Boolean));
  return [{ title: line(LINES.reminder, choose, { what }) }, ...pages.slice(0, MAX_PAGES - 1)];
}
