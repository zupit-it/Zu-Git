# ZuGit

A desktop app for monitoring GitHub pull requests enriched with Jira data, built with Tauri 2.

> **macOS — first launch**
> The app is not notarized. macOS will block it with a "damaged" error.
> Run this once after installation, then open normally:
> ```bash
> xattr -cr /Applications/ZuGit.app
> ```

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

- **Review requested** — when one or more PRs are newly assigned to you for review since the last refresh (tracked by PR id, so resolving one and receiving another still triggers a notification)
- **Changes requested** — when a new reviewer requests changes on one of your PRs

Notifications are skipped on the first load to avoid a burst on startup, and can be disabled entirely from Settings. Each refresh resets the auto-refresh timer, so manually triggering a refresh does not cause double-firing.

## How it fetches data

On each refresh, ZuGit sends a single GraphQL query per repository to the GitHub API.
Each query returns all open PRs with reviews, CI status, additions/deletions, and assignees in one round trip.
Stale entries (closed or merged PRs) are evicted automatically.

Jira tickets are fetched in bulk once per refresh and cached in memory for the same session.
The cache is cleared entirely only when settings are saved.

## Token security

Tokens are never written to disk in plain text. On save, ZuGit attempts to store them in the system vault:

- **macOS** — macOS Keychain via the `security` CLI
- **Windows** — Windows Credential Manager via the `keyring` crate
- **Fallback** — if the system vault is unavailable, tokens are encrypted with DPAPI (Windows) before being written to the settings file in the app data folder. The Status tab shows which backend is active and whether the last save reached the vault.

## Privacy

ZuGit is fully local. All API calls go directly from your machine to GitHub and Jira — there is no intermediate server, no analytics, and no telemetry of any kind.

## Add PR — branch detection

The "Add PR" button finds your most recently pushed branch that has no open PR yet.
Detection uses the [GitHub Activity API](docs/github-identity.md) (`GET /repos/{repo}/activity?actor={login}`) rather than git commit authorship — see [`docs/github-identity.md`](docs/github-identity.md) for why the two are not the same thing.

### API calls — New PR flow

When the card opens, ZuGit makes **4 round trips** regardless of how many repos are configured (N):

| Round trip | Call | Notes |
|---|---|---|
| 1 | GraphQL `{ viewer { login } r0: repository { defaultBranchRef } … }` | Viewer login + default branch for all repos batched in one query |
| 2 | N × `GET /repos/{repo}/activity?actor={login}&time_period=month&per_page=25` | Push events per repo, all in parallel |
| 3 | GraphQL `{ r0: repository { c0_prs: pullRequests(…) c0_ref: ref(…) … } }` | PR existence + commit headline for all candidates, batched across repos |
| 4 | `GET /repos/{repo}/compare/{base}…{head}` | Diff stats (additions, deletions, files, commit list) |

Note: the Activity API has no GraphQL equivalent, so round trip 2 stays as REST. Everything else is batched via GraphQL.

### API calls — Promote flow

When the Promote button is clicked on a draft PR row, all data (title, body, reviewers, branches) is already in the dashboard snapshot. ZuGit makes a single additional call:

| # | Endpoint | Notes |
|---|---|---|
| 1 | `GET /repos/{repo}/compare/{base}…{head}` | Diff stats, fetched async after the card renders |

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

## Jira integration

ZuGit integrates with Jira in two ways: **read-only enrichment** (ticket data shown in the PR list) and **write-back actions** (checklist updates and workflow transitions triggered on publish).

### Ticket enrichment

On each refresh ZuGit issues a single bulk JQL query (`POST /rest/api/3/search/jql`) for all Jira keys found in the current PR list, then caches the results in memory for the session. Fields fetched: `summary`, `priority`, `status`, `fixVersions`, `assignee`.

If the tenant does not support the `/jql` endpoint (older Jira Server versions), ZuGit falls back to individual `GET /rest/api/3/issue/{key}` calls automatically.

### Checklist (Herocoders Smart Checklist for Jira)

ZuGit reads and writes acceptance-criteria checklists managed by the **Herocoders Smart Checklist for Jira** plugin.

#### Field discovery

The writable checklist field is discovered once per session via `GET /rest/api/3/field` and cached. Herocoders exposes several fields with "checklist" in the name; ZuGit selects the correct one in priority order:

1. A field named exactly **"Checklist Text"**
2. Any field whose name contains "text" but not "view"
3. Any field that does not contain "view"

The typical field IDs on a Herocoders installation are:

| Field name | Notes |
|---|---|
| `Checklist Text` | **Writable** — the field ZuGit reads and writes |
| `Checklist Text (view-only)` | Read-only computed copy, do not write to this |
| `Checklist Progress %` | Numeric, managed by Herocoders |
| `Checklist Progress` | `x/y` string, managed by Herocoders |
| `Checklist Completed` | Boolean, managed by Herocoders |
| `Checklist Template` | Template source |
| `Checklist Content YAML` | Internal YAML, managed by Herocoders |

#### Field format — ADF + Herocoders syntax

The **Checklist Text** field uses Jira's Atlassian Document Format (ADF). Herocoders encodes checklists inside ADF as:

- `orderedList` nodes → section headers (e.g. `# Default checklist`)
- `bulletList` nodes → checklist items, with the status keyword embedded in the text

Item status keywords:

| Keyword | Meaning |
|---|---|
| `[open]` | Item not completed |
| `[done]` | Item completed |

Example raw text reconstructed from ADF:

```
# Default checklist

* [open] acceptance criterion one
* [done] acceptance criterion two
```

When **writing** back, ZuGit serialises the items as plain text (`* [done] …` / `* [open] …`) wrapped in an ADF paragraph node. Herocoders processes this and converts it into the proper list structure on its side.

#### Workflow

**Opening a draft PR** — if the branch name contains a Jira key (e.g. `PROJ-123/my-feature`), ZuGit fetches the checklist before showing the New PR card. Items can be checked/unchecked in the UI. On publish:

- **Draft PR** — the current checked/unchecked state is written back to Jira (`update_jira_checklist`). No workflow transition is applied.
- **Ready PR** — all items are marked `[done]` and written back, then ZuGit attempts the configured workflow transition (default: `MERGE REQUEST`).

**Promoting a draft PR** — the Promote button on a draft PR row opens the same card pre-filled with the existing title, body, and reviewers. The checklist is fetched fresh from Jira. On publish the same ready-PR flow applies.

#### Transition timing

Herocoders applies a workflow validator that checks its internal checklist state before allowing the transition. Because Herocoders processes the field write asynchronously, ZuGit waits **1 second** after the write before attempting the transition, and retries once more after **5 seconds** if the validator still blocks. Any other error (non-checklist 400, network error, transition not found) is surfaced immediately without retrying.

#### Configuring the transition name

The target workflow transition is configurable in Settings → **Jira merge transition** (default: `MERGE REQUEST`). The name is matched case-insensitively against the transitions returned by `GET /rest/api/3/issue/{key}/transitions`.

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

## Release

Releases are cut via the **Release** workflow on GitHub Actions (`Actions → Release → Run workflow`).

Enter the version number **without** the `v` prefix (e.g. `0.2.0`). The workflow will:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`
2. Commit the changes and push a `v0.2.0` tag
3. Trigger the build workflow on that tag

The build workflow compiles and packages the app for macOS (arm64 + x86\_64), Windows, and Linux, then uploads the installers to a GitHub Release.

The updater release requires the GitHub repository secrets `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key matching that private key is
stored in `src-tauri/tauri.conf.json`; Tauri generates the updater bundle signatures
and the build workflow uploads `latest.json` to the GitHub Release.
