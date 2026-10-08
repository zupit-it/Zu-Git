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

- a story can land on main more than once — its first release, then a rework after a reject, with
  the same Jira key in the title whatever the prefix (`feat(PENT-1)`, `fix(PENT-1)`). It is on the
  branch only when **all** its PRs on main are: a PR naming the main PR (`(#123)`, kept by a
  cherry-pick) settles it; otherwise a main PR merged before the story's latest pick counts as picked
  (a pick always follows the merge it brings) and one merged after it cannot be there yet. Picked once
  but with a later rework missing, the story is *Missing*, flagged "Rework not picked", and its row
  links the rework to pick. With no pick at all since the branch's tag, only the story's last PR is
  known to be missing — the earlier ones may have shipped with that tag.

The branch picked is remembered per release name on this machine, so reopening the diff of a minor release lands on its branch again.

## Release Map

Above the list, the diff draws the release as a metro map. Every stop is a Jira story; click one to
jump to its row, hover it for the details. The map follows the active tab (stories outside it fade)
and can be hidden down to its legend (**Hide map** / **Show map**); the choice is remembered on this machine.

On **main** (beta and major releases) it is a single line:

- it starts at the latest tag, with a `+N` chip for the planned stories that are Done without a
  merge after that tag — they shipped in an earlier one;
- every story merged since the tag is a stop, in merge order, up to HEAD: a circle when it is planned
  for this release, a diamond when it is not (it ships in the next tag anyway);
- past HEAD a dotted stretch leads to the next tag (the last tag's trailing number + 1) through a
  dashed ghost for each planned story not merged yet, captioned with its open PR when the dashboard
  has one.

On a **release branch** main runs on top and the branch underneath, forking off at the branch's
latest tag. Main's last 100 merged PRs are fetched for this, together with the tags reachable from
main; a story's stop on main is its last PR there.

- a story on the branch gets a solid drop line from its stop on main;
- a story Verified (or Closed, Released, Done) on main but missing from the branch gets a dashed drop
  line to a ghost on the branch — the cherry-pick still to do;
- a story on main that is not verified yet is an open ring: nothing to pick;
- main PRs of other releases collapse into `+N` stops, and beta tags show as flags above main;
- what reached the branch without a stop on main (a hotfix, or a story older than main's window)
  and stories not merged on main yet are queued after HEAD.

A story merged more than once stops at each of its PRs: the later ones carry a `↻` (rework), hovering
any of them lights all of them, and the tooltip lists the story's PRs in order — on a release branch
with where each one is (on the branch, not picked, or before the tag). The list links the latest PR
and counts the earlier ones (`+1`).

A PR carrying several stories — `feat(PENT-1234,PENT-1235): …` — is a single stop labelled
`PENT-1234 +1`, on main, on the branch and among the ghosts (an open PR counts for every key in its
title). Its colour is the PR's as a whole: on the branch if any of its stories is (a diamond if one of
them is unplanned), and since a PR is cherry-picked whole, a verified story sharing it with one still
in testing is not "to cherry-pick" but held back — the stop reads `1/2 verified` and the legend counts
it apart. Hovering the stop lists every story with its status; clicking it flashes all their rows.

