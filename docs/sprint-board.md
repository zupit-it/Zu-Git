# Sprint Board

The **Sprint** tab shows the active sprint of a Jira board as one compact board. It appears once Jira
is configured (URL, email, token).

## Board

- **Which board**: the boards of the projects in *Settings → Jira → repo → board*, plus the project
  prefixes seen on PRs. Kanban boards are left out (no sprints). With several boards or active
  sprints, the selector in the head switches; the choice is remembered (`localStorage`).
- **Columns** come from the board configuration (`/rest/agile/1.0/board/{id}/configuration`), each
  with the category its statuses share. A status the board does not map falls back to the first
  column of its category, so a story never vanishes.
- **Issues**: `/rest/agile/1.0/board/{id}/sprint/{id}/issue`, i.e. the sprint as the board's filter
  sees it, without sub-tasks. Points come from the board's estimation field, falling back to the
  "Story Points" / "Story point estimate" fields.
- **Card**: assignee face (Jira avatar, initials when it does not load), key, points, Jira's flag
  when set, and a dot for the story's open PRs (`prSignal`): red CI failing, amber changes
  requested or a review waiting for more than 48 h, green every PR approved, hollow in review or draft.
  Your own stories have a violet border. **Titoli** shows each card as a row with its title.
- **Persone**: one row per person — you first, then by name, unassigned last — with the open points
  and a bar relative to the team's average (amber over 115%, red over 140%).
- **Head**: day of the sprint (working days; "Sprint finito" past its end), the faces as a person
  filter (others are dimmed, not hidden), search on key, title, person, epic and labels (`/` or ⌘F).
- **Progress bar**: green is the points of the stories in done-category columns over the sprint's
  total (filed stories left out). The dark tick is where the team would be today at a steady pace:
  the share of the sprint's working days behind us — a working day in progress counts half, a
  weekend adds nothing, past the end it is all of it (`sprintClock`). Green more than 10 points
  behind the tick turns amber.
- **Jira's flag** is shown as information — a sky-blue flag — and never marks a story as blocked:
  Jira calls it an impediment, but teams use it their own way (e.g. "deployed on test"). Its name
  can be set per board, in this browser — "Flag" by default, "In test", or any other — from the
  board/sprint menu in the head ("Nome del flag di Jira…"), the Flag field of a flagged story, or a
  right click on a flagged card. The standup lists the flags set since then under that name.

## Side panel

