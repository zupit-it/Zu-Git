/**
 * Sprint tab state and actions: loading the board, the optimistic writes to
 * Jira (transition, assign, points) with their undo, the personal categories,
 * and the menus the board and the side panel share.
 *
 * Rendering lives in `sprint.ts` and `sprint-panel.ts`; they register with
 * `onRender` and every change here ends with `rerender()`.
 */

import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { avatarColor, escHtml, errorMessage } from "./utils";
import { openExternal } from "./api";
import * as M from "./sprint-model";
import type { PullRequestSummary } from "./shared/pr-model";
import { openMenu, showToast, type MenuEntry } from "./sprint-ui";

export type BoardView = "status" | "person";
export type PanelState =
  | { kind: "issue"; key: string; fromCategory: string | null }
  | { kind: "category"; id: string };

const PREFS = {
  board: "zugit:sprintBoard",
  sprint: "zugit:sprintId",
  view: "zugit:sprintView",
  titles: "zugit:sprintTitles",
  standupOpen: "zugit:sprintStandupOpen",
  panelWidth: "zugit:sprintPanelWidth",
  standupTime: "zugit:sprintStandupTime",
  pinned: "zugit:sprintPinned",
};

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: keyof typeof PREFS, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(PREFS[key]);
    else localStorage.setItem(PREFS[key], value);
  } catch {
    // A preference that does not stick is no reason to fail the action.
  }
}

