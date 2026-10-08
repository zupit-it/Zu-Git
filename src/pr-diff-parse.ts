/**
 * GitHub file patches → hunks and lines, for the PR diff view. Pure, with no
 * DOM, Tauri or Shiki dependency, so it can be tested on its own.
 */

export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading `+`, `-` or space. */
  text: string;
  /** Line number in the base file; null on added lines. */
  oldNo: number | null;
  /** Line number in the head file; null on removed lines. */
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** What git prints after the second `@@`: usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** GitHub's `patch` field: the hunks of one file, without the `diff --git` header. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const rows = patch.split("\n");
  // A trailing newline would otherwise read as an empty context line.
  if (rows[rows.length - 1] === "") rows.pop();

  for (const row of rows) {
    const header = HUNK_RE.exec(row);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      hunk = {
        oldStart: oldNo,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        section: header[5],
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    // "\ No newline at end of file" describes the line above, it is not code.
    if (!hunk || row.startsWith("\\")) continue;

    const text = row.slice(1);
    switch (row[0]) {
      case "+": hunk.lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ }); break;
      case "-": hunk.lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null }); break;
      default:  hunk.lines.push({ kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ }); break;
    }
  }
  return hunks;
}

/**
 * The last lines of a GitHub `diffHunk`, which ends on the commented line:
 * the code an outdated conversation was written on.
 */
export function hunkTail(diffHunk: string, count: number): DiffLine[] {
  return parsePatch(diffHunk).flatMap(h => h.lines).slice(-count);
}

const numberOn = (side: "new" | "old") => (l: DiffLine) => (side === "new" ? l.newNo : l.oldNo);

/**
 * The code a comment is written on, kept the way GitHub keeps it (`diffHunk`):
 * a few lines of context from its hunk, then its range, ending on its last
 * line. Null when the diff does not show that line.
 */
export function hunkFor(
  hunks: DiffHunk[], side: "new" | "old", line: number, endLine: number | null, context = 3,
): string | null {
  const no = numberOn(side);
  for (const hunk of hunks) {
    const end = hunk.lines.findIndex(l => no(l) === (endLine ?? line));
    if (end === -1) continue;
    const start = hunk.lines.findIndex(l => no(l) === line);
    const from = Math.max(0, (start === -1 ? end : start) - context);
    const before = hunk.lines.slice(0, from);
    const slice = hunk.lines.slice(from, end + 1);
    const oldStart = hunk.oldStart + before.filter(l => l.kind !== "add").length;
    const newStart = hunk.newStart + before.filter(l => l.kind !== "del").length;
    const header = `@@ -${oldStart},${slice.filter(l => l.kind !== "add").length} ` +
      `+${newStart},${slice.filter(l => l.kind !== "del").length} @@`;
    return [header, ...slice.map(l => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text)].join("\n");
  }
  return null;
}

/**
 * Whether a comment's code still reads the same, at the same lines, in a newer
 * diff: then it stays under its line, as GitHub carries a comment over code
 * that did not change. Otherwise it is outdated.
 */
export function sameCode(
  diffHunk: string, side: "new" | "old", line: number, endLine: number | null, current: DiffLine[],
): boolean {
  const no = numberOn(side);
  const then = new Map<number, string>();
  for (const l of parsePatch(diffHunk).flatMap(h => h.lines)) {
    const n = no(l);
    if (n !== null) then.set(n, l.text);
  }
  const now = new Map<number, string>();
  for (const l of current) {
    const n = no(l);
    if (n !== null) now.set(n, l.text);
  }
  for (let n = line; n <= (endLine ?? line); n++) {
    const text = then.get(n);
    if (text === undefined || now.get(n) !== text) return false;
  }
  return true;
}

/**
 * The hunk as it reads in each file: context + removed lines is a slice of the
 * base, context + added lines a slice of the head. Highlighting each side on
 * its own keeps the grammar on code that existed — the interleaved diff never did.
 */
export function hunkSides(hunk: DiffHunk): { old: string; new: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind !== "add") oldLines.push(line.text);
    if (line.kind !== "del") newLines.push(line.text);
  }
  return { old: oldLines.join("\n"), new: newLines.join("\n") };
}

