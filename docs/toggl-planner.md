# Toggl Planner

The planner proposes how to fill the free time of a working day on Toggl. Meetings come from Google Calendar, work from Jira stories, and the split between stories from evidence of what was actually worked on.

## Candidate Stories

A story can own free time when it is:

- **in progress** or in the **merge-request** status (the configured `jiraMergeTransition`), in the open sprint. Only when the user has nothing at all in the open sprints (a board without sprints) does this fall back to every story assigned to them — otherwise months-old stories left in those statuses would come back. The fallback only takes stories updated in the last 14 days;
- **touched**: moved by the user during the day, into any status (`status CHANGED BY currentUser() DURING (…)`), or seen in local activity. This is what catches stories moved straight to Developed, or left in To Do while being worked on. The query is deliberately not limited to `assignee = currentUser()`: moving a story to Developed often hands it to QA.

- **sprint** (only with *Gap filling* on): the user's stories in the open sprints, started or done. They only ever receive filled time.

Any board works (PENT, ZUME, …). Keys seen only in local activity are kept when their project is an official one — a prefix of an active story, one the user books on Toggl, or one mapped in the repo → board settings — and Jira knows them. Experimental work (branches without a key, keys of other projects) is ignored.

## Evidence (`activity.rs`, `toggl_day.rs`)

| Source | Where | Meaning |
|---|---|---|
| Jira transitions made by the user | changelog, author = `/myself` | into "In Progress" (or its localised name): work starts; into anything else: work just ended |
| Commits authored by the user | `git log --all` in every repository an AI session ran in during the last 45 days | work happened before the commit (author date, so rebases do not move it) |
| AI coding sessions | `~/.claude/projects/**/*.jsonl` (`gitBranch` per message), `~/.codex/sessions/**/*.jsonl` (branch in `session_meta`) | work happening right then; bucketed per 5 minutes |

Keys come from the commit subject or the branch name (`PENT-5755/rass`, case-insensitive). Local sources can be switched off with *Settings → Toggl → Activity*.

Jira moves made in the same minute share one unit of weight ("→ Developed (in blocco)"): dragging five stories across the board is tidying, not five pieces of work.

## Allocation (`planStories` in `toggl-plan.ts`)

1. Free time is cut into slot-sized cells (meetings and booked entries removed).
2. Each cell gets a score per story: a prior from the Jira status (halved on days with any activity, so a story parked "in progress" for weeks cannot outweigh one with commits today), plus a kernel per signal — symmetric for AI exchanges, reaching back ~75 min for commits and "→ Developed", forward for "→ In Progress".
3. Each story's share of the day is the sum, over the cells where it is plausible (≥ 60% of the best score), of its proportional part of the cell. Clear winners take the cell; genuine ties are shared.
4. Cells are handed out in time order, staying on the same story while it is plausible and has share left — contiguous blocks, not every gap cut in halves.
5. Runs shorter than an hour are folded into the neighbour that fits them best, shortest first (a gap shorter than an hour stays as it is). Hour-long blocks win over an exact proportional split.

Each row carries `basis` (`activity` / `status` / `fill`), a short `reason` ("3 commits · → Merge Request") and `alternatives`, rendered as one-click swaps.

## Gap Filling (optional)

*Settings → Toggl → Gap filling*. Stories are often done faster than their estimate, and the slack still has to be booked somewhere. With the option on, the cells no evidence explains are shared between the sprint's stories by what their estimate still leaves unbooked:

- **Pace**: median minutes per story point over the stories booked in the learned history (estimate from the "Story Points" / "Story point estimate" field, stories not started or still in progress left out, at least three stories). Relearned weekly with the rules; retried on open when missing.
- **Weight** per story: `points × pace − minutes already booked`, floored at zero. Stories without an estimate (bugs, sub-tasks) count as one point and never drop below half a point — booking more on them is fine.
- Without a pace, or when every budget is spent, weights fall back to the points.
- Only as many stories as can each get an hour take part, heaviest first. Rows read "Riempimento: 21 pt · 0h prenotate su 25.2h".

Booked minutes come from the learned Toggl history (`togglHistoryDays`, max 90): time booked on a story before that window is not seen, so a long-running story looks emptier than it is.

## Editing (`toggl.ts`, helpers in `toggl-plan.ts`)

- **Rail**: blocks move (`moveRow`, never over a neighbour), resize from either edge, and the seam between two touching rows moves the boundary (`moveEdge`: the touching row follows, each row keeps one slot; Alt detaches). A click on free time adds a row covering the gap (`gapAt`) with suggestions open. The same seam sits between touching cards, draggable or with ↑ ↓ when focused.
- **Fields** are always editable. Times: ↑ ↓ ±15 min (Shift ±1 h), or typed absolute (`9`, `930`, `9:30`) or relative (`+45m`, `-15`) — `parseTimeInput`; an end edit moves the boundary with the next row when they touch. Length: `45`, `1h30`, `1:15` — `parseDurationInput`.
- **Description** suggests today's stories, recurring activities, meeting bookings and past stories (accent-insensitive); picking one, or typing a Jira key, fills project, tag and billable from the learned rules.
- **Project / tag** open a searchable picker: most used first (usage summed over the learned rules), then A–Z.
- Re-renders keep scroll position and the focused field with its caret (`data-tg-focus` keys); a `change` fired by a field being swapped out mid-render is ignored.

## Learned Mapping

- `byKey` / `byPrefix` / `recurring`: learned from Toggl history (`toggl-rules.json`), relearned weekly.
- `byEvent`: calendar event → booking, keyed by recurring series id (`rec:…`) and normalised title (`title:…`). Learned by matching past events with the entries overlapping them (an entry mostly inside the event, or covering it while not much longer), so "Weekly sync Acme" finds its project even when it was booked as "Sync cliente".
- `toggl-event-memory.json`: what the user booked for a calendar row in the planner. Never expired and laid over the learned rules, so a meeting booked once is pre-filled next week even after the weekly relearn.

Title normalisation is Unicode-aware on both sides (`normalize_description` in Rust, `normalizeDescription` in TS) and must stay in step.

## MCP Server (`mcp.rs`)

`zugit --mcp` (same executable as the app) serves the Model Context Protocol over stdio. Tokens are read from the keychain by ZuGit and never appear in tool results.

| Tool | Effect |
|---|---|
| `toggl_get_day` | booked entries, meetings with suggestions, candidate stories, activity spans, free time, gap-filling weights, projects, tags |
| `toggl_propose_day` | validates and saves a plan to `toggl-proposals/<date>.json`; nothing is written to Toggl |
| `toggl_get_entries` | entries booked over up to 31 days, with totals per task |

Prompt: `fill_toggl_day`.

ZuGit polls for proposals every 15 seconds and notifies. An AI plan always comes first: with the planner closed it opens on that date showing the proposal; with the planner open on that date the proposal replaces the automatic plan at once, unless rows were edited (then a "Mostra la proposta" banner waits). Unconfirmed proposals for other days are listed in a banner; proposals older than 7 days are deleted. Proposal rows replace the automatic story rows; meetings the proposal does not cover are kept. *Use the automatic plan* deletes the proposal; a successful submit deletes it too.

Setup commands for Claude Code, Codex and Claude Desktop are shown in *Settings → Assistenti AI*.