function numberPref(key: string): number | null {
  const value = Number(readPref(key));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const sp = {
  data: null as M.SprintBoard | null,
  loading: false,
  error: null as string | null,
  loadedAt: 0,
  loadSeq: 0,
  boardId: numberPref(PREFS.board),
  sprintId: numberPref(PREFS.sprint),
  view: (readPref(PREFS.view) === "person" ? "person" : "status") as BoardView,
  titles: readPref(PREFS.titles) === "1",
  /** Account id of the person in focus ("" = unassigned), null = everyone. */
  focusPerson: null as string | null,
  query: "",
  selection: new Set<string>(),
  categories: [] as M.SprintCategory[],
  categoriesLoaded: false,
  panel: null as PanelState | null,
  /** The story pinned for quick access from any section: the topbar switch
   *  shows and hides it. It stays pinned until unpinned or replaced. */
  pinned: readPref(PREFS.pinned),
  /** Category stories that are not in the sprint, read when their panel opens. */
  outside: new Map<string, M.SprintIssue>(),
  standupEvents: null as M.ChangeEvent[] | null,
  standupSince: null as Date | null,
  standupError: null as string | null,
  standupOpen: readPref(PREFS.standupOpen) === "1",
  /** "HH:MM" of the team's standup: the summary covers the time since the
   *  previous working day's one. */
  standupTime: readPref(PREFS.standupTime) ?? M.DEFAULT_STANDUP_TIME,
  /** The board highlights what changed since the standup and dims the rest. */
  diffMode: false,
  /** Side panel width the user dragged to, in px; null = the default. */
  panelWidth: numberPref(PREFS.panelWidth),
  /** Boards of the last successful read: the picker keeps working when a
   *  board then fails to load, so a bad choice is never a dead end. */
  knownBoards: [] as M.BoardRef[],
  /** Keys with a write to Jira in flight. */
  pending: new Set<string>(),
  /** Keys that just moved: highlighted once. */
  flash: new Set<string>(),
  assignable: null as M.JiraPerson[] | null,
};

// ── Render hook ───────────────────────────────────────────────────────────────

const renderers: (() => void)[] = [];

export function onRender(callback: () => void) {
  renderers.push(callback);
}

export function rerender() {
  for (const callback of renderers) callback();
}

// ── Derived data ──────────────────────────────────────────────────────────────

export function allIssues(): M.SprintIssue[] {
  return sp.data?.issues ?? [];
}

export function columns(): M.BoardColumn[] {
  return sp.data?.columns ?? [];
}

export function hidden(): Set<string> {
  return M.hiddenKeys(sp.categories);
}

/** Stories on the board: the sprint minus the ones filed in a category. */
export function boardIssues(): M.SprintIssue[] {
  const off = hidden();
  return allIssues().filter((issue) => !off.has(issue.key));
}

export function issueByKey(key: string): M.SprintIssue | undefined {
  return allIssues().find((issue) => issue.key === key) ?? sp.outside.get(key);
}

export function inSprint(key: string): boolean {
  return allIssues().some((issue) => issue.key === key);
}

export function prs(): PullRequestSummary[] {
  return state.currentDashboard?.prs ?? [];
}

export function prsFor(key: string): PullRequestSummary[] {
  return prs().filter((pr) => pr.jiraKey === key);
}

export function me(): M.JiraPerson | null {
  return sp.data?.me ?? null;
}

export function isMine(issue: M.SprintIssue): boolean {
  const mine = me();
  return !!mine && issue.assignee?.accountId === mine.accountId;
}

export function browseUrl(key: string): string {
  // The board's site once read; the settings' URL when only the panel is in use.
  const site = sp.data?.siteUrl || state.jiraBaseUrl;
  return `${site}/browse/${encodeURIComponent(key)}`;
}

/** Pins the story (replacing the one pinned before), or unpins it. */
export function togglePin(key: string) {
  const before = sp.pinned;
  sp.pinned = before === key ? null : key;
  writePref("pinned", sp.pinned);
  rerender();
  if (before && sp.pinned) {
    showToast(`${key} fissata al posto di ${before}`, {
      action: {
        label: "Annulla",
        run: () => {
          sp.pinned = before;
          writePref("pinned", before);
          rerender();
        },
      },
    });
  }
}

export function openInJira(key: string) {
  void openExternal(browseUrl(key));
}

export function columnName(issue: M.SprintIssue): string {
  const column = columns()[M.columnIndexOf(issue, columns())];
  return column?.name ?? issue.statusName;
}

export function columnCategory(issue: M.SprintIssue): M.ColumnCategory {
  const column = columns()[M.columnIndexOf(issue, columns())];
  if (column) return column.category;
  return issue.statusCategory === "done" ? "done" : issue.statusCategory === "new" ? "new" : "indeterminate";
}

// ── Avatars ───────────────────────────────────────────────────────────────────

/** A Jira face; initials on a coloured disc when there is no picture or it
 *  fails to load (see the `error` listener in `sprint.ts`). */
export function avatar(person: M.JiraPerson | null, size = 20): string {
  if (!person) {
    return `<span class="sp-av sp-av--none" style="--sz:${size}px" aria-hidden="true">?</span>`;
  }
  const initials = escHtml(M.initials(person.displayName));
  const background = avatarColor(person.displayName);
  if (person.avatarUrl) {
    return `<img class="sp-av" style="--sz:${size}px;--avc:${background}" src="${escHtml(person.avatarUrl)}" alt="" data-sp-initials="${initials}" draggable="false">`;
  }
  return `<span class="sp-av" style="--sz:${size}px;--avc:${background}" aria-hidden="true">${initials}</span>`;
}

// ── Icons ─────────────────────────────────────────────────────────────────────

export const ICON = {
  chevron: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`,
  close: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>`,
  search: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="4"/><path d="M9.2 9.2 12 12"/></svg>`,
  external: `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5H2.5v7h7V7M7 2h3v3M5.5 6.5 10 2"/></svg>`,
  more: `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>`,
  back: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.5 4 6l3.5 3.5"/></svg>`,
  up: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5 6 4.5l3 3"/></svg>`,
  down: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5 6 7.5l3-3"/></svg>`,
  columns: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2" width="3" height="10" rx="1"/><rect x="5.5" y="2" width="3" height="7" rx="1"/><rect x="9.5" y="2" width="3" height="4.5" rx="1"/></svg>`,
  rows: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="3.5" r="1.3"/><circle cx="3" cy="10.5" r="1.3"/><path d="M6 3.5h6.5M6 10.5h6.5"/></svg>`,
  titles: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 3.5h10M2 7h10M2 10.5h6"/></svg>`,
  eyeOff: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l10 10"/><path d="M5.6 3.4A6 6 0 0 1 7 3.2c3 0 5 3.8 5 3.8a9.6 9.6 0 0 1-1.6 2M8.4 10.6A6 6 0 0 1 7 10.8C4 10.8 2 7 2 7a9.6 9.6 0 0 1 1.6-2"/></svg>`,
  undo: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2 1.5 4.5 4 7"/><path d="M1.5 4.5H7a3 3 0 0 1 0 6H5"/></svg>`,
  flag: `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 1.5v9.5H1.5V1h7.2l-1 2.5 1 2.5H2.5z"/></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 2v8M2 6h8"/></svg>`,
  pin: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 1.5h4M5.6 1.5v3.8L3.5 7.6v1h7v-1L8.4 5.3V1.5M7 8.6v4"/></svg>`,
  refresh: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7a5 5 0 1 1-1.5-3.5M12 2v3h-3"/></svg>`,
};

// ── Loading ───────────────────────────────────────────────────────────────────

/** Project prefixes seen on PRs: boards to look for when the settings map none. */
function hintKeys(): string[] {
  const keys = new Set<string>();
  for (const pr of prs()) {
    const prefix = pr.jiraBoard || pr.jiraKey?.split("-")[0];
    if (prefix) keys.add(prefix.toUpperCase());
  }
  return [...keys];
}

export async function loadCategories() {
  try {
    const stored = await invoke<{ categories: M.SprintCategory[] }>("sprint_categories_load");
    sp.categories = stored.categories ?? [];
  } catch (error) {
    showToast(errorMessage(error, "Impossibile leggere le categorie."), { tone: "danger" });
  }
  sp.categoriesLoaded = true;
}

export async function loadSprint() {
  const seq = ++sp.loadSeq;
  sp.loading = true;
  // Shows the loading hairline; the board keeps what it has until the answer.
  rerender();
  try {
    const data = await invoke<M.SprintBoard>("sprint_board", {
      boardId: sp.boardId,
      sprintId: sp.sprintId,
      hintKeys: hintKeys(),
    });
    if (seq !== sp.loadSeq) return;
    sp.data = data;
    if (data.boards.length) sp.knownBoards = data.boards;
    sp.error = null;
    sp.loadedAt = Date.now();
    const present = new Set(data.issues.map((issue) => issue.key));
    sp.selection = new Set([...sp.selection].filter((key) => present.has(key)));
    if (data.board) sp.boardId = data.board.id;
    if (data.sprint) sp.sprintId = data.sprint.id;
  } catch (error) {
    if (seq !== sp.loadSeq) return;
    sp.error = errorMessage(error, "Impossibile leggere lo sprint da Jira.");
  }
  sp.loading = false;
  rerender();
  void loadStandup();
}

export function standupClock(): M.Clock {
  return M.parseClock(sp.standupTime) ?? M.parseClock(M.DEFAULT_STANDUP_TIME) ?? { hour: 8, minute: 0 };
}

export function setStandupTime(clock: M.Clock) {
  sp.standupTime = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
  writePref("standupTime", sp.standupTime);
  sp.standupEvents = null;
  sp.standupSince = null;
  rerender();
  void loadStandup();
}

export async function loadStandup() {
  const sprint = sp.data?.sprint;
  if (!sprint) {
    sp.standupEvents = null;
    return;
  }
  const since = M.previousStandup(new Date(), standupClock());
  sp.standupSince = since;
  try {
    sp.standupEvents = await invoke<M.ChangeEvent[]>("sprint_changes", {
      sprintId: sprint.id,
      since: since.toISOString(),
    });
    sp.standupError = null;
  } catch (error) {
    sp.standupEvents = [];
    sp.standupError = errorMessage(error, "Riepilogo non disponibile.");
  }
  rerender();
}

let laterReload: number | null = null;

/** After a write, read the board again a little later: Jira automations may
 *  have moved or reassigned something as a consequence. */
function scheduleQuietReload() {
  if (laterReload !== null) window.clearTimeout(laterReload);
  laterReload = window.setTimeout(() => {
    laterReload = null;
    if (sp.pending.size === 0) void loadSprint();
  }, 6000);
}

export function chooseBoard(boardId: number) {
  sp.boardId = boardId;
  sp.sprintId = null;
  writePref("board", String(boardId));
  writePref("sprint", null);
  sp.data = null;
  void loadSprint();
}

export function chooseSprint(sprintId: number) {
  sp.sprintId = sprintId;
  writePref("sprint", String(sprintId));
  void loadSprint();
}

// ── Transitions ───────────────────────────────────────────────────────────────

const TRANSITIONS_TTL_MS = 60_000;
const transitionCache = new Map<string, { at: number; options: Promise<M.TransitionOption[]> }>();

export function transitionsFor(key: string, fresh = false): Promise<M.TransitionOption[]> {
  const hit = transitionCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TRANSITIONS_TTL_MS) return hit.options;
  const options = invoke<M.TransitionOption[]>("sprint_transitions", { key });
  transitionCache.set(key, { at: Date.now(), options });
  options.catch(() => transitionCache.delete(key));
  return options;
}

