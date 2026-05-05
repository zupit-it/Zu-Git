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
