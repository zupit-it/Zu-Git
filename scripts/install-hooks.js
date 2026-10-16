#!/usr/bin/env node
// Points git at .githooks, where pre-push runs the checks CI runs: npm calls
// this on install (the "prepare" script). Outside a git checkout it does nothing.

import { execFileSync } from "child_process";

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // Not a git checkout, or no git: nothing to point.
}