// ── Writes with undo ──────────────────────────────────────────────────────────

export interface Change {
  key: string;
  option?: M.TransitionOption;
  /** undefined = leave as is; null = unassign. */
  assignee?: M.JiraPerson | null;
}

interface Snapshot {
  statusId: string;
  statusName: string;
  statusCategory: string;
  assignee: M.JiraPerson | null;
}

function snapshot(issue: M.SprintIssue): Snapshot {
  return {
    statusId: issue.statusId,
    statusName: issue.statusName,
    statusCategory: issue.statusCategory,
    assignee: issue.assignee,
  };
}

function restore(issue: M.SprintIssue, saved: Snapshot, parts: { status: boolean; assignee: boolean }) {
  if (parts.status) {
    issue.statusId = saved.statusId;
    issue.statusName = saved.statusName;
    issue.statusCategory = saved.statusCategory;
  }
  if (parts.assignee) issue.assignee = saved.assignee;
}

function flash(keys: string[]) {
  for (const key of keys) sp.flash.add(key);
  window.setTimeout(() => {
    for (const key of keys) sp.flash.delete(key);
  }, 900);
}

function describe(changes: Change[]): string {
  const first = changes[0];
  const subject = changes.length === 1 ? first.key : `${changes.length} storie`;
  const status = first.option ? first.option.toStatusName : null;
  const sameStatus = changes.every((c) => c.option?.toStatusName === status);
  const assigned = first.assignee !== undefined;
  const who = first.assignee === null ? "nessuno" : first.assignee?.displayName ?? "";
  if (status && sameStatus && assigned) return `${subject} → ${status} · ${who}`;
  if (status && sameStatus) return `${subject} → ${status}`;
  if (assigned) return first.assignee === null ? `${subject} senza assegnatario` : `${subject} assegnat${changes.length === 1 ? "a" : "e"} a ${who}`;
  return `${subject} aggiornate`;
}

