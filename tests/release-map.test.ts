import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReleaseMapLayout, nextTagName, type MapItem, type Mainline } from "../src/release-map-layout.ts";

const item = (key: string, overrides: Partial<MapItem> = {}): MapItem => ({
  key,
  summary: `${key} summary`,
  status: "Verified",
  issueType: "Story",
  fixVersions: ["1.4.0"],
  author: "dev",
  initials: "DE",
  avatarColor: "#000",
  ...overrides,
});

const at = (day: number) => `2026-05-${String(day).padStart(2, "0")}T10:00:00Z`;

test("next tag bumps the trailing number of the first tag", () => {
  assert.equal(nextTagName("v1.4.0-beta.3"), "v1.4.0-beta.4");
  assert.equal(nextTagName("v2.4.9 · v2.4.1"), "v2.4.10");
  assert.equal(nextTagName(""), "");
  assert.equal(nextTagName("nightly"), "");
});

test("beta map: earlier stops, tag, merges in order, HEAD, ghosts, next tag", () => {
  const layout = buildReleaseMapLayout({
    done: [item("ZU-2", { mergedAt: at(3) }), item("ZU-1", { mergedAt: at(2) }), item("ZU-9")],
    extra: [item("ZU-5", { mergedAt: at(4), fixVersions: ["1.5.0"] })],
    missing: [item("ZU-7", { status: "In progress" }), item("ZU-6", { status: "In progress" })],
    sinceTag: "v1.4.0-beta.3",
    branch: "",
    openPrs: { "ZU-7": { number: 812, url: "u" } },
  });

  assert.equal(layout.mode, "beta");
  const main = layout.stations.map(s => [s.col, s.kind, s.label, s.sub ?? ""]);
  assert.deepEqual(main, [
    [0, "earlier", "", ""],
    [2, "landed", "ZU-1", ""],
    [3, "landed", "ZU-2", ""],
    [4, "extra", "ZU-5", ""],
    [5, "incoming", "ZU-7", "PR #812"],
    [6, "incoming", "ZU-6", "no PR"],
  ]);
  assert.deepEqual(layout.tags, [
    { lane: "main", col: 1, name: "v1.4.0-beta.3", style: "start" },
    { lane: "main", col: 7, name: "v1.4.0-beta.4", style: "next" },
  ]);
  assert.deepEqual(layout.main, { name: "main", head: 4, to: 7 });
  assert.equal(layout.counts.earlier, 1);
  assert.equal(layout.counts.incoming, 2);
});

test("beta map with nothing merged keeps HEAD right after the tag", () => {
  const layout = buildReleaseMapLayout({
    done: [], extra: [], missing: [item("ZU-1", { status: "To do" })], sinceTag: "v1.0.0-beta.1", branch: "",
  });
  assert.equal(layout.main.head, 0);
  assert.deepEqual(layout.stations.map(s => s.col), [1]);
});

test("branch map: picks drop to the branch, verified gaps become ghosts, noise collapses", () => {
  const mainline: Mainline = {
    branch: "main",
    commits: [
      { number: 1, url: "u1", title: "Old work", mergedAt: at(1), jiraKeys: ["ZU-90"] },
      { number: 2, url: "u2", title: "Picked", mergedAt: at(2), jiraKeys: ["ZU-1"] },
      { number: 3, url: "u3", title: "Other release", mergedAt: at(3), jiraKeys: ["ZU-50"] },
      { number: 4, url: "u4", title: "Other release 2", mergedAt: at(4), jiraKeys: ["ZU-51"] },
      { number: 5, url: "u5", title: "Waiting pick", mergedAt: at(5), jiraKeys: ["ZU-2"] },
      { number: 6, url: "u6", title: "In QA", mergedAt: at(6), jiraKeys: ["ZU-3"] },
      { number: 7, url: "u7", title: "Unplanned pick", mergedAt: at(7), jiraKeys: ["ZU-4"] },
    ],
    tags: [
      { name: "v1.5.0-beta.1", date: at(3) },
      { name: "v1.3.0", date: at(1) },
    ],
  };
  const layout = buildReleaseMapLayout({
    done: [item("ZU-1", { mergedAt: at(8) }), item("ZU-8", { mergedAt: at(9) })],
    extra: [item("ZU-4", { mergedAt: at(10), fixVersions: ["1.5.0"] })],
    missing: [
      item("ZU-2"),
      item("ZU-3", { status: "Developed" }),
      item("ZU-6", { status: "In progress" }),
      item("ZU-7"),
    ],
    sinceTag: "v1.4.1",
    branch: "release/1.4",
    mainline,
  });

  assert.equal(layout.mode, "branch");
  const rows = layout.stations.map(s => `${s.lane}:${s.col}:${s.kind}${s.ghost ? "~" : ""}:${s.label || s.count}`);
  assert.deepEqual(rows, [
    "main:1:landed:ZU-1",
    "branch:1:landed:ZU-1",
    "main:2:cluster:2",
    "main:3:to-pick:ZU-2",
    "branch:3:to-pick~:ZU-2",
    "main:4:testing:ZU-3",
    "main:5:extra:ZU-4",
    "branch:5:extra:ZU-4",
    "branch:6:landed:ZU-8",
    "branch:7:to-pick~:ZU-7",
    "main:6:incoming~:ZU-6",
  ]);
  assert.deepEqual(layout.links.map(l => [l.col, l.kind]), [[1, "landed"], [3, "to-pick"], [5, "extra"]]);
  // The beta tag sits on the last stop merged before it (the cluster); the
  // older release tag is outside the window.
  assert.deepEqual(layout.tags.filter(t => t.style === "flag").map(t => [t.col, t.name]), [[2, "v1.5.0-beta.1"]]);
  assert.deepEqual(layout.main, { name: "main", head: 5, to: 6 });
  assert.deepEqual(layout.branch, { name: "release/1.4", head: 6, to: 8 });
  assert.equal(layout.counts["to-pick"], 2);
  assert.equal(layout.counts.testing, 1);
  assert.equal(layout.counts.incoming, 1);
});

