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

## Minor Releases

Minor releases are intentionally not fully modeled yet.

They often have their own release branch and require cherry-picks, so using main's merged PR range can be misleading. The expected future behavior is likely to rely primarily on Jira's fixVersion list, then track cherry-pick state separately.

Until that workflow is designed, release diff behavior should be treated as reliable for beta and major releases only.
