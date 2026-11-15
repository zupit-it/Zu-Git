import { test } from "node:test";
import assert from "node:assert/strict";

import { quotaView, type GithubQuota } from "../src/github-quota.ts";

const NOW = 1_794_300_000_000;
const inMinutes = (m: number) => Math.round(NOW / 1000) + m * 60;
const quota = (graphql: number, rest: number): GithubQuota => ({
  graphql: { limit: 5000, used: graphql, resetAt: inMinutes(40) },
  rest: { limit: 5000, used: rest, resetAt: inMinutes(25) },
});

test("nothing to show until GitHub has said something", () => {
  assert.equal(quotaView(null, NOW), null);
  assert.equal(quotaView({ graphql: null, rest: null }, NOW), null);
  // A server that tells no limit (GitHub Enterprise with rate limiting off).
  assert.equal(quotaView({ graphql: { limit: 0, used: 0, resetAt: inMinutes(10) }, rest: null }, NOW), null);
});

test("the top bar shows the limit used the most, and both in full on hover", () => {
  const view = quotaView(quota(52, 7), NOW);
  assert.equal(view?.text, "52/5000");
  assert.equal(view?.level, "ok");
  const [head, graphql, rest] = view?.title.split("\n") ?? [];
  assert.equal(head, "GitHub API, this hour");
  assert.match(graphql, /^GraphQL: 52 of 5,000 points · back to 0 at /);
  assert.match(rest, /^REST: 7 of 5,000 requests · back to 0 at /);
  // REST ahead: that is the one that counts.
  assert.equal(quotaView(quota(52, 300), NOW)?.text, "300/5000");
  // Only one heard of so far.
  assert.equal(quotaView({ graphql: null, rest: { limit: 5000, used: 3, resetAt: inMinutes(5) } }, NOW)?.text, "3/5000");
});

test("it shows from 70% and warns from 90%", () => {
  assert.equal(quotaView(quota(3499, 0), NOW)?.level, "ok");
  assert.equal(quotaView(quota(3500, 0), NOW)?.level, "warn");
  assert.equal(quotaView(quota(4499, 0), NOW)?.level, "warn");
  assert.equal(quotaView(quota(4500, 0), NOW)?.level, "danger");
  // By share of its own limit, not by count.
  const small: GithubQuota = { graphql: { limit: 5000, used: 900, resetAt: inMinutes(40) }, rest: { limit: 60, used: 55, resetAt: inMinutes(25) } };
  assert.equal(quotaView(small, NOW)?.text, "55/60");
  assert.equal(quotaView(small, NOW)?.level, "danger");
});

test("past its hour's end a limit counts from zero again, with no answer to say so", () => {
  const before = quotaView(quota(100, 4700), NOW);
  assert.equal(before?.text, "4700/5000");
  // To be drawn again when the first of the two starts over: REST, in 25 minutes.
  assert.equal(before?.nextReset, inMinutes(25) * 1000);

  const after = quotaView(quota(100, 4700), NOW + 26 * 60_000);
  assert.equal(after?.text, "100/5000");
  assert.match(after?.title ?? "", /REST: 0 of 5,000 requests · a new hour has started/);
  assert.equal(after?.nextReset, inMinutes(40) * 1000);
  // Both over: nothing left to wait for until GitHub answers again.
  assert.equal(quotaView(quota(100, 4700), NOW + 41 * 60_000)?.nextReset, null);
  assert.equal(quotaView(quota(100, 4700), NOW + 41 * 60_000)?.text, "0/5000");
});