/**
 * Applies the changes on the board at once, then writes them to Jira one
 * issue at a time (status first, then assignee). A part Jira refuses is put
 * back. The toast offers undo for whatever went through.
 */
export async function applyChanges(changes: Change[], options: { undo?: boolean } = {}) {
  const work = changes
    .map((change) => ({ change, issue: issueByKey(change.key) }))
    .filter((item): item is { change: Change; issue: M.SprintIssue } => !!item.issue);
  if (work.length === 0) return;

  const saved = new Map(work.map(({ issue }) => [issue.key, snapshot(issue)]));
  for (const { change, issue } of work) {
    if (change.option) {
      issue.statusId = change.option.toStatusId;
      issue.statusName = change.option.toStatusName;
      issue.statusCategory = change.option.toCategory || issue.statusCategory;
    }
    if (change.assignee !== undefined) issue.assignee = change.assignee;
    sp.pending.add(issue.key);
  }
  flash(work.map(({ issue }) => issue.key));
  rerender();

  const errors: string[] = [];
  const done: Change[] = [];
  await Promise.all(
    work.map(async ({ change, issue }) => {
      const before = saved.get(issue.key) ?? snapshot(issue);
      const result: Change = { key: change.key };
      if (change.option) {
        try {
          await invoke("sprint_transition", { key: change.key, transitionId: change.option.id });
          result.option = change.option;
          transitionCache.delete(change.key);
        } catch (error) {
          restore(issue, before, { status: true, assignee: false });
          errors.push(errorMessage(error, `Spostamento di ${change.key} non riuscito.`));
        }
      }
      if (change.assignee !== undefined) {
        try {
          await invoke("sprint_assign", { key: change.key, accountId: change.assignee?.accountId ?? null });
          result.assignee = change.assignee;
        } catch (error) {
          restore(issue, before, { status: false, assignee: true });
          errors.push(errorMessage(error, `Assegnazione di ${change.key} non riuscita.`));
        }
      }
      sp.pending.delete(change.key);
      if (result.option || result.assignee !== undefined) done.push(result);
    }),
  );
  rerender();

  if (errors.length) showToast(errors.join(" · "), { tone: "danger" });
  if (done.length && options.undo !== false) {
    showToast(describe(done), {
      action: { label: "Annulla", run: () => void undoChanges(done, saved) },
    });
  } else if (done.length) {
    showToast("Annullato");
  }
  scheduleQuietReload();
}

