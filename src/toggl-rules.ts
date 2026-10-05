/**
 * The checks Zupit's Toggl bot runs on every entry each morning (zupit-bot-toggl,
 * `EntryCompliant.GetEntryErrors`), so the planner can flag — and mostly fix —
 * an entry before it is booked instead of after the Slack DM arrives.
 *
 * The order and the early returns mirror the bot: when it stops at an error,
 * so does this, and the user sees exactly what the bot would say. Pure — no DOM
 * or Tauri — so it runs under `node --test`.
 */

/** The bot's own pattern, word boundaries and all — or rather, none: "UTF-8"
 *  counts as a story id for the bot, so it does here too. */
const BOT_ISSUE_ID = /[A-Z][A-Z0-9]{1,7}-\d{1,5}/g;

export const TAG = {
  StandupCheck: "01. Standup e check",
  AnalisiProgettazione: "02. Analisi e progettazione",
  ScritturaReviewStorie: "03. Scrittura o review storie",
  Stime: "04. Stime",
  PairProgramming: "05. Pair Programming",
  SupportoTeam: "06. Supporto al Team",
  CodeReview: "07. Code Review",
  VerificaStorieDemo: "08. Verifica storie o Demo",
  Ownership: "09. Ownership e gestione progetto",
  DevOps: "10. Devops",
  NonLoSo: "11. Non lo so (chiedere PO)",
  DaSistemare: "99. Da sistemare",
} as const;

/** Tags that describe work with no story: next to a story id they are an error. */
const STORYLESS_TAGS: string[] = [
  TAG.StandupCheck,
  TAG.AnalisiProgettazione,
  TAG.ScritturaReviewStorie,
  TAG.Stime,
  TAG.VerificaStorieDemo,
  TAG.Ownership,
  TAG.DevOps,
];

/** Tags the bot accepts on any development entry, story id or not. */
const FREE_TAGS: string[] = [TAG.CodeReview, TAG.SupportoTeam, TAG.DaSistemare];

/** Projects the bot skips after the tag-count check. */
const WHITELISTED_PROJECTS = [181342340];

/** Internal projects treated as client work: ZupitInvoice, ZupitBot, and one more. */
const INTERNAL_PROJECTS = [164881043, 163369680, 195190948];

/** Clients whose "T&M" or "SPIKE" work must be booked on a T&M project. */
const TIME_MATERIAL_CLIENTS = ["promoservice parma", "pulinet", "asg srl", "provisus - scadenzario"];
const TIME_MATERIAL_KEYWORDS = ["t&m", "spike"];

export interface RuleProject {
  id: number;
  name: string;
  clientName?: string | null;
}

export interface RuleEntry {
  description: string;
  projectId: number | null;
  tags: string[];
  billable: boolean;
}

export interface RuleContext {
  projects: RuleProject[];
  /** Tag names in the workspace — a fix never sets one that does not exist. */
  tags: string[];
  /** The project a Jira key prefix is usually booked on, from Toggl history. */
  projectForPrefix: (prefix: string) => number | null;
  /** A Jira story's summary, when ZuGit knows it. */
  summaryOf: (key: string) => string | null;
}

export type RuleAction =
  | { kind: "patch"; label: string; patch: Partial<RuleEntry> }
  /** One entry per story, time shared equally — the planner does the maths. */
  | { kind: "split"; label: string; descriptions: string[] };

export interface RuleIssue {
  code: string;
  /** "bot": the bot reports it and it costs score. "advice": the bot lets it
   *  through, but it is likely wrong or skews the per-story numbers. */
  severity: "bot" | "advice";
  /** The emoji the bot prefixes the Slack line with. */
  emoji: string;
  message: string;
  /** Possible fixes, safest first. "Apply suggestions" takes the first patch
   *  of every bot issue; the rest are one click each. */
  actions: RuleAction[];
}

/** Distinct story ids in a description, in order, the way the bot reads them. */
export function storyIds(description: string): string[] {
  return [...new Set(description.match(BOT_ISSUE_ID) ?? [])];
}

/** The description with the story ids taken out and the separators they leave
 *  behind ("PENT-1 / PENT-2 — analisi" → "analisi"). */
