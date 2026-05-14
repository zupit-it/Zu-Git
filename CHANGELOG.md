# Changelog

All notable changes to ZuGit are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

---

## [0.8.4] - 2026-05-14

---

## [0.8.3] - 2026-05-14

---

## [0.8.2] - 2026-05-14

---

## [0.8.1] - 2026-05-14

---

## [0.8.0] - 2026-05-12

---

## [0.6.3] - 2026-05-09

---

## [0.6.2] - 2026-05-09

### Added

**Features**

- **What's new modal** — shows automatically after an app update (version-gated via localStorage). Can be reopened at any time from the "What's new" entry in the nav. Entries support images, HTML, and numbered steps.

- **Branch diff stats in New PR card** — additions, deletions, file count, and a collapsible commit list with relative timestamps. Fetched via `GET /repos/{repo}/compare/{base}...{head}`.

- **Auto-merge chip** — inline chip on PR rows showing when auto-merge is enabled on a PR, with the configured merge method.

- **Promote spinner** — the Promote button shows a loading state while diff stats are fetched; the card opens only when all data is ready.

**Internal**

- **Add PR — branch detection via GitHub Activity API**  
  The "Add PR" button now reliably finds your unpublished branch even when your git commit email is not verified on GitHub. The previous approach used `GET /repos/{repo}/commits?author={login}`, which matches by git commit email and silently returns nothing when the email is not associated with the GitHub account. The new approach uses `GET /repos/{repo}/activity?actor={login}&activity_type=push`, which matches by GitHub account identity regardless of the configured git email. See [`docs/github-identity.md`](docs/github-identity.md) for a detailed explanation.

- **ESLint** configured for the TypeScript frontend (`eslint.config.js`).  
  Rules: `no-explicit-any` (warn), `no-unused-vars` (warn), `no-non-null-assertion` (warn), `no-console` (warn), `eqeqeq` (error).

- **CI check job** added to `.github/workflows/build.yml`.  
  Runs TypeScript type check (`tsc --noEmit`) and `cargo clippy -- -D warnings` on Ubuntu before the platform matrix build starts. Errors in types or Rust lints now fail the build immediately instead of surfacing only at runtime.

- **CSP enabled** in `tauri.conf.json`.  
  Changed from `null` (disabled) to a minimal policy:  
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com data: blob:`  
  This blocks injection of external scripts while allowing inline styles (used throughout the HTML templates) and GitHub avatar images.

### Changed

**Features**

- **PR row right padding** made symmetric with left (18px both sides).

**Internal**

- **New PR branch detection overhauled** — reduced from 6+ round trips to 4. Round trip 1 now also fetches all open PR head refs per repo in the same batched GraphQL query, so branches that already have an open PR (including drafts) are excluded immediately without waiting for the candidate check in round trip 3.

- **`pr_cache` removed** — the `Mutex<HashMap<String, CachedPrDetails>>` cache in `AppState` was serving no purpose since a single GraphQL query already fetches all PR data fresh on every refresh. Removing it eliminates a source of stale data bugs (e.g. auto-merge not showing after being enabled).

- **Jira logs reduced** — removed all info/debug `eprintln!` from `jira.rs`; only errors are logged.

- **Frontend split into modules** (`src/main.ts` 1800 lines → 7 focused files):

  | File | Responsibility |
  |------|---------------|
  | `src/state.ts` | Single mutable state object shared across modules |
  | `src/utils.ts` | Pure helpers: `escHtml`, `avatarSm`, `SVG`, `chip`, `relativeTime`, `PRIORITY_RANK`, etc. |
  | `src/filters.ts` | List filter/sort logic: `applyListFilters`, notification counters |
  | `src/render.ts` | All `render*` functions, DOM helpers, notifications |
  | `src/api.ts` | Tauri `invoke` wrappers: `bootstrap`, `refreshDashboard`, `saveSettingsAndRefresh`, etc. |
  | `src/draft-pr.ts` | Add PR card component: render, load, publish |
  | `src/main.ts` | `DOMContentLoaded` bootstrap and event delegation only |

  Dependency order is linear (no cycles): `utils ← filters ← render ← api ← draft-pr ← main`.

- **Mutex poisoning eliminated** across all Rust modules.  
  Migrated from `std::sync::Mutex` to `parking_lot::Mutex` in `github.rs`, `jira.rs`, `lib.rs`, `dashboard.rs`, and `commands.rs`. `parking_lot::Mutex::lock()` returns the guard directly (no `Result`, no poisoning), removing all `.unwrap()` calls on lock acquisition.

- **`docs/github-identity.md`** added: detailed write-up on the difference between git author identity and GitHub account identity, and why the Activity API is the correct approach.

### Fixed

- **Memory leak in reviewer picker**: the `document.addEventListener("click", …)` that closes the picker was being added inside `renderDraftPrCard()` on every re-render. Moved to a setup-once call in `DOMContentLoaded`.

- **Race condition in `refreshDashboard`**: concurrent calls could both pass the `refreshInProgress` guard before the flag was set, or a slow response could overwrite a newer one. Fixed with a monotonic `refreshRequestId`; stale responses are silently discarded.

- **XSS-class rendering bug**: `pr.title`, `pr.author`, and reviewer logins were inserted into `innerHTML` templates without escaping. Wrapped with `escHtml()` throughout `renderPRRow` and `renderDraftPrCard`.

- **`open_external` URL validation**: the Tauri command now rejects any URL that does not start with `http://` or `https://`, preventing arbitrary scheme invocations from the frontend.

- **Duplicate `@keyframes spin`** in `src/index.css`: three identical definitions existed; reduced to one.

- **Debug `eprintln!` statements** removed from `commands.rs` and `github.rs` (left over from branch-detection debugging). They were leaking repo names and branch names to stderr in production builds.

---

## [0.4.4] — 2025

_Previous release. See git history for details._
