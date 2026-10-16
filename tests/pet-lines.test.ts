import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_PAGES,
  changesAskedPages,
  ciFailedPages,
  commentedPages,
  mergedPages,
  people,
  prRef,
  reminderPages,
  reviewAskedPages,
  since,
  type PetPr,
} from "../src/pet-lines.ts";

const first = () => 0;
const now = new Date("2026-10-15T12:00:00Z");

function pr(id: number, extra: Partial<PetPr> = {}): PetPr {
  return {
    repo: "zupit-it/zugit",
    id,
    title: `PR ${id}`,
    author: "marco",
    createdAtIso: "2026-10-12T12:00:00Z",
    updatedAtIso: "2026-10-15T09:00:00Z",
    ...extra,
  };
}

test("a PR is named by its repo without the owner", () => {
  assert.equal(prRef(pr(42)), "zugit#42");
});

test("waiting times read in Italian, rounded down", () => {
  assert.equal(since("2026-10-15T11:30:00Z", now), "da poco");
  assert.equal(since("2026-10-15T11:00:00Z", now), "da un'ora");
  assert.equal(since("2026-10-15T07:59:00Z", now), "da 4 ore");
  assert.equal(since("2026-10-14T11:00:00Z", now), "da un giorno");
  assert.equal(since("2026-10-12T12:00:00Z", now), "da 3 giorni");
  assert.equal(since("not a date", now), "da poco");
});

test("a merge names the PR, with its title under it", () => {
  assert.deepEqual(mergedPages([pr(42)], first), [
    { title: "Evviva! zugit#42 entra nel regno", detail: "PR 42" },
  ]);
  assert.deepEqual(mergedPages([], first), []);
});

test("several merges or red CIs: a count first, then the first few", () => {
  const merged = mergedPages([pr(1), pr(2)], first);
  assert.deepEqual(merged.map((page) => page.title), [
    "Giornata di festa: 2 PR mergiate!",
    "Evviva! zugit#1 entra nel regno",
    "Evviva! zugit#2 entra nel regno",
  ]);
  const red = ciFailedPages([pr(1), pr(2), pr(3), pr(4), pr(5)], first);
  assert.equal(red.length, MAX_PAGES);
  assert.equal(red[0].title, "Sventura! 5 CI sono cadute");
});

test("a red CI names the failed checks, the first three and a count of the rest", () => {
  assert.equal(ciFailedPages([pr(7, { failedChecks: ["lint"] })], first)[0].note, "Check fallito: lint");
  assert.equal(
    ciFailedPages([pr(7, { failedChecks: ["a", "b", "c", "d", "e"] })], first)[0].note,
    "Check falliti: a, b, c e altri 2",
  );
  assert.equal(ciFailedPages([pr(7)], first)[0].note, undefined);
});

test("a new review says who waits and since when", () => {
  assert.deepEqual(reviewAskedPages([pr(9)], now, first), [
    { title: "Toc toc! zugit#9 chiede udienza", detail: "PR 9", note: "marco ti aspetta · aperta da 3 giorni" },
  ]);
});

test("several new reviews: a count first, then the first few", () => {
  const pages = reviewAskedPages([pr(1), pr(2), pr(3), pr(4), pr(5)], now, first);
  assert.equal(pages.length, MAX_PAGES);
  assert.equal(pages[0].title, "5 sudditi chiedono udienza");
  assert.equal(pages[1].title, "Toc toc! zugit#1 chiede udienza");
  assert.deepEqual(reviewAskedPages([], now, first), []);
});

test("the reminder sums up, then names PRs to merge before reviews", () => {
  const pages = reminderPages({ ready: [pr(12)], changes: [], reviews: [pr(20), pr(21)] }, now, first);
  assert.equal(pages[0].title, "Messere, ti aspettano 1 PR da mergiare e 2 review");
  assert.equal(pages[1].title, "zugit#12 è approvata: che aspetti a mergiarla?");
  assert.equal(pages[1].note, "Approvata, ferma da 3 ore");
  assert.equal(pages[2].title, "zugit#20 attende ancora la tua review");
  assert.equal(pages.length, MAX_PAGES);
});

test("a reminder about one thing is just that thing", () => {
  const pages = reminderPages({ ready: [], changes: [], reviews: [pr(20)] }, now, first);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].note, "marco ti aspetta · aperta da 3 giorni");
  assert.deepEqual(reminderPages({ ready: [], changes: [], reviews: [] }, now, first), []);
});

test("the reminder counts PRs to fix between those to merge and the reviews", () => {
  const pages = reminderPages({ ready: [pr(1)], changes: [{ pr: pr(2), by: ["luca"] }], reviews: [pr(3)] }, now, first);
  assert.equal(pages[0].title, "Messere, ti aspettano 1 PR da mergiare, 1 PR da correggere e 1 review");
  assert.deepEqual(pages[2], { title: "zugit#2 aspetta ancora le tue modifiche", detail: "PR 2", note: "Chieste da luca" });
});

test("people are named, two at most, then counted", () => {
  assert.equal(people([]), "qualcuno");
  assert.equal(people(["marco"]), "marco");
  assert.equal(people(["marco", "luca"]), "marco e luca");
  assert.equal(people(["marco", "luca", "anna", "sara"]), "marco, luca e altri 2");
});

test("changes asked name who asked them", () => {
  assert.deepEqual(changesAskedPages([{ pr: pr(5), by: ["marco", "luca"] }], first), [
    { title: "Sventura! Modifiche chieste su zugit#5 da marco e luca", detail: "PR 5" },
  ]);
  assert.equal(changesAskedPages([{ pr: pr(5), by: ["a"] }, { pr: pr(6), by: ["b"] }], first)[0].title,
    "Sventura! Modifiche chieste su 2 PR");
});

test("new comments say who, and how many conversations to resolve", () => {
  assert.deepEqual(commentedPages([{ pr: pr(8), by: ["anna"], threads: 2 }], first), [
    { title: "Nuovi commenti su zugit#8 da anna", detail: "PR 8", note: "2 nuove conversazioni da risolvere" },
  ]);
  assert.equal(commentedPages([{ pr: pr(8), by: [], threads: 1 }], first)[0].note, "1 nuova conversazione da risolvere");
  assert.equal(commentedPages([{ pr: pr(8), by: ["anna"] }], first)[0].note, undefined);
});
