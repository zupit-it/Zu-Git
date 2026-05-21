# Design Brief — My Reaction Score

## What is it?

A personal-only card that shows the authenticated GitHub user a single score (0–100) representing how quickly they are reacting to items that are waiting specifically on them.

It is **not** a leaderboard, not a team metric, not a performance indicator. It is a private action queue with a score attached.

---

## Score model

Start from 100. Subtract points only for actionable personal items that have been waiting past a short threshold.

| Situation | Threshold | Penalty |
|---|---|---|
| A PR review is requested from me | > 1 h | −10 |
| A PR review is requested from me | > 4 h | −25 |
| My approval went stale (author pushed new commits) | > 1 h | −15 |
| My PR has changes requested (reviewer is blocking) | > 2 h | −20 |
| My PR has a failed CI pipeline | > 1 h | −15 |
| My PR is behind or conflicting | > 2 h | −10 |
| My PR has unresolved review threads | > 4 h | −10 |

Jira High / Highest priority items have their penalty multiplied by 1.5. Score clamped to [0, 100].

**Labels:**
- 90–100 → **Clear** (green)
- 70–89 → **Healthy** (teal/blue)
- 40–69 → **Needs attention** (amber)
- 0–39 → **Stale** (red)

---

## Data available per item

Each "debt" item carries:
- PR title, repo, number, URL
- Item kind: review request / my PR changes requested / CI failed / behind / unresolved threads / re-review needed
- How many hours it has been waiting
- The calculated penalty
- A one-line human reason (e.g. "Review requested 3 h ago · PAY-184 High")
- Optional Jira key + priority

---

## Totals breakdown

Four counters:
- **Reviews waiting** — PRs where I am a pending reviewer
- **My PRs need action** — My PRs with changes requested or unresolved threads
- **CI failures** — My PRs with a failed pipeline
- **Behind / conflict** — My PRs that are behind or conflicting

---

## States to design

1. **Score with items** — the normal case: score number, label pill, 4 counters, list of items
2. **Perfect score** — score = 100, nothing waiting, short positive message
3. **Hidden** — when not logged in / mock mode (no viewer identity)

---

## Existing UI context

ZuGit is a Tauri desktop app with a vanilla HTML/CSS/TypeScript UI. No component framework.

The **Status tab** currently contains:
1. A 3-card summary grid (Open PRs · Stale approvals · High priority) — `metric-card` pattern, large number + label
2. A 2-card integration grid (GitHub · Jira) — `integration-card` pattern, status pill + detail text
3. Token storage card
4. Repository sync cards
5. Warnings list

Design tokens in use:
- `var(--surface)`, `var(--surface-alt)`, `var(--border)`, `var(--ink)`, `var(--ink-muted)`, `var(--accent)`
- Border radius: `var(--r-lg)`, `var(--r)`
- Card padding: `18px 20px`
- Label style: `10.5px · uppercase · 700 · letter-spacing 1.1px · var(--ink-muted)`
- Metric value style: `2rem · 700 · var(--ink)`
- Pill style: `inline-flex · height 22px · padding 0 9px · border-radius 999px · 11px · 700`

---

## Questions for the designer

1. **Where does it live?** Should it be in the Status tab (and if so, where exactly — before or after the existing summary-grid? as a fourth metric card? as its own full-width section?), or does it deserve a dedicated tab?
2. **How prominent is the score number?** Same size as the existing metric cards (`2rem`) or larger since it is the primary personal signal?
3. **How is the item list shown?** Inline below the score (always visible), collapsible, or in a slide-out panel?
4. **How are the 4 counters laid out?** Inline chips? A mini 2×2 grid below the score? Hidden when zero?
5. **What visual language for the tone?** Border-left accent strip (like VS Code diagnostics), background tint, or just the pill colour?