/**
 * Puts the per-side highlighting back in diff order. Context lines take the
 * head side's tokens; both sides advance on them.
 */
export function alignSides<T>(hunk: DiffHunk, oldSide: readonly T[], newSide: readonly T[]): T[] {
  const out: T[] = [];
  let o = 0;
  let n = 0;
  for (const line of hunk.lines) {
    if (line.kind === "del") { out.push(oldSide[o++]); continue; }
    if (line.kind === "ctx") o++;
    out.push(newSide[n++]);
  }
  return out;
}

/** One row of the side-by-side view: base on the left, head on the right. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pairs a run of removed lines with the run of added lines that replaces it,
 * the way side-by-side diffs read: the n-th removed line faces the n-th added
 * one, and the longer run leaves blanks on the other side.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "ctx") { flush(); rows.push({ left: line, right: line }); continue; }
    if (line.kind === "del") {
      // A removal after additions starts a new change block.
      if (adds.length) flush();
      dels.push(line);
    } else {
      adds.push(line);
    }
  }
  flush();
  return rows;
}

// ── Languages ─────────────────────────────────────────────────────────────────

/** Shiki grammar ids the view knows how to load. */
export type DiffLang =
  | "angular-ts" | "angular-html" | "scss" | "css"
  | "csharp" | "razor" | "xml" | "json" | "jsonc"
  | "python" | "java" | "sql" | "yaml" | "markdown" | "shellscript" | "docker";

const BY_EXTENSION: Record<string, DiffLang> = {
  // The Angular grammars are TypeScript and HTML with Angular's syntax injected,
  // so they read plain TS, JS and HTML just as well.
  ts: "angular-ts", mts: "angular-ts", cts: "angular-ts",
  js: "angular-ts", mjs: "angular-ts", cjs: "angular-ts",
  html: "angular-html", htm: "angular-html",
  scss: "scss", css: "css",
  cs: "csharp", cshtml: "razor", razor: "razor",
  csproj: "xml", props: "xml", targets: "xml", config: "xml", resx: "xml",
  xml: "xml", svg: "xml", xaml: "xml", nuspec: "xml",
  json: "json", jsonc: "jsonc",
  py: "python", java: "java", sql: "sql",
  yml: "yaml", yaml: "yaml", md: "markdown",
  sh: "shellscript", bash: "shellscript",
};

/** Files whose JSON allows comments — strict JSON would flag every one of them. */
const JSONC_NAMES = /^(tsconfig.*|jsconfig.*|\.eslintrc|launch|settings|extensions)\.json$/;

export function languageFor(path: string): DiffLang | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return "docker";
  if (JSONC_NAMES.test(name)) return "jsonc";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

// ── Generated files ───────────────────────────────────────────────────────────

const GENERATED = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|poetry\.lock)$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.Designer\.cs$/,
  /ModelSnapshot\.cs$/,
  /(^|\/)(dist|wwwroot\/dist)\//,
];

/** Lockfiles, bundles, EF migration snapshots: collapsed until asked for. */
export function isGeneratedFile(path: string): boolean {
  return GENERATED.some(re => re.test(path));
}

// ── Reading order ─────────────────────────────────────────────────────────────

export interface FileGroup {
  title: string;
  /** One line on why these come here; AI groups carry the agent's reason. */
  why: string;
  files: string[];
}

const CODE_EXT = /\.(ts|js|mjs|cjs|cs|py|java)$/;

/**
 * Foundations first: what the rest of the change builds on, then the code that
 * uses it, then what proves it. Checked top to bottom, so a service's spec
 * lands in Tests and a component's template in UI.
 */
