import { test } from "node:test";
import assert from "node:assert/strict";
import { inSelectedRepos, wasNotLoaded } from "../src/repo-selection.ts";

const prs = [
  { repo: "org/a", id: 1 },
  { repo: "org/b", id: 2 },
  { repo: "org/a", id: 3 },
];

test("PRs of a repository turned off are neither listed nor counted", () => {
  assert.deepEqual(inSelectedRepos(prs, ["org/b"]).map((pr) => pr.id), [1, 3]);
  assert.equal(inSelectedRepos(prs, ["org/a", "org/b"]).length, 0);
});

test("with every repository on, all PRs stay", () => {
  assert.equal(inSelectedRepos(prs, []), prs);
  assert.equal(inSelectedRepos(prs, ["org/gone"]).length, 3);
});

test("a repository turned on is read again only if the last read left it out", () => {
  const syncs = [
    { repo: "org/a" },
    { repo: "org/b", skipped: true },
    { repo: "org/c", skipped: false },
  ];
  assert.equal(wasNotLoaded(syncs, "org/b"), true);
  assert.equal(wasNotLoaded(syncs, "org/a"), false);
  assert.equal(wasNotLoaded(syncs, "org/c"), false);
  assert.equal(wasNotLoaded(syncs, "org/unknown"), false);
});
