// Release map layout: where each story sits on the "metro map" of a release.
//
// Two modes, one picture:
// - beta (diff on main): a single line from the last tag to HEAD, then a dashed
//   stretch to the next tag carrying the planned stories not merged yet;
// - branch (diff on a release branch): main on top, the release branch below,
//   a drop line for every cherry-pick and a ghost for every verified story
//   that still has to be picked.
//
// Pure data in, columns out — no DOM — so the rules stay testable.

export interface MapItem {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  fixVersions: string[];
  prUrl?: string;
  prNumber?: number;
  author: string;
  initials: string;
  avatarColor: string;
  avatarUrl?: string;
  flag?: string;
  mergedAt?: string;
}

export interface MainlineCommit {
  number: number;
  url: string;
  title: string;
  mergedAt: string;
  jiraKeys: string[];
}

export interface MainlineTag {
  name: string;
  date: string;
}

export interface Mainline {
  branch: string;
  commits: MainlineCommit[];
  tags: MainlineTag[];
}

export interface OpenPr {
  number: number;
  url: string;
}

export interface MapInput {
  done: MapItem[];
  missing: MapItem[];
  extra: MapItem[];
  sinceTag: string;
  /** Compared branch; "" = the default branch (beta mode). */
  branch: string;
  mainline?: Mainline | null;
  /** Open PRs by Jira key — tells a ghost that is about to land from one not started. */
  openPrs?: Record<string, OpenPr>;
}

export type StationKind =
  | "landed"   // planned and on the compared branch
  | "extra"    // on the compared branch but not planned for this release
  | "to-pick"  // verified on main, not on the release branch yet
  | "testing"  // on main, not verified yet — nothing to pick
  | "incoming" // planned, not merged anywhere yet
  | "earlier"  // planned and done, but landed before the tag window
  | "cluster"; // unrelated main PRs collapsed into one stop

export type Lane = "main" | "branch";

export interface Station {
  id: string;
  lane: Lane;
  col: number;
  kind: StationKind;
  /** Jira keys behind the stop; the first one names it. */
  keys: string[];
  label: string;
  /** Small caption under the stop, e.g. the open PR of a ghost. */
  sub?: string;
  /** Not on that lane yet: drawn dashed. */
  ghost: boolean;
  /** Collapsed stops (cluster / earlier): how many, and what. */
  count?: number;
  titles?: string[];
  /** The PR that put the stop on main, when it is known from main's history. */
  mainPr?: { number: number; mergedAt: string };
}

export interface Link {
  col: number;
  kind: "landed" | "extra" | "to-pick";
  keys: string[];
}

export interface TagMark {
  lane: Lane;
  col: number;
  name: string;
  /** start: the line begins at it · next: the tag being prepared · flag: a tag passed on main. */
  style: "start" | "next" | "flag";
}

export interface LaneSpan {
  name: string;
  /** Last column of the solid stretch (what is merged); dashed after it. */
  head: number;
  /** Last column the lane reaches. */
  to: number;
}

export interface MapLayout {
  mode: "beta" | "branch";
  cols: number;
  stations: Station[];
  links: Link[];
  tags: TagMark[];
  main: LaneSpan;
  branch?: LaneSpan;
  items: Map<string, { item: MapItem; kind: StationKind }>;
  /** Stories per kind (not stops). */
  counts: Record<StationKind, number>;
  /** Verified stories that can't be picked yet: their PR carries one still in testing. */
  blocked: number;
  sinceTag: string;
  nextTag: string;
}

const READY_STATUSES = new Set(["verified", "closed", "released", "done"]);

/** QA is through: the story can go to the release branch. */
export function isReadyToPick(item: MapItem): boolean {
  return READY_STATUSES.has(item.status.toLowerCase());
}

/** First tag of a (possibly multi-repo, " · "-joined) since-tag string. */
export function firstTag(sinceTag: string): string {
  return sinceTag.split(" · ")[0]?.trim() ?? "";
}