/** Puts the issues back where they were. Going back is itself a transition:
 *  when the workflow has none, the toast says so. */
async function undoChanges(done: Change[], saved: Map<string, Snapshot>) {
  const reverse: Change[] = [];
  const stuck: string[] = [];
  for (const change of done) {
    const before = saved.get(change.key);
    if (!before) continue;
    const back: Change = { key: change.key };
    if (change.option) {
      const options = await transitionsFor(change.key, true).catch(() => [] as M.TransitionOption[]);
      const exact = options.find((option) => option.toStatusId === before.statusId && !option.needsInput);
      if (exact) back.option = exact;
      else stuck.push(`${change.key} non può tornare a ${before.statusName} da qui`);
    }
    if (change.assignee !== undefined) back.assignee = before.assignee;
    if (back.option || back.assignee !== undefined) reverse.push(back);
  }
  if (stuck.length) showToast(`${stuck.join(" · ")}: fallo da Jira.`, { tone: "danger" });
  if (reverse.length) await applyChanges(reverse, { undo: false });
}

/** Moves stories into a column, picking the transition when there is one
 *  choice and asking when there are several. */
export async function moveToColumn(
  keys: string[],
  columnIndex: number,
  anchor: DOMRect,
  extra: { assignee?: M.JiraPerson | null } = {},
) {
  const column = columns()[columnIndex];
  if (!column) return;
  const changes: Change[] = [];
  const blocked: string[] = [];
  const needInput: string[] = [];
  const choices: { key: string; options: M.TransitionOption[] }[] = [];

  await Promise.all(
    keys.map(async (key) => {
      const issue = issueByKey(key);
      if (!issue) return;
      if (M.columnIndexOf(issue, columns()) === columnIndex) {
        if (extra.assignee !== undefined) changes.push({ key, assignee: extra.assignee });
        return;
      }
      const options = await transitionsFor(key).catch(() => [] as M.TransitionOption[]);
      const into = M.transitionsInto(options, column);
      const usable = into.filter((option) => !option.needsInput);
      if (into.length === 0) blocked.push(key);
      else if (usable.length === 0) needInput.push(key);
      else choices.push({ key, options: usable });
    }),
  );

  // One story, several statuses in the column: let the user pick.
  if (keys.length === 1 && choices.length === 1 && choices[0].options.length > 1) {
    const { key, options } = choices[0];
    openMenu(anchor, [
      { kind: "title", label: `${key} → ${column.name}` },
      ...options.map((option) => ({
        label: option.toStatusName,
        hint: option.name !== option.toStatusName ? option.name : undefined,
        onSelect: () => void applyChanges([{ key, option, assignee: extra.assignee }]),
      })),
    ]);
    return;
  }
  for (const { key, options } of choices) {
    // The column's first status is where Jira itself would drop it.
    const option = options.find((o) => o.toStatusId === column.statusIds[0]) ?? options[0];
    changes.push({ key, option, assignee: extra.assignee });
  }

  if (blocked.length) {
    showToast(`${blocked.join(", ")}: il workflow non porta in ${column.name} dallo stato attuale.`, { tone: "danger" });
  }
  if (needInput.length) {
    showToast(`${needInput.join(", ")}: la transizione chiede dei campi. Completala in Jira.`, {
      tone: "danger",
      action: needInput.length === 1 ? { label: "Apri in Jira", run: () => openInJira(needInput[0]) } : undefined,
    });
  }
  if (changes.length) await applyChanges(changes);
}

