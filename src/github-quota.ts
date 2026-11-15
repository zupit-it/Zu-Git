// ── GitHub's hourly limits ────────────────────────────────────────────────────
// How much of them the token has used, as the backend reads it from the headers
// of GitHub's answers (quota.rs): nothing is asked of GitHub for it. Two limits
// matter, each with its own hour — GraphQL in points (the PR list, a PR read on
// its own, auto-merge, rebase) and REST in requests (diffs, files, reviews).
//
// What to show of them, as plain data: the top bar draws it (github-quota-bar.ts).

export interface QuotaBucket {
  limit: number;
  used: number;
  /** When the hour ends and `used` goes back to zero, in seconds since the epoch. */
  resetAt: number;
}

export interface GithubQuota {
  graphql: QuotaBucket | null;
  rest: QuotaBucket | null;
}

export interface QuotaView {
  /** In the top bar: the limit used the most, as `used/limit`. */
  text: string;
  /** On hover: both limits in full, and when each starts again. */
  title: string;
  /** How close that limit is: from 70% it shows, from 90% it warns. */
  level: "ok" | "warn" | "danger";
  /** When a limit next starts again from zero (ms since the epoch), to draw it then; null when none will. */
  nextReset: number | null;
}

const WARN_FROM = 0.7;
const DANGER_FROM = 0.9;

const count = (n: number): string => n.toLocaleString("en-US");

/** The limit as it stands at `now`: past its hour's end GitHub counts from zero again, whatever its last answer said. */
function standing(bucket: QuotaBucket, now: number): QuotaBucket {
  return now >= bucket.resetAt * 1000 ? { ...bucket, used: 0 } : bucket;
}

function line(name: string, unit: string, bucket: QuotaBucket, now: number): string {
  const starts = now >= bucket.resetAt * 1000
    ? "a new hour has started"
    : `back to 0 at ${new Date(bucket.resetAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return `${name}: ${count(bucket.used)} of ${count(bucket.limit)} ${unit} · ${starts}`;
}

/** What the top bar shows of `quota` at `now` (ms since the epoch); null while GitHub has said nothing yet. */
export function quotaView(quota: GithubQuota | null, now: number): QuotaView | null {
  const limits = [
    { name: "GraphQL", unit: "points", bucket: quota?.graphql ?? null },
    { name: "REST", unit: "requests", bucket: quota?.rest ?? null },
  ].flatMap((l) => (l.bucket && l.bucket.limit > 0 ? [{ ...l, bucket: standing(l.bucket, now) }] : []));
  if (limits.length === 0) return null;

  const share = (b: QuotaBucket) => b.used / b.limit;
  const most = limits.reduce((a, b) => (share(b.bucket) > share(a.bucket) ? b : a));
  const used = share(most.bucket);
  const resets = limits.map((l) => l.bucket.resetAt * 1000).filter((at) => at > now);
  return {
    text: `${most.bucket.used}/${most.bucket.limit}`,
    title: ["GitHub API, this hour", ...limits.map((l) => line(l.name, l.unit, l.bucket, now))].join("\n"),
    level: used >= DANGER_FROM ? "danger" : used >= WARN_FROM ? "warn" : "ok",
    nextReset: resets.length ? Math.min(...resets) : null,
  };
}