A click opens the story: status (the workflow's transitions), assignee (people of the sprint, then
the project's assignable users), points, category; epic, fix versions, priority and labels read-only.
Then the open PRs (a click opens the diff), the checklist (the same field the draft PR reads and
writes), the description and comments (ADF rendered by `adf.ts`: every text escaped, links limited to
http(s) and mailto and opened in the browser), the attachments, sub-tasks, and a comment box (⌘↵).
↑/↓ or j/k step through the board's stories; Esc closes.

The panel's left edge drags to resize it (← / → when focused, double click back to 460 px). The
width chosen is remembered as it is (`localStorage`); CSS shows `min(width, 90vw)` and never less
than 360 px, so a wide panel set on a big screen shrinks on a laptop's and comes back on the big one.

### Attachments

Jira serves attachments only with credentials, which an `<img>` in the webview cannot send. The
backend downloads them (`sprint_attachment`, raw bytes to an `ArrayBuffer`, no base64) and the panel
shows them through blob URLs — the CSP allows `blob:` images, not Jira's hosts.

- **Which attachment an image is**: ADF media nodes only carry a media-services id. The detail is read
  with `expand=renderedFields`, whose HTML names the attachment ids in document order; nodes and ids
  are paired by position when the counts match, else by the file name the editor recorded (`alt`),
  else — one image in the text, one image attached — they are the same (`map_media`).
- **Originals**: pictures are shown from the file itself, four downloads at a time — Jira's
  thumbnails (`/attachment/thumbnail/{id}`) are scaled down and soft, unreadable for a screenshot, so
  they are only a fallback when the original is out of reach (over 30 MB, or a failed download). The
  full-size view then opens at once, from the same copy. Bytes are cached in Rust (96 MB) and object
  URLs in the panel (200 MB, least recently used first, never one still on screen); attachments never
  change. The blob's type comes from the bytes (`sniffImageType`).
- **In the text**: pictures keep their original ratio while loading, so the text does not jump; a
  picture in a media group is a tile; other files are chips that open in the browser
  (`/secure/attachment/{id}/{name}`, downloaded with the user's Jira session).
- **Allegati** lists every attachment: pictures as a grid, other files (PDF, HEIC…) as rows. Formats the
  webview cannot show, or a picture that fails to decode, fall back to opening the file.
- **Full size**: a click on a picture opens it over the window, with ← / → through the story's
  pictures (text first, then attachments) and Esc to close.

The fields follow the user's Jira permissions (`/rest/api/3/mypermissions`): without them the field
is read-only, and Jira's own refusal is shown when it says no anyway.

## Moving stories

Drag and drop uses pointer events, not HTML5 drag and drop (the Tauri window intercepts drops on
Windows). As soon as a card lifts, the transitions of the story are read and the columns the
workflow cannot reach are hatched. Dropping:

- on a column — the transition into it; with several statuses in the column, a menu asks which;
  a transition with required fields (resolution…) is left to Jira;
- on a cell of the **Persone** view — status and assignee at once;
- on a category chip — files the story there.

Moves are applied at once and written to Jira one story at a time; a refused part goes back where
it was with Jira's reason. The toast offers **Annulla** (itself a transition back, when the workflow
has one). A few seconds later the board is read again, to pick up Jira automations.

⌘-click (Ctrl-click) selects; the bar at the bottom sets category, assignee or status of the whole
selection, and dragging a selected card moves all of it. A right click on a card offers the same
actions (for the selection when the card is part of it), plus "Apri in Jira" and "Copia la chiave".

## Categories

Personal groups of stories ("Attività ricorrenti") kept off the board, its totals and the standup
summary. Stored by Jira key in `sprint-categories.json` in ZuGit's data folder — local, because
developers cannot always edit the stories, and keyed by story so a recurring task stays filed for as
long as it lives. The chip in the head opens the list in the side panel; rename, colour and delete from
its ⋯ menu.

A story that leaves the sprint stays in its category — remembered, not shown: recurring stories hop
from sprint to sprint, and between two sprints they often sit in none, so dropping them would put them
back on the board at every new sprint. The category's list shows the stories in the sprint; the ones
outside fold into "N ricordate, fuori da questo sprint", read from Jira only when that line is
opened. There each can leave the category, and "Togli le N chiuse" drops at once those closed on
Jira or no longer found (with undo). The **Categorie** button next to the chips is
always there — before the first category exists it is the way in: it explains what a category does,
creates one (with the selected stories, if any) and opens it.

## Standup summary

The strip above the board covers the time since the previous working day's standup — 8:00 by
default (Friday on a Monday). A click on "Da ieri 8:00" sets another time, kept per user.

- **What changed** — Jira's history of the sprint's stories updated since then
  (`search/jql?expand=changelog`, with a relative `updated >= -Nm` so the user's Jira time zone does
  not matter; a story whose embedded changelog is truncated gets its last page read too). Net changes
  per story (`summarizeChanges`): from where it was at the standup to where it is now, so a move there
  and back is no news — closed, moved forward, moved back, added to the sprint, flag set, reassigned,
  estimate changed.
- **Da sbloccare** — the state of the PRs right now, from the dashboard already loaded: CI failing,
  changes requested, reviews waiting for more than 48 h. Not a change: a separate group.
- **Pace**: points closed per working day so far and per remaining day needed to close the sprint.

**Evidenzia sulla board** turns the board into the standup's agenda: stories changed since then show
what happened on a line of their own ("da To Do · prima: Federico Rossi", "chiusa", "stima 5 → 8"),
with a border in the colour of the change; the others are dimmed. In the **Persone** view each person
reads "N cambiamenti". The tooltip of a changed story lists the history behind it (who, what, when).
Esc leaves the mode.

## Code

| File | Role |
|---|---|
| `src-tauri/src/sprint.rs` | Agile and platform API calls, pure mappers (tested) |
| `src/sprint-model.ts` | Columns, totals, sprint clock, standup, PR signal, categories (tested) |
| `src/adf.ts` | ADF → HTML (tested) |
| `src/sprint-store.ts` | State, loading, optimistic writes with undo, shared menus |
| `src/sprint.ts` | Head, standup strip, board, drag and drop, keyboard |
| `src/sprint-panel.ts` | Story detail, attachments and category list |
| `src/sprint-lightbox.ts` | Full-size view of a story's pictures |
| `src/sprint-ui.ts` | Popover menu and toasts |