export function assignTo(keys: string[], person: M.JiraPerson | null) {
  const changes = keys
    .filter((key) => (issueByKey(key)?.assignee?.accountId ?? null) !== (person?.accountId ?? null))
    .map((key) => ({ key, assignee: person }));
  if (changes.length) void applyChanges(changes);
}

export async function setPoints(key: string, points: number | null) {
  const issue = issueByKey(key);
  const field = sp.data?.pointsField;
  if (!issue || !field) return;
  const before = issue.points;
  if (before === points) return;
  issue.points = points;
  sp.pending.add(key);
  rerender();
  try {
    await invoke("sprint_set_points", { key, field, points });
    showToast(`${key}: ${points === null ? "stima rimossa" : `${M.formatPoints(points)} pt`}`, {
      action: { label: "Annulla", run: () => void setPoints(key, before) },
    });
  } catch (error) {
    issue.points = before;
    showToast(errorMessage(error, `Impossibile aggiornare i punti di ${key}.`), { tone: "danger" });
  }
  sp.pending.delete(key);
  rerender();
}

// ── Categories ────────────────────────────────────────────────────────────────

async function saveCategories(next: M.SprintCategory[], message?: string, undoTo?: M.SprintCategory[]) {
  const previous = sp.categories;
  sp.categories = next;
  rerender();
  try {
    await invoke("sprint_categories_save", { categories: { categories: next } });
    if (message) {
      showToast(message, undoTo ? { action: { label: "Annulla", run: () => void saveCategories(undoTo) } } : {});
    }
  } catch (error) {
    sp.categories = previous;
    rerender();
    showToast(errorMessage(error, "Impossibile salvare le categorie."), { tone: "danger" });
  }
}

export function categoryById(id: string): M.SprintCategory | undefined {
  return sp.categories.find((category) => category.id === id);
}

/** Takes stories out of a category for good — for those no longer in the
 *  sprint, where "back on the board" would not be true. */
export function dropFromCategory(keys: string[], categoryId: string) {
  if (keys.length === 0) return;
  const previous = sp.categories;
  const name = categoryById(categoryId)?.name ?? "categoria";
  const subject = keys.length === 1 ? `${keys[0]} tolta` : `${keys.length} storie tolte`;
  void saveCategories(M.assignCategory(previous, keys, null), `${subject} da «${name}»`, previous);
}

export function fileInCategory(keys: string[], categoryId: string | null) {
  if (keys.length === 0) return;
  const previous = sp.categories;
  const next = M.assignCategory(previous, keys, categoryId);
  const subject = keys.length === 1 ? keys[0] : `${keys.length} storie`;
  const target = categoryId ? categoryById(categoryId) : null;
  for (const key of keys) sp.selection.delete(key);
  void saveCategories(
    next,
    target ? `${subject} in «${target.name}»` : `${subject} di nuovo sulla board`,
    previous,
  );
}

/** Creates a category (with `keys` already in it) and returns its id. */
export function createCategory(name: string, keys: string[]): string {
  const previous = sp.categories;
  const category: M.SprintCategory = {
    id: `c${Date.now().toString(36)}`,
    name: name.trim(),
    color: M.nextCategoryColor(previous),
    keys: [],
  };
  const next = M.assignCategory([...previous, category], keys, category.id);
  for (const key of keys) sp.selection.delete(key);
  const subject = keys.length === 0 ? "" : keys.length === 1 ? ` con ${keys[0]}` : ` con ${keys.length} storie`;
  void saveCategories(next, `Categoria «${category.name}» creata${subject}`, previous);
  return category.id;
}

export function renameCategory(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  void saveCategories(sp.categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c)));
}

export function recolorCategory(id: string, color: string) {
  void saveCategories(sp.categories.map((c) => (c.id === id ? { ...c, color } : c)));
}

export function deleteCategory(id: string) {
  const previous = sp.categories;
  const category = categoryById(id);
  if (!category) return;
  if (sp.panel?.kind === "category" && sp.panel.id === id) sp.panel = null;
  void saveCategories(
    previous.filter((c) => c.id !== id),
    `Categoria «${category.name}» eliminata: ${category.keys.length === 1 ? "la storia torna" : "le storie tornano"} sulla board`,
    previous,
  );
}

