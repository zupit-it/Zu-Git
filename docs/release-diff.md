# Release Diff

The release diff compares Jira's planned scope for a release with the pull requests that actually landed in GitHub.

## Repository Scope

The diff must run only against the repository associated with the clicked release row. It must not use every repository configured in ZuGit, otherwise PRs from unrelated products appear as false extras.

If a release row contains PRs from more than one repository, the diff is scoped to that row's repository set only.

## Beta And Major Releases

For beta and major releases, GitHub is the source for what landed on main.

The merged PR window is bounded by Git tags, not GitHub Release objects:

- lower bound: after the latest Git tag on the repository

In other words, when preparing `v1.79.0-beta.4`, the expected cutoff is the current latest tag, for example `v1.79.0-beta.3`. The diff should not keep walking back through older history.

GitHub Release objects are deliberately not used for this range because they may be stale, missing, or ordered differently from the actual tags.

Jira is then queried for:

- issues planned in the selected fixVersion
- Jira keys found in merged PRs inside that GitHub tag window

This lets ZuGit classify stories as done, missing, or extra.

## Release Notes

By default only *Done* stories reach the generated notes. That rule can be overridden per story from
the diff list — **Include anyway** / **Exclude anyway** / **Auto** — so scope that Jira and git
disagree about can still be announced (or held back) without editing Jira first. Overrides are keyed
by release name and Jira key and persist in `release-notes.json` in the app data directory.

Notes always lead with the issue type (POWER / BUG). The Epic grouping adds a per-epic section under
each type heading, never the other way round: the type is what readers scan for first. The epic is
Jira's *Principale* field — ZuGit resolves it by name through `/rest/api/3/field` and falls back to
the built-in `parent` field, which is what Italian Jira sites label "Principale". Stories with no
epic are grouped last.

## Minor Releases And Release Branches

Minor releases often have their own release branch and require cherry-picks, so main's merged PR range can be misleading. The header of the diff has a branch picker next to the version: it lists `main` plus every branch whose name starts with the **Release branch prefix** setting (Settings → Jira, default `release`, case-insensitive), most recently updated first.

When a release branch is picked:

- the lower bound is the latest Git tag reachable from that branch (last 100 commits), not from main
- merged PRs count only when their base is that branch
- the commits after the tag are scanned too, so a cherry-pick pushed without a PR still marks its story as merged; the row links to the original PR when the message carries `(#123)` or `Merge pull request #123`, otherwise to the commit
- a story with a terminal Jira status (Verified, Done…) is **not** assumed to be on the branch: without a matching PR or commit it stays *Missing*, flagged "Jira ahead of git" — that is the cherry-pick still to do

The branch picked is remembered per release name on this machine, so reopening the diff of a minor release lands on its branch again.