export function withoutStoryIds(description: string): string {
  return description
    .replace(BOT_ISSUE_ID, " ")
    .replace(/^[\s/,;:|+&—–-]+/, "")
    .replace(/(\s*[/,;|+&]\s*)+(?=\s[—–-]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The bot's "only an id" test: strip each id with one trailing separator. */
function onlyStoryIds(description: string): boolean {
  return description.replace(/[A-Z][A-Z0-9]{1,7}-\d{1,5}[ ,:/._]?/g, "").trim() === "";
}

function isDevelopment(project: RuleProject | undefined, projectId: number): boolean {
  if (INTERNAL_PROJECTS.includes(projectId)) return true;
  const client = project?.clientName?.trim();
  if (!client) return false;
  return !client.startsWith("Zupit");
}

const patch = (label: string, change: Partial<RuleEntry>): RuleAction => ({ kind: "patch", label, patch: change });

/** What the bot would report for this entry, plus ZuGit's own advice. */
export function checkEntry(entry: RuleEntry, context: RuleContext): RuleIssue[] {
  const issues = botIssues(entry, context);
  const ids = storyIds(entry.description);
  if (ids.length > 1) issues.push(manyStories(entry, context, ids));
  return issues;
}

function botIssues(entry: RuleEntry, context: RuleContext): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const description = entry.description.trim();
  const ids = storyIds(description);
  const hasId = ids.length > 0;

  if (entry.projectId === null) {
    const learned = hasId ? context.projectForPrefix(ids[0].split("-")[0]) : null;
    const name = context.projects.find((project) => project.id === learned)?.name;
    issues.push({
      code: "missing-project",
      severity: "bot",
      emoji: "👷",
      message: "Il progetto è obbligatorio.",
      actions: learned !== null && name ? [patch(`Usa «${name}»`, { projectId: learned })] : [],
    });
    return issues;
  }

  if (!description) {
    issues.push({ code: "empty-description", severity: "bot", emoji: "👔", message: "La descrizione non può essere vuota.", actions: [] });
    return issues;
  }
  if (hasId && onlyStoryIds(description)) {
    const summary = context.summaryOf(ids[0]);
    issues.push({
      code: "id-only",
      severity: "bot",
      emoji: "👔",
      message: "Solo la chiave non basta: scrivi cosa hai fatto.",
      actions: summary ? [patch("Aggiungi il titolo della storia", { description: `${ids[0]} ${summary}` })] : [],
    });
  }

  if (entry.tags.length > 1) {
    issues.push({
      code: "too-many-tags",
      severity: "bot",
      emoji: "🦉",
      message: "Al massimo un tag.",
      actions: [patch(`Tieni solo #${entry.tags[0]}`, { tags: entry.tags.slice(0, 1) })],
    });
    return issues;
  }

  const projectId = entry.projectId;
  if (WHITELISTED_PROJECTS.includes(projectId)) return issues;
  const tag = entry.tags[0] ?? null;
  if (tag === TAG.NonLoSo) return issues;

  const project = context.projects.find((candidate) => candidate.id === projectId);

  if (!isDevelopment(project, projectId)) {
    if (entry.billable) {
      issues.push({
        code: "zupit-billable",
        severity: "bot",
        emoji: "0️⃣",
        message: "Le entry Zupit sono non billable.",
        actions: [patch("Rendi non billable", { billable: false })],
      });
    }
    if (tag) {
      issues.push({
        code: "zupit-tag",
        severity: "bot",
        emoji: "🟦",
        message: "Niente tag sulle entry Zupit.",
        actions: [patch("Togli il tag", { tags: [] })],
      });
    }
    return issues;
  }

  if (!entry.billable) {
    issues.push({
      code: "must-be-billable",
      severity: "bot",
      emoji: "💰",
      message: "Le entry di progetto sono billable.",
      actions: [patch("Rendi billable", { billable: true })],
    });
  }

  if (tag) {
    if (FREE_TAGS.includes(tag)) return issues;
    if (tag === TAG.PairProgramming && !hasId) {
      issues.push({
        code: "pair-needs-story",
        severity: "bot",
        emoji: "🟢",
        message: "Pair programming: metti la chiave della storia.",
        actions: [],
      });
    } else if (STORYLESS_TAGS.includes(tag) && hasId) {
      issues.push({
        code: "tag-with-story",
        severity: "bot",
        emoji: "🚫",
        message: `Con la chiave della storia il tag #${tag} non va messo.`,
        actions: [patch("Togli il tag", { tags: [] })],
      });
    }
  } else if (!hasId) {
    issues.push({
      code: "tag-or-story",
      severity: "bot",
      emoji: "🏷️",
      message: "Serve la chiave della storia oppure un tag.",
      actions: [],
    });
  }

  if (hasId) {
    // The bot matches the key against the Jira project named like the Toggl
    // one; ZuGit has no such list, but history knows where each prefix goes.
    const prefix = ids[0].split("-")[0];
    const usual = context.projectForPrefix(prefix);
    const usualName = context.projects.find((candidate) => candidate.id === usual)?.name;
    if (usual !== null && usual !== projectId && usualName) {
      issues.push({
        code: "project-key",
        severity: "advice",
        emoji: "🔀",
        message: `Le storie ${prefix} di solito vanno su «${usualName}»: il bot controlla che la chiave corrisponda al progetto.`,
        actions: [patch(`Sposta su «${usualName}»`, { projectId: usual })],
      });
    }

    const client = project?.clientName?.trim().toLowerCase() ?? "";
    const lower = description.toLowerCase();
    if (
      project &&
      TIME_MATERIAL_CLIENTS.includes(client) &&
      TIME_MATERIAL_KEYWORDS.some((keyword) => lower.includes(keyword)) &&
      !project.name.toLowerCase().includes("t&m")
    ) {
      const timeMaterial = context.projects.filter(
        (candidate) =>
          candidate.clientName?.trim().toLowerCase() === client && candidate.name.toLowerCase().includes("t&m"),
      );
      issues.push({
        code: "time-material",
        severity: "bot",
        emoji: "🧱",
        message: "“T&M” e “SPIKE” vanno su un progetto T&M di questo cliente.",
        actions: timeMaterial.length === 1 ? [patch(`Sposta su «${timeMaterial[0].name}»`, { projectId: timeMaterial[0].id })] : [],
      });
    }
  }

  return issues;
}

/**
 * Several stories in one entry. The bot lets it through, but reads only the
 * first key — for the project check and for pairing — so the time looks spent
 * on that story alone.
 */
function manyStories(entry: RuleEntry, context: RuleContext, ids: string[]): RuleIssue {
  const rest = withoutStoryIds(entry.description);
  const actions: RuleAction[] = [
    {
      kind: "split",
      label: `Dividi in ${ids.length}`,
      descriptions: ids.map((id) => `${id} ${context.summaryOf(id) ?? rest}`.trim()),
    },
  ];
  // Sprint-wide work (planning, analysis) belongs to no single story: no keys,
  // and the tag that says what it was.
  if (rest && context.tags.includes(TAG.AnalisiProgettazione)) {
    const description = rest.charAt(0).toUpperCase() + rest.slice(1);
    actions.push(patch("Lavoro di sprint: togli le chiavi, tag 02", { description, tags: [TAG.AnalisiProgettazione] }));
  }
  return {
    code: "many-stories",
    severity: "advice",
    emoji: "🧩",
    message: `${ids.length} storie in una entry: il bot legge solo ${ids[0]}. Una storia per entry, oppure nessuna chiave e un tag se è lavoro di sprint.`,
    actions,
  };
}

/**
 * The entry with every bot issue fixed where a fix exists. Repeated, since a
 * fix can uncover the next check (a second tag dropped, then the remaining one
 * found next to a story id).
 */
export function fixEntry(entry: RuleEntry, context: RuleContext): { entry: RuleEntry; fixed: number } {
  let current = { ...entry, tags: [...entry.tags] };
  let fixed = 0;
  for (let round = 0; round < 5; round += 1) {
    const action = botIssues(current, context)
      .filter((issue) => issue.severity === "bot")
      .map((issue) => issue.actions.find((candidate) => candidate.kind === "patch"))
      .find((candidate): candidate is Extract<RuleAction, { kind: "patch" }> => candidate !== undefined);
    if (!action) break;
    const next = { ...current, ...action.patch };
    if (JSON.stringify(next) === JSON.stringify(current)) break;
    current = next;
    fixed += 1;
  }
  return { entry: current, fixed };
}

/** Bot issues that "Apply suggestions" can fix. */
export function fixableCount(issues: RuleIssue[]): number {
  return issues.filter((issue) => issue.severity === "bot" && issue.actions.some((action) => action.kind === "patch")).length;
}
