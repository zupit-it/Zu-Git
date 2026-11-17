#!/usr/bin/env node
// Usage:
//   node scripts/changelog.js bump <version>    — promotes [Unreleased] → [version], modifies CHANGELOG.md in place
//   node scripts/changelog.js extract <version> — prints the notes for that version to stdout
//   node scripts/changelog.js check [<rev>]     — what the release would refuse, said before a push
//                                                 (.githooks/pre-push); CHANGELOG.md at <rev>, the file on disk without

import { readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const RAW_BASE = "https://raw.githubusercontent.com/zupit-it/Zu-Git";

const [, , command, version] = process.argv;

if (!command || (!version && command !== "check")) {
  console.error("Usage: changelog.js <bump|extract> <version> | check [<rev>]");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** A section's body, from under its `## [name]` heading to the next one; null when there is none. */
function section(text, name) {
  const escaped = name.replace(/[.[\]]/g, "\\$&");
  const match = text.match(new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  return match ? match[1] : null;
}

/** Nothing but blank lines and `---` rules. */
const isEmpty = (body) => !body.replace(/^-{3,}\s*$/gm, "").trim();

const content = command === "check" && version
  ? git("show", `${version}:CHANGELOG.md`)
  : readFileSync(CHANGELOG, "utf8");

if (command === "check") {
  // The notes of the last release are what that release's tag holds: a branch
  // rebased over "chore: release vX" can put new notes in [X] instead, with no
  // conflict (the lines around them moved there), and the next release then
  // finds [Unreleased] empty.
  const rev = version ?? "HEAD";
  const latest = content.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  const tag = latest && `v${latest}`;
  const tagged = tag && (() => { try { return git("show", `refs/tags/${tag}:CHANGELOG.md`); } catch { return null; } })();
  if (!latest) {
    console.log("No release in CHANGELOG.md yet.");
    process.exit(0);
  }
  if (!tagged) {
    console.warn(`Tag ${tag} is not here, so [${latest}] cannot be checked: git fetch --tags.`);
    process.exit(0);
  }
  const problems = [];
  if (section(content, latest) !== section(tagged, latest)) {
    problems.push(
      `[${latest}] in CHANGELOG.md is not what ${tag} released: notes written since go under [Unreleased].\n` +
      `  A rebase over "chore: release ${tag}" puts them in [${latest}] without a conflict. Compare: git diff ${tag} ${version ? `${version} ` : ""}-- CHANGELOG.md`,
    );
  }
  // What the release asks for: a feature or a fix since the last one has its notes.
  const unreleased = section(content, "Unreleased");
  const owed = git("log", "--format=%s", `${tag}..${rev}`).split("\n").filter((s) => /^(feat|fix)(\(.+\))?!?:/.test(s));
  if (owed.length && (unreleased === null || isEmpty(unreleased))) {
    problems.push(
      `[Unreleased] in CHANGELOG.md is empty, but since ${tag} there is:\n` +
      owed.map((s) => `    ${s}`).join("\n") + "\n  The release would stop on it: write their notes there.",
    );
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`CHANGELOG.md: [${latest}] as released, [Unreleased] ${owed.length ? "has notes" : "has nothing owed"}.`);

} else if (command === "bump") {
  // A release with an empty [Unreleased] ships with no notes: the update
  // modal then says "This release ships without notes". Stop it here, before
  // anything is tagged.
  const unreleased = content.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (unreleased && !unreleased[1].replace(/^-{3,}\s*$/gm, "").trim()) {
    console.error("[Unreleased] in CHANGELOG.md is empty: write the notes for this release first.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const bumped = content.replace(
    /^## \[Unreleased\]/m,
    `## [Unreleased]\n\n---\n\n## [${version}] - ${today}`
  );
  if (bumped === content) {
    console.error("Could not find [Unreleased] section in CHANGELOG.md");
    process.exit(1);
  }
  writeFileSync(CHANGELOG, bumped, "utf8");
  console.log(`Changelog bumped: [Unreleased] → [${version}] - ${today}`);

} else if (command === "extract") {
  // Extract everything between ## [version] and the next ## heading.
  // Both escapes matter: `[\\s\\S]` because a template literal would eat the
  // backslashes and leave `[sS]`, and `$(?![\\s\\S])` because with the `m` flag
  // a bare `$` matches the end of the *first line* — either one silently
  // reduces the release notes to an empty string.
  const pattern = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\][^\n]*\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
    "m"
  );
  const match = content.match(pattern);
  if (!match) {
    console.error(`No entry found for version ${version} in CHANGELOG.md`);
    process.exit(1);
  }
  // Images are written repo-relative in CHANGELOG.md so they render on GitHub;
  // the release body (GitHub release page, update modal) needs absolute URLs,
  // pinned to the release tag so they never change under an old release.
  const notes = match[1]
    .trim()
    .replace(/\]\((?:\.\/)?(public\/[^)\s]+)\)/g, `](${RAW_BASE}/v${version}/$1)`);
  process.stdout.write(notes);

} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
