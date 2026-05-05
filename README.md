# ZuGit

A desktop app for monitoring GitHub pull requests enriched with Jira data, built with Tauri 2.

![ZuGit screenshot](readme-img.png)

## Features

- Live list of open PRs across multiple repositories, enriched with Jira ticket info (summary, priority, release, status)
- Review status per PR — approvals, changes requested, stale approvals, pending reviewers
- CI/CD pipeline status inline
- Filter by reviewer, author, draft state, repo, or release group
- Re-request reviews directly from the list
- Native notifications for new review requests and changes requested
- Auto-refresh on a configurable interval
- Tokens stored in the system vault (macOS Keychain, Windows Credential Manager)

## Notifications

ZuGit fires native OS notifications in two cases:

- **Review requested** — when the number of PRs waiting for your review increases since the last refresh
- **Changes requested** — when a new reviewer requests changes on one of your PRs

Notifications are skipped on the first load to avoid a burst on startup, and can be disabled entirely from Settings. Each refresh resets the auto-refresh timer, so manually triggering a refresh does not cause double-firing.

## How it fetches data

On each refresh, ZuGit fetches all open PRs for every configured repository in parallel.
For each PR it fetches reviews, CI status, and check runs — but only if something has changed:
the result is cached in memory and reused as long as the PR's `updated_at` timestamp and HEAD SHA
stay the same. Stale cache entries (closed or merged PRs) are evicted automatically.

Jira tickets are fetched in bulk once per refresh and cached in memory for the same session.
The cache is cleared entirely only when settings are saved.

## Token security

Tokens are never written to disk in plain text. On save, ZuGit attempts to store them in the system vault:

- **macOS** — macOS Keychain via the `security` CLI
- **Windows** — Windows Credential Manager via the `keyring` crate
- **Fallback** — if the system vault is unavailable, tokens are encrypted with DPAPI (Windows) before being written to the settings file in the app data folder. The Status tab shows which backend is active and whether the last save reached the vault.

## Privacy

ZuGit is fully local. All API calls go directly from your machine to GitHub and Jira — there is no intermediate server, no analytics, and no telemetry of any kind.

## Author classification

Each PR author is classified as **Internal** or **Collaborator**:

- **Internal** — the GitHub username contains the configured internal marker (default: `-zupit`)
- **Collaborator** — the username is in the explicit collaborator list, or does not match the internal marker

Both filters are configurable in Settings and used to filter the PR list.

## Jira key extraction

ZuGit extracts the Jira key from each PR in order of preference:

1. PR title, using the board prefix configured for that repository (e.g. `[PROJ-123]`)
2. PR title, any board prefix
3. Branch name or PR body (fallback)

If no key is found for an internal PR, a warning is shown in the Status tab.

## Requirements

- GitHub personal access token (classic or fine-grained, `repo` scope)
- Jira API token (optional — enables ticket enrichment)

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Produces installers for macOS (universal), Windows, and Linux via GitHub Actions on tag push.
