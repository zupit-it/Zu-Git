#!/usr/bin/env node
// Usage:
//   node scripts/changelog.js bump <version>    — promotes [Unreleased] → [version], modifies CHANGELOG.md in place
//   node scripts/changelog.js extract <version> — prints the notes for that version to stdout

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = join(__dirname, "../CHANGELOG.md");

const [, , command, version] = process.argv;

if (!command || !version) {
  console.error("Usage: changelog.js <bump|extract> <version>");
  process.exit(1);
}

const content = readFileSync(CHANGELOG, "utf8");

if (command === "bump") {
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
  process.stdout.write(match[1].trim());

} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
