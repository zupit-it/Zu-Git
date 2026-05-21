# My Reaction Score

A personal-only widget that shows the authenticated user a single score (0–100) representing how quickly they are reacting to items that are waiting specifically on them.

It is **not** a leaderboard, a team metric, or a performance indicator. It is a private action queue with a score attached, rendered as a compact pill at the left of the Review Load bar strip.

## Placement

The widget shares the horizontal Review Load bar strip. Layout:

```
[ MY SCORE ] [ ⊙62  Needs attention ] │ [ reviewer chips… ]
```

It is hidden entirely when no viewer identity is available (mock / unauthenticated mode).

## Score Model

Start from `100`. Subtract points only for personal items that have been waiting past their threshold.

| Situation | Threshold | Base penalty |
|---|---|---|
| A PR review is requested from me | > 1 h | −10 |
| A PR review is requested from me | > 4 h | −25 (replaces −10) |
| My PR has changes requested | > 2 h | −20 |
| My PR has a failed CI pipeline | > 1 h | −15 |
| My PR is behind or conflicting | > 2 h | −10 |

**Jira High / Highest priority items multiply the penalty by 1.5.**

Score is clamped to `[0, 100]`.

## Exclusions

- **Draft PRs** — skipped entirely (no penalties of any kind).
- **Stale approvals** — in this team's workflow, a stale approval counts as approved. The new diff is the responsibility of the next reviewer, not the original approver. No penalty is applied.
- **PRs where the viewer is not involved** — only PRs where the viewer is the author or a pending reviewer contribute to the score.

## Timing Proxy

All thresholds are measured against `updatedAtIso` — the ISO timestamp of when the PR was last updated on GitHub. This resets on any activity (commits, comments, labels), so it may underestimate how long a specific condition has been active. With 1–4 h thresholds this is acceptable noise.

## Tone Labels

| Score range | Label | Colour |
|---|---|---|
| 90–100 | **Clear** | Green |
| 70–89 | **Healthy** | Blue |
| 40–69 | **Needs attention** | Amber |
| 0–39 | **Stale** | Red |

## Tooltip

Hovering the score pill (after a 120 ms delay) shows a breakdown card with:

- The current score and tone label.
- "Why you're losing points" — the top 3 penalty items, sorted by penalty descending, each showing: Jira key, priority flag, time waited, one-line reason, and penalty value.
- A footer note explaining that the score recovers as items are acted on.

Up to 3 items are shown. Items beyond 3 are counted in the score but not listed (v2 scope).