/** The tag the release is heading to: the last tag's trailing number + 1. */
export function nextTagName(sinceTag: string): string {
  const match = /^(.*?)(\d+)$/.exec(firstTag(sinceTag));
  return match ? `${match[1]}${Number(match[2]) + 1}` : "";
}

const byMergedAt = (a: MapItem, b: MapItem) =>
  (a.mergedAt ?? "").localeCompare(b.mergedAt ?? "") || a.key.localeCompare(b.key);

/** Open PR first (about to land), then "Jira says ready", then by key. */
function incomingOrder(openPrs: Record<string, OpenPr>) {
  const rank = (it: MapItem) => (openPrs[it.key] ? 0 : it.flag === "no-pr" ? 1 : 2);
  return (a: MapItem, b: MapItem) => rank(a) - rank(b) || a.key.localeCompare(b.key);
}

function emptyCounts(): Record<StationKind, number> {
  return { landed: 0, extra: 0, "to-pick": 0, testing: 0, incoming: 0, earlier: 0, cluster: 0 };
}

function ghostCaption(item: MapItem, openPrs: Record<string, OpenPr>): string {
  const pr = openPrs[item.key];
  return pr ? `PR #${pr.number}` : "no PR";
}

/**
 * Stories that travel together — one PR, `feat(PENT-1,PENT-2): …` — make one
 * stop. Order is kept: a group sits where its first story would.
 */
function groupTogether<T>(list: T[], idOf: (t: T) => string | undefined): T[][] {
  const byId = new Map<string, T[]>();
  const out: T[][] = [];
  for (const t of list) {
    const id = idOf(t);
    const group = id ? byId.get(id) : undefined;
    if (group) {
      group.push(t);
      continue;
    }
    const fresh = [t];
    if (id) byId.set(id, fresh);
    out.push(fresh);
  }
  return out;
}

export function stopLabel(keys: string[]): string {
  return keys.length > 1 ? `${keys[0]} +${keys.length - 1}` : keys[0] ?? "";
}

/**
 * What one stop carrying several stories means for the release. On the branch
 * wins over everything (an unplanned passenger is worth the warning); a PR is
 * picked whole, so a single story still in testing holds the others back.
 */
export function stopKind(kinds: StationKind[]): StationKind {
  if (kinds.includes("landed") || kinds.includes("extra")) return kinds.includes("extra") ? "extra" : "landed";
  if (kinds.includes("testing")) return "testing";
  if (kinds.includes("to-pick")) return "to-pick";
  return kinds[0] ?? "landed";
}

export function buildReleaseMapLayout(input: MapInput): MapLayout {
  return input.branch && input.mainline
    ? layoutBranch(input, input.mainline)
    : layoutBeta(input);
}

// ── Beta: one line on main ────────────────────────────────────────────────────

