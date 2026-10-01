import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parseChangelog } from "../src/changelog-parse.ts";

const IMG = "https://raw.githubusercontent.com/zupit-it/Zu-Git/v0.12.0/public/assets/changelog/toggl-evidence.png";

test("an image paragraph attaches to the entry above it", () => {
  const [release] = parseChangelog(
    ["## [0.12.0]", "", "### Added", "- **Toggl** — first line", "  wraps here.", "", `  ![Toggl](${IMG})`, "", "- **Other** — text"].join("\n"),
  );
  assert.equal(release.items[0].body, "first line wraps here.");
  assert.deepEqual(release.items[0].imgs, [IMG]);
  assert.deepEqual(release.items[1].imgs, []);
});

test("images from anywhere else are ignored", () => {
  const [release] = parseChangelog(
    ["## [0.12.0]", "- **Toggl** — text", "", "  ![x](https://evil.example/x.png)"].join("\n"),
  );
  assert.deepEqual(release.items[0].imgs, []);
  assert.equal(release.items[0].body, "text");
});

test("release notes extracted for a version point images at that tag", () => {
  const notes = execFileSync("node", ["scripts/changelog.js", "extract", "0.12.0"], { encoding: "utf8" });
  assert.match(notes, /!\[[^\]]*\]\(https:\/\/raw\.githubusercontent\.com\/zupit-it\/Zu-Git\/v0\.12\.0\/public\/assets\/changelog\/toggl-evidence\.png\)/);
  assert.doesNotMatch(notes, /\]\(public\//);
});