// ── Shared menus ──────────────────────────────────────────────────────────────

function dot(color: string): string {
  return `<span class="sp-dot" style="--dot:${escHtml(color)}"></span>`;
}

export function openCategoryMenu(anchor: HTMLElement | DOMRect, keys: string[], options: { above?: boolean } = {}) {
  const current = keys.length === 1 ? M.categoryOf(keys[0], sp.categories) : null;
  const anyFiled = keys.some((key) => M.categoryOf(key, sp.categories));
  const entries: MenuEntry[] = [
    { kind: "title", label: keys.length === 1 ? `Categoria di ${keys[0]}` : `Categoria di ${keys.length} storie` },
    ...sp.categories.map((category) => ({
      label: category.name,
      lead: dot(category.color),
      checked: current?.id === category.id,
      hint: `${category.keys.length}`,
      onSelect: () => fileInCategory(keys, category.id),
    })),
  ];
  if (anyFiled) {
    entries.push({ label: "Riporta sulla board", onSelect: () => fileInCategory(keys, null) });
  }
  if (sp.categories.length === 0) {
    entries.push({ kind: "note", label: "Le storie in una categoria spariscono dalla board e dai totali; le ritrovi nel suo chip in alto." });
  }
  entries.push(
    { kind: "sep" },
    { kind: "input", placeholder: "Nuova categoria…", submitLabel: "Crea", onSubmit: (name) => createCategory(name, keys) },
  );
  openMenu(anchor, entries, { width: 280, above: options.above });
}

async function loadAssignable(): Promise<M.JiraPerson[]> {
  if (sp.assignable) return sp.assignable;
  const project = sp.data?.board?.projectKey;
  if (!project) return [];
  try {
    sp.assignable = await invoke<M.JiraPerson[]>("sprint_assignable_users", { projectKey: project });
  } catch {
    sp.assignable = [];
  }
  return sp.assignable;
}

export async function openAssignMenu(anchor: HTMLElement | DOMRect, keys: string[], options: { above?: boolean } = {}) {
  if (sp.data && !sp.data.permissions.assign) {
    showToast("Il tuo utente Jira non può assegnare le storie di questo progetto.", { tone: "danger" });
    return;
  }
  const current = keys.length === 1 ? issueByKey(keys[0])?.assignee?.accountId ?? null : undefined;
  const sprintPeople = M.peopleOf(allIssues(), me())
    .map((row) => row.person)
    .filter((person): person is M.JiraPerson => !!person);
  const build = (others: M.JiraPerson[]): MenuEntry[] => {
    const seen = new Set(sprintPeople.map((p) => p.accountId));
    const extra = others.filter((p) => !seen.has(p.accountId));
    const item = (person: M.JiraPerson) => ({
      label: person.displayName + (me()?.accountId === person.accountId ? " (tu)" : ""),
      lead: avatar(person, 18),
      checked: current === person.accountId,
      onSelect: () => assignTo(keys, person),
    });
    return [
      { label: "Non assegnata", lead: avatar(null, 18), checked: current === null, onSelect: () => assignTo(keys, null) },
      ...sprintPeople.map(item),
      ...(extra.length ? [{ kind: "title" as const, label: "Altre persone del progetto" }, ...extra.map(item)] : []),
    ];
  };
  const others = await loadAssignable();
  openMenu(anchor, build(others), { searchable: true, searchPlaceholder: "Cerca persona…", width: 260, above: options.above });
}