function layoutBeta(input: MapInput): MapLayout {
  const openPrs = input.openPrs ?? {};
  const stations: Station[] = [];
  const tags: TagMark[] = [];
  const items = new Map<string, { item: MapItem; kind: StationKind }>();
  const counts = emptyCounts();
  const sinceTag = firstTag(input.sinceTag);
  const nextTag = nextTagName(input.sinceTag);
  let col = 0;

  // Done without a merge in the window: Jira trusts them, so they shipped in
  // an earlier tag. One stop stands for all of them.
  const earlier = input.done.filter(it => !it.mergedAt);
  if (earlier.length > 0) {
    earlier.forEach(it => items.set(it.key, { item: it, kind: "earlier" }));
    stations.push({
      id: "earlier", lane: "main", col: col++, kind: "earlier", ghost: false,
      keys: earlier.map(it => it.key), label: "", count: earlier.length,
    });
    counts.earlier = earlier.length;
  }

  if (sinceTag) tags.push({ lane: "main", col: col++, name: sinceTag, style: "start" });

  const landed: Array<[MapItem, StationKind]> = [
    ...input.done.filter(it => it.mergedAt).map(it => [it, "landed"] as [MapItem, StationKind]),
    ...input.extra.map(it => [it, "extra"] as [MapItem, StationKind]),
  ];
  landed.sort(([a], [b]) => byMergedAt(a, b));
  for (const group of groupTogether(landed, ([item]) => item.prUrl)) {
    const keys = group.map(([item]) => item.key);
    group.forEach(([item, kind]) => { items.set(item.key, { item, kind }); counts[kind]++; });
    stations.push({
      id: `m:${keys[0]}`, lane: "main", col: col++, kind: stopKind(group.map(([, kind]) => kind)),
      ghost: false, keys, label: stopLabel(keys),
    });
  }

  // Nothing at all before HEAD: keep one empty column for it.
  if (col === 0) col = 1;
  const head = col - 1;

  const incoming = [...input.missing].sort(incomingOrder(openPrs));
  for (const group of groupTogether(incoming, it => openPrs[it.key]?.url)) {
    const keys = group.map(it => it.key);
    group.forEach(it => items.set(it.key, { item: it, kind: "incoming" }));
    counts.incoming += group.length;
    stations.push({
      id: `m:${keys[0]}`, lane: "main", col: col++, kind: "incoming", ghost: true,
      keys, label: stopLabel(keys), sub: ghostCaption(group[0], openPrs),
    });
  }

  tags.push({ lane: "main", col, name: nextTag, style: "next" });

  return {
    mode: "beta",
    cols: col + 1,
    stations,
    links: [],
    tags,
    blocked: 0,
    main: { name: "main", head, to: col },
    items,
    counts,
    sinceTag,
    nextTag,
  };
}

// ── Branch: main above, the release branch below ──────────────────────────────