test("multi-story PRs are one stop: grouped on main, and held back by a story still in testing", () => {
  const beta = buildReleaseMapLayout({
    done: [
      item("ZU-1", { mergedAt: at(2), prUrl: "pr/10" }),
      item("ZU-2", { mergedAt: at(2), prUrl: "pr/10" }),
    ],
    extra: [item("ZU-3", { mergedAt: at(2), prUrl: "pr/10", fixVersions: ["1.5.0"] })],
    missing: [item("ZU-4", { status: "In progress" }), item("ZU-5", { status: "In progress" })],
    sinceTag: "v1.4.0-beta.1",
    branch: "",
    openPrs: { "ZU-4": { number: 20, url: "pr/20" }, "ZU-5": { number: 20, url: "pr/20" } },
  });
  assert.deepEqual(beta.stations.map(s => [s.kind, s.label, s.keys.length, s.sub ?? ""]), [
    ["extra", "ZU-1 +2", 3, ""],
    ["incoming", "ZU-4 +1", 2, "PR #20"],
  ]);
  // The legend still counts stories, not stops.
  assert.equal(beta.counts.landed, 2);
  assert.equal(beta.counts.extra, 1);

  const branch = buildReleaseMapLayout({
    done: [],
    extra: [],
    missing: [item("ZU-1"), item("ZU-2", { status: "In progress" }), item("ZU-3")],
    sinceTag: "v1.4.0",
    branch: "release/1.4",
    mainline: {
      branch: "main",
      commits: [
        { number: 10, url: "u", title: "feat(ZU-1,ZU-2): blocked", mergedAt: at(2), jiraKeys: ["ZU-1", "ZU-2"] },
        { number: 11, url: "u", title: "feat(ZU-3): ready", mergedAt: at(3), jiraKeys: ["ZU-3"] },
      ],
      tags: [],
    },
  });
  assert.deepEqual(branch.stations.map(s => `${s.lane}:${s.kind}:${s.label}:${s.sub ?? ""}`), [
    "main:testing:ZU-1 +1:1/2 verified",
    "main:to-pick:ZU-3:",
    "branch:to-pick:ZU-3:",
  ]);
  assert.deepEqual(branch.links.map(l => l.keys), [["ZU-3"]]);
  assert.equal(branch.counts["to-pick"], 2);
  assert.equal(branch.blocked, 1);
});

test("a story merged twice — release, then rework after a reject — stops at both PRs", () => {
  const beta = buildReleaseMapLayout({
    done: [
      item("ZU-1", {
        mergedAt: at(5), prUrl: "pr/14", prNumber: 14,
        prs: [{ number: 10, url: "pr/10", mergedAt: at(2) }, { number: 14, url: "pr/14", mergedAt: at(5) }],
      }),
      item("ZU-2", { mergedAt: at(3), prUrl: "pr/11", prNumber: 11, prs: [{ number: 11, url: "pr/11", mergedAt: at(3) }] }),
    ],
    extra: [],
    missing: [],
    sinceTag: "v1.4.0-beta.1",
    branch: "",
  });
  assert.deepEqual(beta.stations.map(s => [s.label, s.rework ?? false, s.mainPr?.number]), [
    ["ZU-1", false, 10],
    ["ZU-2", false, 11],
    ["ZU-1", true, 14],
  ]);
  assert.equal(beta.counts.landed, 2);

  // Release branch: the first release was picked, the rework was not.
  const branch = buildReleaseMapLayout({
    done: [],
    extra: [],
    missing: [item("ZU-1", {
      flag: "rework-not-picked",
      prs: [
        { number: 10, url: "pr/10", mergedAt: at(2), picked: true },
        { number: 14, url: "pr/14", mergedAt: at(5), picked: false },
      ],
    })],
    sinceTag: "v1.4.0",
    branch: "release/1.4",
    mainline: {
      branch: "main",
      commits: [
        { number: 10, url: "pr/10", title: "feat(ZU-1): first", mergedAt: at(2), jiraKeys: ["ZU-1"] },
        { number: 12, url: "pr/12", title: "other", mergedAt: at(3), jiraKeys: ["ZU-50"] },
        { number: 14, url: "pr/14", title: "feat(ZU-1): rework", mergedAt: at(5), jiraKeys: ["ZU-1"] },
      ],
      tags: [],
    },
  });
  assert.deepEqual(branch.stations.map(s => `${s.lane}:${s.col}:${s.kind}${s.ghost ? "~" : ""}${s.rework ? "↻" : ""}`), [
    "main:1:landed",
    "branch:1:landed",
    "main:2:cluster",
    "main:3:to-pick↻",
    "branch:3:to-pick~↻",
  ]);
  assert.equal(branch.counts["to-pick"], 1);
});