const LAYERS: { title: string; why: string; test: (path: string, base: string) => boolean }[] = [
  {
    title: "Generated", why: "Lockfiles, bundles, snapshots — skim or skip.",
    test: path => isGeneratedFile(path),
  },
  {
    title: "Tests", why: "Read once you know what they cover.",
    test: (path, base) => /\.(spec|test)\.[jt]s$/.test(base) || /Tests?\.(cs|java)$/.test(base)
      || /^test_.*\.py$|_test\.py$/.test(base) || /(^|\/)(tests?|__tests__|e2e)\//i.test(path),
  },
  {
    title: "Models & contracts", why: "The shapes everything else builds on.",
    test: (path, base) => /\.(model|dto|entity|interface|enum|types?)\.ts$/.test(base)
      || /(Dto|Model|Entity|Request|Response|Enum)\.cs$/.test(base) || /^I[A-Z]\w*\.cs$/.test(base)
      || (CODE_EXT.test(base) && /(^|\/)(models?|dtos?|entities|contracts|interfaces|types|enums)\//i.test(path)),
  },
  {
    title: "Data access", why: "Schema and persistence changes.",
    test: (path, base) => /(^|\/)Migrations\//.test(path) || /(Repository|DbContext)\.cs$/.test(base)
      || /\.repository\.ts$/.test(base) || /\.sql$/.test(base),
  },
  {
    title: "API", why: "Where the logic is exposed: controllers, routes, guards.",
    test: (path, base) => /Controller\.(cs|java)$/.test(base) || /(Endpoints?|Program|Startup)\.cs$/.test(base)
      || /\.(guard|interceptor|resolver|routes)\.ts$/.test(base) || /-routing\.module\.ts$/.test(base)
      || (CODE_EXT.test(base) && /(^|\/)controllers?\//i.test(path)),
  },
  {
    title: "UI", why: "Components with their template and styles.",
    test: (_path, base) => /\.(component|pipe|directive)\.ts$/.test(base)
      || /\.(html|htm|scss|css|cshtml|razor)$/.test(base),
  },
  {
    title: "Logic", why: "Services and the rest of the code.",
    test: (_path, base) => CODE_EXT.test(base),
  },
  {
    title: "Config & other", why: "Settings, project files, docs.",
    test: () => true,
  },
];

/** Display order of the layers above. */
const LAYER_ORDER = ["Models & contracts", "Data access", "Logic", "API", "UI", "Tests", "Config & other", "Generated"];

const EXT_RANK: Record<string, number> = { ts: 0, cs: 0, py: 0, java: 0, js: 0, html: 1, cshtml: 1, razor: 1, scss: 2, css: 2 };

/** Keeps a component's .ts, .html and .scss next to each other. */
function siblingKey(path: string): [string, number, string] {
  const { dir, base } = { dir: path.slice(0, path.lastIndexOf("/") + 1), base: path.slice(path.lastIndexOf("/") + 1) };
  const stem = base.split(".")[0];
  const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase();
  return [`${dir}${stem}`, EXT_RANK[ext] ?? 3, path];
}

function bySibling(a: string, b: string): number {
  const ka = siblingKey(a);
  const kb = siblingKey(b);
  return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
}

/** The order ZuGit suggests without an agent: by layer, foundations first. */
export function layerOrder(paths: string[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const path of paths) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const layer = LAYERS.find(l => l.test(path, base)) ?? LAYERS[LAYERS.length - 1];
    let group = groups.get(layer.title);
    if (!group) groups.set(layer.title, group = { title: layer.title, why: layer.why, files: [] });
    group.files.push(path);
  }
  return LAYER_ORDER
    .map(title => groups.get(title))
    .filter((g): g is FileGroup => !!g)
    .map(g => ({ ...g, files: [...g.files].sort(bySibling) }));
}

/** The agent's groups first; files it left out follow, by layer. */
export function withAgentOrder(agent: FileGroup[], paths: string[]): FileGroup[] {
  const known = new Set(paths);
  const placed = new Set<string>();
  const groups: FileGroup[] = [];
  for (const g of agent) {
    const files = g.files.filter(f => known.has(f) && !placed.has(f));
    files.forEach(f => placed.add(f));
    if (files.length) groups.push({ title: g.title, why: g.why, files });
  }
  const rest = paths.filter(p => !placed.has(p));
  if (rest.length) {
    const flat = layerOrder(rest).flatMap(g => g.files);
    groups.push({ title: "Other files", why: "Not in the agent's order.", files: flat });
  }
  return groups;
}