function layoutBranch(input: MapInput, mainline: Mainline): MapLayout {
  const openPrs = input.openPrs ?? {};
  const stations: Station[] = [];
  const links: Link[] = [];
  const tags: TagMark[] = [];
  const items = new Map<string, { item: MapItem; kind: StationKind }>();
  const counts = emptyCounts();
  const sinceTag = firstTag(input.sinceTag);
  const nextTag = nextTagName(input.sinceTag);
  const commits = mainline.commits;

  // A story's stop on main is its last PR there: the one that completed it.
  const ownerIdx = new Map<string, number>();
  commits.forEach((c, i) => c.jiraKeys.forEach(k => ownerIdx.set(k, i)));

  input.done.forEach(it => items.set(it.key, { item: it, kind: "landed" }));
  input.extra.forEach(it => items.set(it.key, { item: it, kind: "extra" }));
  for (const it of input.missing) {
    const kind: StationKind = isReadyToPick(it) ? "to-pick" : ownerIdx.has(it.key) ? "testing" : "incoming";
    items.set(it.key, { item: it, kind });
  }

  const ownedKeys = (i: number) =>
    commits[i].jiraKeys.filter(k => items.has(k) && ownerIdx.get(k) === i && items.get(k)?.kind !== "incoming");
  const relevant = commits.map((_, i) => ownedKeys(i).length > 0);
  const start = relevant.indexOf(true);

  // Column 0 is where the release branch forks off; main's window starts at 1.
  let col = 1;
  const colOfCommit = new Map<number, number>();
  const placedOnMain = new Set<string>();
  let blocked = 0;
  let cluster: number[] = [];
  const flushCluster = () => {
    if (cluster.length === 0) return;
    stations.push({
      id: `c:${col}`, lane: "main", col, kind: "cluster", ghost: false, keys: [], label: "",
      count: cluster.length, titles: cluster.map(i => commits[i].title),
    });
    cluster.forEach(i => colOfCommit.set(i, col));
    counts.cluster += cluster.length;
    col++;
    cluster = [];
  };

  for (let i = Math.max(start, 0); start >= 0 && i < commits.length; i++) {
    if (!relevant[i]) {
      cluster.push(i);
      continue;
    }
    flushCluster();
    const keys = ownedKeys(i);
    const kinds = keys.map(k => items.get(k)?.kind ?? "landed");
    const kind = stopKind(kinds);
    const label = stopLabel(keys);
    keys.forEach(k => placedOnMain.add(k));
    const mainPr = { number: commits[i].number, mergedAt: commits[i].mergedAt };
    // A PR held back by one story still in testing says how far along it is.
    const ready = kinds.filter(k => k === "to-pick").length;
    const sub = kind === "testing" && keys.length > 1 ? `${ready}/${keys.length} verified` : undefined;
    if (kind === "testing") blocked += ready;
    stations.push({ id: `m:${i}`, lane: "main", col, kind, ghost: false, keys, label, mainPr, sub });
    if (kind === "landed" || kind === "extra" || kind === "to-pick") {
      stations.push({ id: `b:${i}`, lane: "branch", col, kind, ghost: kind === "to-pick", keys, label });
      links.push({ col, kind, keys });
    }
    colOfCommit.set(i, col);
    col++;
  }
  flushCluster();
  const mainHead = col - 1;

  // Tags passed on main inside the window sit on the last stop before them.
  for (const tag of mainline.tags) {
    let at = -1;
    colOfCommit.forEach((c, i) => {
      if (commits[i].mergedAt <= tag.date && c > at) at = c;
    });
    if (at >= 0) tags.push({ lane: "main", col: at, name: tag.name, style: "flag" });
  }

  // After main's window: what reached the branch without a stop on main
  // (hotfixes, or stories older than the window), then ghosts nobody can place.
  let branchCol = col;
  let branchHead = 0;
  stations.filter(s => s.lane === "branch" && !s.ghost).forEach(s => { branchHead = Math.max(branchHead, s.col); });
  const branchOnly = [...input.done, ...input.extra].filter(it => !placedOnMain.has(it.key)).sort(byMergedAt);
  for (const group of groupTogether(branchOnly, it => it.prUrl)) {
    const keys = group.map(it => it.key);
    const kind = stopKind(keys.map(k => items.get(k)?.kind ?? "landed"));
    stations.push({ id: `b:${keys[0]}`, lane: "branch", col: branchCol, kind, ghost: false, keys, label: stopLabel(keys) });
    branchHead = branchCol++;
  }
  for (const item of input.missing.filter(it => !placedOnMain.has(it.key) && items.get(it.key)?.kind === "to-pick")) {
    stations.push({ id: `b:${item.key}`, lane: "branch", col: branchCol++, kind: "to-pick", ghost: true, keys: [item.key], label: item.key });
  }

  let mainCol = col;
  const incoming = input.missing.filter(it => items.get(it.key)?.kind === "incoming").sort(incomingOrder(openPrs));
  for (const group of groupTogether(incoming, it => openPrs[it.key]?.url)) {
    const keys = group.map(it => it.key);
    stations.push({
      id: `m:${keys[0]}`, lane: "main", col: mainCol++, kind: "incoming", ghost: true,
      keys, label: stopLabel(keys), sub: ghostCaption(group[0], openPrs),
    });
  }

  for (const { kind } of items.values()) counts[kind]++;

  const end = Math.max(branchCol, mainCol, 1);
  if (sinceTag) tags.push({ lane: "branch", col: 0, name: sinceTag, style: "start" });
  tags.push({ lane: "branch", col: end, name: nextTag, style: "next" });

  return {
    mode: "branch",
    cols: end + 1,
    stations,
    links,
    tags,
    blocked,
    main: { name: mainline.branch || "main", head: Math.max(mainHead, 0), to: Math.max(mainCol - 1, mainHead, 0) },
    branch: { name: input.branch, head: branchHead, to: end },
    items,
    counts,
    sinceTag,
    nextTag,
  };
}
