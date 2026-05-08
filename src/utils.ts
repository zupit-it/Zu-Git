import type { PullRequestSummary } from "./shared/pr-model";

// ── HTML escaping ─────────────────────────────────────────────────────────────

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Time ──────────────────────────────────────────────────────────────────────

export function relativeTime(isoString: string): string {
  const mins = Math.floor((Date.now() - Date.parse(isoString)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`;
  return `${Math.floor(mins / 1440)} d ago`;
}

// ── Avatar ────────────────────────────────────────────────────────────────────

export const AVATAR_COLORS = [
  '#4f46e5', '#7c3aed', '#db2777', '#dc2626',
  '#d97706', '#059669', '#0891b2', '#2563eb',
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function avatarSm(name: string, avatarUrl?: string): string {
  if (avatarUrl) {
    return `<img class="avatar avatar-sm" src="${avatarUrl}" alt="${name}" loading="lazy" />`;
  }
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const color = avatarColor(name);
  return `<span class="avatar avatar-sm" style="background:${color}" aria-hidden="true">${initial}</span>`;
}

// ── Reviewer load helpers ─────────────────────────────────────────────────────

/** Maps actionable count to a load level 0-4 (per-person scale). */
export function personLoadLevel(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 2;
  if (n === 3) return 3;
  return 4;
}

/** Maps total team actionable to a load level 0-4 (team scale). */
export function teamLoadLevel(n: number): number {
  if (n <= 0) return 0;
  if (n <= 3) return 1;
  if (n <= 5) return 2;
  if (n <= 7) return 3;
  return 4;
}

/** 2-char initials from a stripped login (e.g. "giorgio-betta" → "GB"). */
export function loginInitials(stripped: string): string {
  const parts = stripped.split("-").filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return stripped.slice(0, 2).toUpperCase();
}

// ── Diff stat helpers ─────────────────────────────────────────────────────────

export function formatDiffNum(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(n);
}

export function diffSizeBucket(total: number): string {
  if (total <= 50)   return "xs";
  if (total <= 200)  return "s";
  if (total <= 500)  return "m";
  if (total <= 1000) return "l";
  return "xl";
}

// ── Set helpers ───────────────────────────────────────────────────────────────

export function countNewIds(next: Set<string>, previous: Set<string>): number {
  let count = 0;
  for (const id of next) {
    if (!previous.has(id)) {
      count += 1;
    }
  }
  return count;
}

// ── Chip helper ───────────────────────────────────────────────────────────────

export function chip(kind: string, content: string, icon = ""): string {
  return `<span class="chip chip-${kind}">${icon}${content}</span>`;
}

// ── Priority rank (used for sorting) ──────────────────────────────────────────

export const PRIORITY_RANK: Record<string, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

// ── Inline SVG icons ──────────────────────────────────────────────────────────

export const SVG = {
  gitpr: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="3" cy="3" r="1.4"/><circle cx="3" cy="9" r="1.4"/><circle cx="9" cy="9" r="1.4"/><path d="M3 4.4v3.2M9 7.6V6a2 2 0 0 0-2-2H5.5"/><path d="M6.5 2.5L5 4l1.5 1.5"/></svg>`,
  draft: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="4.5" stroke-dasharray="2 1.8"/><path d="M6 4v2.5L7.5 8"/></svg>`,
  clock: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5v3L8 8"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`,
  x: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`,
  ext: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 2H2v6h6V6M5.5 1.5h3v3M4.5 5.5l4-4"/></svg>`,
  jira: `<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M6 1L1 6l5 5 1.3-1.3L3.6 6 7.3 2.3z" opacity=".7"/><path d="M6 4.7L8.4 7.1 6 9.5V11l5-5-5-5z"/></svg>`,
  priorityHighest: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8l4-4 4 4"/><path d="M2 5l4-4 4 4"/></svg>`,
  priorityHigh:    `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5l4-5 4 5"/></svg>`,
  priorityMedium:  `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#ca8a04" stroke-width="2" stroke-linecap="round"><path d="M2 4.5h8M2 7.5h8"/></svg>`,
  priorityLow:     `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5l4 5 4-5"/></svg>`,
  rerequest: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5A4.5 4.5 0 1 0 11 7"/><path d="M10 1v3h-3"/></svg>`,
  autoMerge: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="6" cy="9" r="1.4"/><path d="M3 4.4v1.1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V4.4M6 7.5v1.1"/></svg>`,
  threads: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h8M2 6h5M2 9h3"/></svg>`,
  behind: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v6M3 6l3 3 3-3"/><path d="M2 10h8"/></svg>`,
  conflict: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v4M6 9v1"/></svg>`,
  promote: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2M3 5l3-3 3 3"/><path d="M2 10h8"/></svg>`,
};

// ── Search ────────────────────────────────────────────────────────────────────

export function matchesSearch(pr: PullRequestSummary, query: string): boolean {
  if (!query) return true;

  const haystack = [
    pr.title,
    pr.jiraKey,
    pr.jiraSummary,
    pr.repo,
    pr.author,
    pr.jiraRelease,
    pr.jiraStatus,
    pr.jiraBoard,
    ...pr.pendingReviewers.map((actor) => actor.login),
    ...pr.currentApprovers.map((actor) => actor.login),
    ...pr.staleApprovers.map((actor) => actor.login),
    ...pr.blockingReviewers.map((actor) => actor.login),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}
