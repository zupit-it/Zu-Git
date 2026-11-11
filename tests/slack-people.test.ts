import { test } from "node:test";
import assert from "node:assert/strict";

import {
  directoryFromRows, firstName, nudgeMessage, reviewRows, slackMember,
  type SlackDirectory, type SlackProposal,
} from "../src/slack-people.ts";

const saved: SlackDirectory = {
  teamId: "T0ZUPIT",
  people: [
    { login: "anna-zupit", memberId: "U0ANNA", slackName: "Anna Bianchi", match: "email" },
    { login: "luca-zupit", memberId: "U0LUCA", slackName: "Luca Verdi", match: "manual" },
  ],
};

const proposal: SlackProposal = {
  createdAt: "2026-11-11T10:00:00Z",
  source: "claude-code",
  teamId: "T0ZUPIT",
  people: [
    { login: "Anna-Zupit", memberId: "U0ANNA", slackName: "Anna Bianchi", match: "email" },
    { login: "luca-zupit", memberId: "U0OTHER", slackName: "Luca Verdi", match: "name", note: "only Luca in the workspace" },
    { login: "mario-zupit", memberId: "U0MARIO", match: "name" },
  ],
  unmatched: [{ login: "piero-zupit", reason: "two Piero" }],
};

test("the review table lays the proposal over what is saved, marking what it changes", () => {
  const rows = reviewRows(["anna-zupit", "giulia-zupit"], saved, proposal);
  const view = rows.map((r) => [r.login, r.memberId, r.change ?? null, r.unmatched ?? null]);
  assert.deepEqual(view, [
    ["anna-zupit", "U0ANNA", "same", null],
    ["giulia-zupit", "", null, null],
    ["luca-zupit", "U0OTHER", "changed", null],
    ["mario-zupit", "U0MARIO", "new", null],
    ["piero-zupit", "", null, "two Piero"],
  ]);
});

test("without a proposal the table is what is saved plus the team left to fill", () => {
  const rows = reviewRows(["giulia-zupit"], saved, null);
  assert.deepEqual(rows.map((r) => [r.login, r.memberId, r.match ?? null]), [
    ["anna-zupit", "U0ANNA", "email"],
    ["giulia-zupit", "", null],
    ["luca-zupit", "U0LUCA", "manual"],
  ]);
});

test("only rows with a member id are saved, trimmed", () => {
  const rows = reviewRows(["giulia-zupit"], saved, null);
  rows[0].memberId = " U0ANNA2 ";
  const directory = directoryFromRows(" T0ZUPIT ", "  ", rows);
  assert.equal(directory.teamId, "T0ZUPIT");
  assert.equal(directory.teamName, undefined);
  assert.deepEqual(directory.people.map((p) => [p.login, p.memberId]), [["anna-zupit", "U0ANNA2"], ["luca-zupit", "U0LUCA"]]);
});

test("a member is found without case, and only once a workspace is set", () => {
  assert.equal(slackMember(saved, "ANNA-ZUPIT")?.memberId, "U0ANNA");
  assert.equal(slackMember(saved, "nobody"), undefined);
  assert.equal(slackMember({ ...saved, teamId: "" }, "anna-zupit"), undefined);
});

test("the nudge greets by first name only when Slack has a real one", () => {
  assert.equal(firstName("Anna Bianchi"), "Anna");
  assert.equal(firstName("D'Amico Luca"), "D'Amico");
  assert.equal(firstName("anna.bianchi"), null);
  assert.equal(firstName(undefined), null);

  const pr = { repo: "org/app", id: 12, title: "Login page", url: "https://github.com/org/app/pull/12" };
  assert.equal(
    nudgeMessage(pr, "Anna Bianchi"),
    "Ciao Anna! Quando hai un attimo, riusciresti a dare un'occhiata alla mia PR “Login page”? https://github.com/org/app/pull/12\nGrazie!",
  );
  assert.ok(nudgeMessage(pr).startsWith("Ciao! "));
  assert.ok(nudgeMessage({ ...pr, title: " " }).includes("“org/app#12”"));
});