export async function openStatusMenu(anchor: HTMLElement | DOMRect, keys: string[], options: { above?: boolean } = {}) {
  if (sp.data && !sp.data.permissions.transition) {
    showToast("Il tuo utente Jira non può cambiare lo stato delle storie di questo progetto.", { tone: "danger" });
    return;
  }
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
  if (keys.length === 1) {
    const key = keys[0];
    let transitions: M.TransitionOption[];
    try {
      transitions = await transitionsFor(key, true);
    } catch (error) {
      showToast(errorMessage(error, `Transizioni di ${key} non disponibili.`), { tone: "danger" });
      return;
    }
    const issue = issueByKey(key);
    const entries: MenuEntry[] = [{ kind: "title", label: `Sposta ${key}` }];
    for (const option of transitions) {
      if (option.toStatusId === issue?.statusId) continue;
      entries.push({
        label: option.toStatusName,
        lead: `<span class="sp-status-dot sp-status-dot--${option.toCategory || "indeterminate"}"></span>`,
        hint: option.needsInput ? "in Jira" : option.name !== option.toStatusName ? option.name : undefined,
        onSelect: () => {
          if (option.needsInput) openInJira(key);
          else void applyChanges([{ key, option }]);
        },
      });
    }
    if (entries.length === 1) entries.push({ kind: "note", label: "Nessuna transizione disponibile da questo stato." });
    openMenu(rect, entries, { width: 240, above: options.above });
    return;
  }
  openMenu(
    rect,
    [
      { kind: "title", label: `Sposta ${keys.length} storie in` },
      ...columns().map((column, index) => ({
        label: column.name,
        lead: `<span class="sp-status-dot sp-status-dot--${column.category}"></span>`,
        onSelect: () => void moveToColumn(keys, index, rect),
      })),
    ],
    { width: 220, above: options.above },
  );
}

// ── The flag's name ──────────────────────────────────────────────────────────
// Jira's flag is shown as information, never as a block. Each board can give
// it the name the team uses ("In test"); kept per board, in this browser.

const FLAG_IN_TEST: M.FlagMeaning = { label: "In test" };
let flagCache: { boardId: number; meaning: M.FlagMeaning } | null = null;

function flagPrefKey(boardId: number): string {
  return `zugit:sprintFlag:${boardId}`;
}

export function flagMeaning(): M.FlagMeaning {
  const boardId = sp.data?.board?.id;
  if (!boardId) return M.DEFAULT_FLAG;
  if (flagCache?.boardId === boardId) return flagCache.meaning;
  let meaning = M.DEFAULT_FLAG;
  try {
    const stored = JSON.parse(readPref(flagPrefKey(boardId)) ?? "null") as { label?: unknown } | null;
    const label = typeof stored?.label === "string" ? stored.label.trim().slice(0, 40) : "";
    if (label) meaning = { label };
  } catch {
    // A preference that does not parse is no preference.
  }
  flagCache = { boardId, meaning };
  return meaning;
}

export function setFlagMeaning(meaning: M.FlagMeaning) {
  const boardId = sp.data?.board?.id;
  if (!boardId) return;
  const next = { label: meaning.label.trim().slice(0, 40) || M.DEFAULT_FLAG.label };
  try {
    localStorage.setItem(flagPrefKey(boardId), JSON.stringify(next));
  } catch {
    // Kept for this session only.
  }
  flagCache = { boardId, meaning: next };
  rerender();
  showToast(`Il flag ora si chiama «${next.label}»`);
}

export function openFlagMenu(anchor: HTMLElement | DOMRect) {
  const current = flagMeaning();
  const board = sp.data?.board?.name;
  const presets = [M.DEFAULT_FLAG, FLAG_IN_TEST];
  const entries: MenuEntry[] = [
    { kind: "title", label: board ? `Nome del flag di Jira su ${board}` : "Nome del flag di Jira" },
    ...presets.map((preset) => ({
      label: preset.label,
      checked: current.label === preset.label,
      onSelect: () => setFlagMeaning(preset),
    })),
  ];
  if (!presets.some((preset) => preset.label === current.label)) {
    entries.push({ label: current.label, checked: true, onSelect: () => setFlagMeaning(current) });
  }
  entries.push(
    { kind: "sep" },
    {
      kind: "input",
      placeholder: "Un altro nome, es. Su staging",
      submitLabel: "Usa",
      onSubmit: (label) => setFlagMeaning({ label }),
    },
    {
      kind: "note",
      label: "Il flag è un'informazione: non segna la storia come bloccata. Il nome vale per te, su questa board.",
    },
  );
  openMenu(anchor, entries, { width: 300 });
}

// ── Comments ──────────────────────────────────────────────────────────────────

export async function addComment(key: string, body: string): Promise<M.IssueComment | null> {
  try {
    return await invoke<M.IssueComment>("sprint_add_comment", { key, body });
  } catch (error) {
    showToast(errorMessage(error, `Commento su ${key} non inviato.`), { tone: "danger" });
    return null;
  }
}
