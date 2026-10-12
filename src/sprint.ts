/**
 * Sprint tab: the active sprint as one compact board — a pill per story with
 * face, key, points and a PR dot — with a per-person view, a standup summary,
 * drag and drop onto columns, people and personal categories, and a side
 * panel with the story's detail.
 *
 * Drag and drop uses pointer events, not HTML5 drag and drop: on Windows the
 * Tauri window intercepts drops for files, and pointer events let the board
 * show which columns the workflow allows while the card is in the air.
 */

import { state } from "./state";
import { escHtml } from "./utils";
import * as M from "./sprint-model";
import { closeMenu, handleMenuKey, menuIsOpen, openMenu, showToast, type MenuEntry } from "./sprint-ui";
import {
  sp, ICON, avatar, onRender, rerender, writePref, boardIssues, columns, issueByKey, isMine, prsFor,
  loadSprint, loadCategories, loadStandup, chooseBoard, chooseSprint, transitionsFor, moveToColumn,
  fileInCategory, categoryById, openCategoryMenu, openAssignMenu, openStatusMenu, openInJira, columnCategory,
  hidden, createCategory, standupClock, setStandupTime, flagMeaning, openFlagMenu,
} from "./sprint-store";
import { applyPanelWidth, closePanel, forgetDetails, initPanelEvents, openCategory, openIssue, renderPanel } from "./sprint-panel";

/** Data older than this is read again when the tab is opened. */
const STALE_MS = 2 * 60_000;

let initialized = false;

// ── Entry points ──────────────────────────────────────────────────────────────

export async function openSprintView() {
  init();
  if (!sp.categoriesLoaded) await loadCategories();
  if (!sp.data || Date.now() - sp.loadedAt > STALE_MS) await loadSprint();
  else render();
  // The PR dots follow the dashboard: show the latest one.
  renderBoard();
}

/** Toolbar Refresh while the tab is open. */
export function refreshSprint() {
  if (!initialized) return;
  forgetDetails();
  void loadSprint();
}

export function focusSprintSearch() {
  const input = document.querySelector<HTMLInputElement>("[data-sp-search]");
  input?.focus();
  input?.select();
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function root(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sprint-root]");
}

function init() {
  if (initialized) return;
  const el = root();
  if (!el) return;
  initialized = true;
  el.innerHTML = `
    <div class="sp-head">
      <div class="sp-head-group">
        <button type="button" class="sp-sprint-pick" data-sp-pick></button>
        <div class="sp-meta" data-sp-meta></div>
        <div class="sp-progress-wrap" data-sp-progress></div>
      </div>
      <div class="sp-head-group sp-head-group--filters">
        <div class="sp-people" data-sp-people></div>
        <label class="sp-search">
          ${ICON.search}
          <input type="search" data-sp-search placeholder="Cerca chiave, titolo, persona" aria-label="Cerca nello sprint" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <div class="sp-head-group sp-head-group--end">
        <div class="sp-cats" data-sp-cats></div>
        <div class="sp-seg" role="group" aria-label="Vista">
          <button type="button" data-sp-view="status" title="Una colonna per stato">${ICON.columns}Stato</button>
          <button type="button" data-sp-view="person" title="Una riga per persona">${ICON.rows}Persone</button>
        </div>
        <button type="button" class="sp-toggle" data-sp-titles title="Mostra i titoli delle storie" aria-label="Titoli" aria-pressed="false">${ICON.titles}</button>
        <button type="button" class="sp-toggle sp-toggle--help" data-sp-legend title="Cosa vogliono dire i simboli" aria-label="Legenda">?</button>
      </div>
      <!-- The PR list's loading hairline, on the head's bottom border. -->
      <div class="list-progress" data-sp-loading hidden role="progressbar" aria-label="Carico lo sprint">
        <span class="sr-only">Carico lo sprint…</span>
      </div>
    </div>
    <div class="sp-main">
      <div class="sp-standup" data-sp-standup hidden></div>
      <div class="sp-scroll" data-sp-scroll><div class="sp-board" data-sp-board></div></div>
      <aside class="sp-panel" data-sp-panel aria-hidden="true" aria-label="Dettaglio"></aside>
    </div>
    <div class="sp-selbar" data-sp-selbar aria-live="polite"></div>`;

  onRender(render);
  applyPanelWidth();
  initPanelEvents(step);
  bindEvents(el);
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  if (!initialized) return;
  renderHead();
  renderStandup();
  renderBoard();
  renderSelbar();
  renderPanel();
}

function renderHead() {
  const el = root();
  if (!el) return;
  const data = sp.data;
  el.querySelector<HTMLElement>("[data-sp-loading]")?.toggleAttribute("hidden", !sp.loading);
  const pick = el.querySelector<HTMLElement>("[data-sp-pick]");
  const meta = el.querySelector<HTMLElement>("[data-sp-meta]");
  const progress = el.querySelector<HTMLElement>("[data-sp-progress]");
  const people = el.querySelector<HTMLElement>("[data-sp-people]");
  const cats = el.querySelector<HTMLElement>("[data-sp-cats]");

  if (pick) {
    pick.innerHTML = data?.board
      ? `<span class="sp-board-key">${escHtml(data.board.projectKey)}</span>
         <span class="sp-sprint-name">${escHtml(data.sprint?.name ?? data.board.name)}</span>
         <span class="sp-chev">${ICON.chevron}</span>`
      : `<span class="sp-sprint-name">${sp.loading ? "Carico lo sprint…" : "Sprint"}</span>`;
    pick.title = data?.sprint?.goal ? `Obiettivo: ${data.sprint.goal}` : data?.board?.name ?? "";
  }

  const clock = M.sprintClock(data?.sprint ?? null, new Date());
  if (meta) {
    const range = data?.sprint?.startDate && data.sprint.endDate ? dateRange(data.sprint.startDate, data.sprint.endDate) : "";
    meta.innerHTML = clock
      ? clock.ended
        ? `<b>Sprint finito</b>`
        : `<b>Giorno ${clock.day}</b> di ${clock.totalDays}`
      : "";
    meta.title = range ? `Sprint dal ${range}` : "";
  }

  const list = boardIssues();
  if (progress) {
    if (!data?.sprint) {
      progress.innerHTML = "";
    } else {
      const pace = M.sprintPace(list, columns(), clock);
      const pct = pace.total ? (pace.done / pace.total) * 100 : 0;
      const expected = clock ? clock.elapsed * 100 : null;
      const behind = expected !== null && pct + 10 < expected;
      // The tick in words: the points a steady pace would have closed by today.
      const expectedPoints = clock && !clock.ended ? Math.round(pace.total * clock.elapsed) : null;
      const paceText =
        pace.needed === null
          ? ""
          : ` Ritmo: ${M.formatPoints(pace.perDay)} pt al giorno finora; per chiudere ne servono ${M.formatPoints(pace.needed)} al giorno.`;
      progress.innerHTML = `
        <div class="sp-bar${behind ? " is-behind" : ""}" title="${escHtml(
          `Verde: ${M.formatPoints(pace.done)} punti chiusi su ${M.formatPoints(pace.total)} (${Math.round(pct)}%).` +
            (expected !== null
              ? ` Tacca: dove saremmo oggi a ritmo costante — è passato il ${Math.round(expected)}% dei giorni lavorativi dello sprint.`
              : "") +
            paceText,
        )}">
          <span class="sp-bar-fill" style="width:${pct.toFixed(1)}%"></span>
          ${expected !== null ? `<span class="sp-bar-tick" style="left:${expected.toFixed(1)}%"></span>` : ""}
        </div>
        <span class="sp-progress-label"><b>${escHtml(M.formatPoints(pace.done))}</b> / ${escHtml(M.formatPoints(pace.total))} pt</span>
        ${expectedPoints !== null
          ? `<span class="sp-progress-exp${behind ? " is-behind" : ""}" title="Punti che un ritmo costante avrebbe chiuso entro oggi: la tacca sulla barra">oggi ~${escHtml(M.formatPoints(expectedPoints))}</span>`
          : ""}`;
    }
  }

  if (people) {
    const rows = M.peopleOf(list, data?.me ?? null);
    people.innerHTML = rows
      .map((row) => {
        const name = row.person ? row.person.displayName : "Non assegnate";
        const open = M.sumPoints(list.filter((i) => (i.assignee?.accountId ?? "") === row.id && !M.isDone(i, columns())));
        const on = sp.focusPerson === row.id;
        return `<button type="button" class="sp-person${on ? " is-on" : ""}" data-sp-person="${escHtml(row.id)}" title="${escHtml(name)} · ${escHtml(M.formatPoints(open))} pt aperti${on ? " · clic per vedere tutti" : ""}" aria-pressed="${on}">${avatar(row.person, 24)}</button>`;
      })
      .join("");
    people.classList.toggle("has-focus", sp.focusPerson !== null);
  }

  if (cats) {
    cats.innerHTML = sp.categories
      .map((category) => {
        const inSprint = category.keys.filter((key) => sp.data?.issues.some((i) => i.key === key)).length;
        const on = sp.panel?.kind === "category" && sp.panel.id === category.id;
        return `<button type="button" class="sp-cat-chip${on ? " is-on" : ""}" data-sp-cat="${escHtml(category.id)}" data-sp-drop="cat:${escHtml(category.id)}"
          title="${escHtml(category.name)}: ${inSprint} nello sprint, ${category.keys.length} in totale. Fuori dalla board e dai totali.">
          <span class="sp-dot" style="--dot:${escHtml(category.color)}"></span>
          <span class="sp-cat-name">${escHtml(category.name)}</span>
          <span class="sp-cat-count">${inSprint}</span>
        </button>`;
      })
      .join("") +
      // Always there, so categories can be found before the first one exists.
      (sp.categories.length
        ? `<button type="button" class="sp-cat-add" data-sp-cat-add title="Categorie: nuova o esistente" aria-label="Categorie">${ICON.plus}</button>`
        : `<button type="button" class="sp-cat-add sp-cat-add--labeled" data-sp-cat-add title="Tieni fuori dalla board le storie che non vuoi vedere, es. le attività ricorrenti">${ICON.eyeOff}<span>Categorie</span></button>`);
  }

  el.querySelectorAll<HTMLElement>("[data-sp-view]").forEach((button) => {
    const on = button.dataset.spView === sp.view;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const titles = el.querySelector<HTMLElement>("[data-sp-titles]");
  titles?.classList.toggle("is-on", sp.titles);
  titles?.setAttribute("aria-pressed", String(sp.titles));
}

function dateRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const day = (d: Date) => d.getDate();
  const month = (d: Date) => d.toLocaleDateString("it-IT", { month: "short" }).replace(".", "");
  return start.getMonth() === end.getMonth()
    ? `${day(start)} al ${day(end)} ${month(end)}`
    : `${day(start)} ${month(start)} al ${day(end)} ${month(end)}`;
}

// ── Standup ───────────────────────────────────────────────────────────────────

/** What changed since the standup, story by story; null while it is read. */
function standupChanges(): Map<string, M.StoryChange> | null {
  const data = sp.data;
  if (!data?.sprint || !sp.standupEvents) return null;
  return M.summarizeChanges(sp.standupEvents, data.issues, data.columns, data.sprint.id, hidden(), flagMeaning());
}



const CHANGE_ICON: Record<M.ChangeKind, string> = {
  closed: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2 5 9l5-6"/></svg>`,
  flagged: ICON.flag,
  movedBack: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6H2.5M5.5 3 2.5 6l3 3"/></svg>`,
  moved: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h7.5M6.5 3l3 3-3 3"/></svg>`,
  added: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 2.5v7M2.5 6h7"/></svg>`,
  assigned: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="4" r="2.1"/><path d="M2.2 10.5a3.9 3.9 0 0 1 7.6 0"/></svg>`,
  estimated: `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 1.8v4.4M3.8 4h4.4M3.8 9.6h4.4"/></svg>`,
};

const DIFF_ICON = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 7S3.8 2.8 7 2.8 12.5 7 12.5 7 10.2 11.2 7 11.2 1.5 7 1.5 7Z"/><circle cx="7" cy="7" r="1.8"/></svg>`;

function openStandupTimeMenu(anchor: HTMLElement) {
  const current = standupClock();
  const presets = ["8:00", "8:30", "9:00", "9:30", "10:00"];
  const entries: MenuEntry[] = [{ kind: "title", label: "Orario dello standup" }];
  for (const text of presets) {
    const clock = M.parseClock(text) ?? current;
    entries.push({
      label: text,
      checked: clock.hour === current.hour && clock.minute === current.minute,
      onSelect: () => setStandupTime(clock),
    });
  }
  entries.push(
    { kind: "sep" },
    {
      kind: "input",
      placeholder: "Altro orario, es. 8:15",
      submitLabel: "Imposta",
      onSubmit: (value) => {
        const clock = M.parseClock(value);
        if (clock) setStandupTime(clock);
        else showToast("Orario non valido: scrivi ad esempio 8:15.", { tone: "danger" });
      },
    },
    { kind: "note", label: "Il riepilogo va dallo standup del giorno lavorativo prima (il lunedì, da venerdì) a oggi. L'orario vale solo per te." },
  );
  openMenu(anchor, entries, { width: 270 });
}

function renderStandup() {
  const el = root()?.querySelector<HTMLElement>("[data-sp-standup]");
  if (!el) return;
  const data = sp.data;
  if (!data?.sprint) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const now = new Date();
  const since = sp.standupSince ?? M.previousStandup(now, standupClock());
  const timeButton = `<button type="button" class="sp-su-time" data-sp-su-time title="Cambia l'orario dello standup">Da ${escHtml(M.standupLabel(since, now))}<span class="sp-chev">${ICON.chevron}</span></button>`;
  if (sp.standupEvents === null) {
    el.innerHTML = `<div class="sp-su-row">${timeButton}<span class="sp-su-muted">leggo cosa è cambiato…</span></div>`;
    return;
  }
  const standup = M.buildStandup({
    events: sp.standupEvents,
    issues: data.issues,
    columns: data.columns,
    sprintId: data.sprint.id,
    hidden: hidden(),
    prs: state.currentDashboard?.prs ?? [],
    now,
    flag: flagMeaning(),
  });
  const flag = flagMeaning();
  const changed = M.standupSectionCount(standup, "changed");
  const attention = M.standupSectionCount(standup, "attention");
  const groupsOf = (section: M.StandupSection) =>
    M.STANDUP_GROUPS.filter((group) => group.section === section && standup[group.id].length);
  // What changed reads as quiet text with a coloured dot; only what is stuck
  // keeps a tinted chip, so the strip does not outshout the board.
  const chips = (section: M.StandupSection) =>
    groupsOf(section)
      .map(
        (group) =>
          `<button type="button" class="sp-su-chip sp-su-chip--${group.tone}${section === "changed" ? " is-quiet" : ""}" data-sp-su-toggle>${standup[group.id].length} ${escHtml(M.groupLabel(group, standup[group.id].length, flag))}</button>`,
      )
      .join("");
  const groupList = (section: M.StandupSection) =>
    groupsOf(section)
      .map(
        (group) => `<div class="sp-su-group">
          <h4 class="sp-su-title sp-su-title--${group.tone}">${escHtml(capitalize(M.groupLabel(group, 2, flag)))}</h4>
          ${standup[group.id]
            .map((item) => {
              const issue = issueByKey(item.key);
              return `<button type="button" class="sp-su-item" data-sp-open-key="${escHtml(item.key)}" title="${escHtml(issue?.summary ?? "")}">
                ${avatar(issue?.assignee ?? null, 16)}<span class="sp-key">${escHtml(item.key)}</span><span class="sp-su-text">${escHtml(item.text)}</span>
              </button>`;
            })
            .join("")}
        </div>`,
      )
      .join("");
  const open = sp.standupOpen && changed + attention > 0;
  el.classList.toggle("is-open", open);
  el.innerHTML = `
    <div class="sp-su-row">
      ${timeButton}
      ${changed ? chips("changed") : `<span class="sp-su-muted">nessun cambiamento${sp.standupError ? ` (${escHtml(sp.standupError)})` : ""}</span>`}
      ${attention ? `<span class="sp-su-sep"></span><span class="sp-su-sub">Da sbloccare</span>${chips("attention")}` : ""}
      <span class="sp-su-end">
      ${changed
        ? `<button type="button" class="sp-su-diff${sp.diffMode ? " is-on" : ""}" data-sp-diff aria-pressed="${sp.diffMode}"
            title="${sp.diffMode ? "Cambiamenti evidenziati sulla board: clic o Esc per tornare alla board normale" : "Evidenzia sulla board le storie cambiate da allora; le altre si attenuano"}">
            ${DIFF_ICON}${sp.diffMode ? "Evidenziati" : "Evidenzia"}</button>`
        : ""}
      ${changed + attention
        ? `<button type="button" class="sp-su-more" data-sp-su-toggle aria-expanded="${open}">${open ? "Chiudi" : "Dettagli"} <span class="sp-chev${open ? " is-up" : ""}">${ICON.chevron}</span></button>`
        : ""}
      </span>
    </div>
    ${open
      ? `<div class="sp-su-body">
          ${changed ? `<section class="sp-su-section"><h3 class="sp-su-section-title">Cosa è cambiato</h3><div class="sp-su-groups">${groupList("changed")}</div></section>` : ""}
          ${attention ? `<section class="sp-su-section"><h3 class="sp-su-section-title">Da sbloccare adesso</h3><div class="sp-su-groups">${groupList("attention")}</div></section>` : ""}
        </div>`
      : ""}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── Board ─────────────────────────────────────────────────────────────────────

function isDim(issue: M.SprintIssue): boolean {
  if (sp.focusPerson !== null && (issue.assignee?.accountId ?? "") !== sp.focusPerson) return true;
  return !!sp.query && !M.matchesQuery(issue, sp.query);
}

interface CardContext {
  now: Date;
  /** What changed since the standup, story by story (null while it is read). */
  changes: Map<string, M.StoryChange> | null;
  /** Changes mode: changed stories carry a badge, the others are dimmed. */
  diff: boolean;
}

function cardContext(): CardContext {
  const changes = standupChanges();
  return { now: new Date(), changes, diff: sp.diffMode && !!changes && changes.size > 0 };
}

function cardHtml(issue: M.SprintIssue, ctx: CardContext, withAvatar = true): string {
  const now = ctx.now;
  const flag = flagMeaning();
  const signal = M.prSignal(prsFor(issue.key), now);
  const change = ctx.diff ? ctx.changes?.get(issue.key) : undefined;
  const classes = ["sp-card"];
  if (isMine(issue)) classes.push("is-mine");
  if (M.isDone(issue, columns())) classes.push("is-done");
  if (sp.selection.has(issue.key)) classes.push("is-selected");
  if (isDim(issue)) classes.push("is-dim");
  if (sp.pending.has(issue.key)) classes.push("is-pending");
  if (sp.flash.has(issue.key)) classes.push("is-flash");
  if (drag?.started && drag.keys.includes(issue.key)) classes.push("is-dragging");
  if (sp.panel?.kind === "issue" && sp.panel.key === issue.key) classes.push("is-open");
  if (ctx.diff) classes.push(change ? `is-changed is-changed--${change.kind}` : "is-unchanged");
  const points =
    issue.points === null
      ? `<span class="sp-pts sp-pts--none" title="Senza stima">–</span>`
      : `<span class="sp-pts">${escHtml(M.formatPoints(issue.points))}</span>`;
  return `<button type="button" class="${classes.join(" ")}" data-sp-card="${escHtml(issue.key)}" aria-label="${escHtml(`${issue.key} ${issue.summary}`)}">
    ${withAvatar ? avatar(issue.assignee, 20) : ""}
    <span class="sp-key">${escHtml(issue.key)}</span>
    <span class="sp-title">${escHtml(issue.summary)}</span>
    ${points}
    ${issue.flagged ? `<span class="sp-flag" title="${escHtml(flag.label)}">${ICON.flag}</span>` : ""}
    ${signal ? `<span class="sp-sig sp-sig--${signal}" title="${escHtml(M.PR_SIGNAL_LABEL[signal])}"></span>` : ""}
    ${change
      ? `<span class="sp-chg sp-chg--${change.kind}">${CHANGE_ICON[change.kind]}<span class="sp-chg-text">${escHtml(change.kinds.map((k) => k.short).join(" · "))}</span></span>`
      : ""}
  </button>`;
}

function renderStatusBoard(list: M.SprintIssue[], ctx: CardContext): string {
  const cols = columns();
  const byColumn = cols.map(() => [] as M.SprintIssue[]);
  for (const issue of list) byColumn[M.columnIndexOf(issue, cols)]?.push(issue);
  return `<div class="sp-cols" style="--cols:${cols.length}">${cols
    .map((column, index) => {
      const items = byColumn[index];
      return `<section class="sp-col sp-col--${column.category}" data-sp-drop="col:${index}">
        <header class="sp-col-head">
          <span class="sp-col-dot"></span>
          <span class="sp-col-name">${escHtml(column.name)}</span>
          <span class="sp-col-count">${items.length}</span>
          <span class="sp-col-pts">${escHtml(M.formatPoints(M.sumPoints(items)))} pt</span>
        </header>
        <div class="sp-col-body">${items.map((issue) => cardHtml(issue, ctx)).join("")}</div>
        <div class="sp-col-blocked">Non raggiungibile dal workflow</div>
      </section>`;
    })
    .join("")}</div>`;
}

function renderPersonBoard(list: M.SprintIssue[], ctx: CardContext): string {
  const cols = columns();
  const rows = M.peopleOf(list, sp.data?.me ?? null);
  const openOf = (id: string) =>
    M.sumPoints(list.filter((i) => (i.assignee?.accountId ?? "") === id && !M.isDone(i, cols)));
  const loads = rows.filter((row) => row.id !== "").map((row) => openOf(row.id));
  const max = Math.max(1, ...loads);
  const average = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;

  const head = `<div class="sp-lane-corner">Persona</div>${cols
    .map((column, index) => {
      const count = list.filter((i) => M.columnIndexOf(i, cols) === index).length;
      return `<div class="sp-lane-head sp-col--${column.category}"><span class="sp-col-dot"></span><span class="sp-col-name">${escHtml(column.name)}</span><span class="sp-col-count">${count}</span></div>`;
    })
    .join("")}`;

  const body = rows
    .map((row) => {
      const items = list.filter((i) => (i.assignee?.accountId ?? "") === row.id);
      const open = openOf(row.id);
      // Unassigned work is nobody's load: its bar stays neutral.
      const level = row.id === "" ? "none" : average > 0 && open > average * 1.4 ? "high" : "ok";
      const dim = sp.focusPerson !== null && sp.focusPerson !== row.id;
      const mine = !!row.person && row.person.accountId === sp.data?.me?.accountId;
      const changedCount = ctx.diff ? items.filter((i) => ctx.changes?.has(i.key)).length : 0;
      return `<div class="sp-lane-person${dim ? " is-dim" : ""}">
          ${avatar(row.person, 26)}
          <div class="sp-lane-info">
            <div class="sp-lane-name">${escHtml(row.person?.displayName ?? "Non assegnate")}${mine ? `<span class="sp-you">tu</span>` : ""}</div>
            <div class="sp-lane-load"><span class="sp-load"><i class="sp-load--${level}" style="width:${((open / max) * 100).toFixed(0)}%"></i></span><span>${escHtml(M.formatPoints(open))} pt aperti</span></div>
            ${ctx.diff ? `<div class="sp-lane-chg${changedCount ? "" : " is-none"}">${changedCount ? `${changedCount} ${changedCount === 1 ? "cambiamento" : "cambiamenti"}` : "nessun cambiamento"}</div>` : ""}
          </div>
        </div>${cols
          .map(
            (_column, index) =>
              `<div class="sp-lane-cell${dim ? " is-dim" : ""}" data-sp-drop="cell:${escHtml(row.id)}:${index}">${items
                .filter((i) => M.columnIndexOf(i, cols) === index)
                .map((issue) => cardHtml(issue, ctx, false))
                .join("")}</div>`,
          )
          .join("")}`;
    })
    .join("");
  return `<div class="sp-lanes" style="--cols:${cols.length}">${head}${body}</div>`;
}

function renderBoard() {
  const el = root()?.querySelector<HTMLElement>("[data-sp-board]");
  if (!el) return;
  // The card under the pointer is about to be replaced: its pointerout never comes.
  hideTip();
  el.classList.toggle("is-titles", sp.titles);
  const data = sp.data;

  if (!data && sp.loading) {
    el.innerHTML = `<div class="sp-cols sp-cols--skeleton" style="--cols:5">${Array.from({ length: 5 }, () => `<section class="sp-col"><div class="sp-skeleton sp-skeleton--short"></div>${`<span class="sp-skel-pill"></span>`.repeat(4)}</section>`).join("")}</div>`;
    return;
  }
  if (sp.error && !data) {
    el.innerHTML = `<div class="sp-state">
      <p class="sp-state-title">Lo sprint non si è caricato</p>
      <p class="sp-state-text">${escHtml(sp.error)}</p>
      <div class="sp-state-actions">
        <button type="button" class="sp-btn" data-sp-retry-load>${ICON.refresh} Riprova</button>
        ${sp.knownBoards.length > 1 ? `<button type="button" class="sp-btn" data-sp-pick-board>Scegli un'altra board</button>` : ""}
      </div>
    </div>`;
    return;
  }
  if (!data) {
    el.innerHTML = "";
    return;
  }
  if (data.notice || !data.sprint) {
    el.innerHTML = `<div class="sp-state">
      <p class="sp-state-title">${data.board ? escHtml(data.board.name) : "Nessuna board"}</p>
      <p class="sp-state-text">${escHtml(data.notice ?? "Nessuno sprint attivo.")}</p>
      ${data.boards.length > 1 ? `<button type="button" class="sp-btn" data-sp-pick-board>Scegli un'altra board</button>` : ""}
    </div>`;
    return;
  }

  const ctx = cardContext();
  const list = boardIssues();
  el.classList.toggle("is-diff", ctx.diff);
  if (list.length === 0) {
    el.innerHTML = `<div class="sp-state">
      <p class="sp-state-title">Lo sprint è vuoto</p>
      <p class="sp-state-text">${data.issues.length ? "Tutte le storie sono in una categoria." : "Nessuna storia nello sprint."}</p>
    </div>`;
    return;
  }
  el.innerHTML = sp.view === "person" ? renderPersonBoard(list, ctx) : renderStatusBoard(list, ctx);
  if (drag?.started) applyDropClasses();
}

function renderSelbar() {
  const el = root()?.querySelector<HTMLElement>("[data-sp-selbar]");
  if (!el) return;
  const count = sp.selection.size;
  el.classList.toggle("is-visible", count > 0);
  if (count === 0) {
    el.innerHTML = "";
    return;
  }
  const points = M.sumPoints([...sp.selection].map(issueByKey).filter((i): i is M.SprintIssue => !!i));
  el.innerHTML = `
    <span class="sp-sel-count">${count} selezionat${count === 1 ? "a" : "e"}<span>${escHtml(M.formatPoints(points))} pt</span></span>
    <span class="sp-sel-sep"></span>
    <button type="button" class="sp-sel-btn" data-sp-sel="category">${ICON.eyeOff}Categoria</button>
    <button type="button" class="sp-sel-btn" data-sp-sel="assign">Assegna</button>
    <button type="button" class="sp-sel-btn" data-sp-sel="status">Stato</button>
    <span class="sp-sel-sep"></span>
    <button type="button" class="sp-sel-x" data-sp-sel="clear" title="Deseleziona (Esc)" aria-label="Deseleziona">${ICON.close}</button>`;
}

/** Board order, for stepping through stories with j / k in the panel. */
function boardOrder(): string[] {
  const list = boardIssues();
  const cols = columns();
  if (sp.view === "person") {
    const rows = M.peopleOf(list, sp.data?.me ?? null);
    return rows.flatMap((row) =>
      cols.flatMap((_c, index) =>
        list.filter((i) => (i.assignee?.accountId ?? "") === row.id && M.columnIndexOf(i, cols) === index).map((i) => i.key),
      ),
    );
  }
  return cols.flatMap((_c, index) => list.filter((i) => M.columnIndexOf(i, cols) === index).map((i) => i.key));
}

function step(delta: number) {
  if (sp.panel?.kind !== "issue") return;
  const order = boardOrder();
  const index = order.indexOf(sp.panel.key);
  if (index < 0 || order.length === 0) return;
  const next = order[(index + delta + order.length) % order.length];
  openIssue(next);
  root()?.querySelector(`[data-sp-card="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ── Drag and drop ─────────────────────────────────────────────────────────────

interface DragState {
  originKey: string;
  keys: string[];
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  additive: boolean;
  ghost: HTMLElement | null;
  over: string | null;
  /** Transitions per dragged key; null while they are read. */
  options: Map<string, M.TransitionOption[]> | null;
}

let drag: DragState | null = null;

type DropState = "target" | "blocked" | "pending" | "source";

function columnState(index: number, d: DragState): DropState {
  const column = columns()[index];
  const moving = d.keys.map(issueByKey).filter((i): i is M.SprintIssue => !!i && M.columnIndexOf(i, columns()) !== index);
  if (moving.length === 0) return "source";
  if (!column || sp.data?.permissions.transition === false) return "blocked";
  if (!d.options) return "pending";
  return moving.every((issue) => M.transitionsInto(d.options?.get(issue.key) ?? [], column).length > 0) ? "target" : "blocked";
}

function dropState(id: string, d: DragState): DropState {
  const [kind, a, b] = id.split(":");
  if (kind === "cat") {
    const category = categoryById(a);
    return category && d.keys.every((key) => category.keys.includes(key)) ? "source" : "target";
  }
  if (kind === "col") return columnState(Number(a), d);
  if (kind === "cell") {
    const columnPart = columnState(Number(b), d);
    const samePerson = d.keys.every((key) => (issueByKey(key)?.assignee?.accountId ?? "") === a);
    const personPart: DropState = samePerson ? "source" : sp.data?.permissions.assign === false ? "blocked" : "target";
    if (columnPart === "blocked" || personPart === "blocked") return "blocked";
    if (columnPart === "pending") return "pending";
    return columnPart === "source" && personPart === "source" ? "source" : "target";
  }
  return "blocked";
}

function applyDropClasses() {
  const d = drag;
  document.querySelectorAll<HTMLElement>("[data-sp-drop]").forEach((el) => {
    el.classList.remove("is-target", "is-blocked", "is-pending", "is-source", "is-over");
    if (!d?.started) return;
    const id = el.dataset.spDrop ?? "";
    const state = dropState(id, d);
    el.classList.add(`is-${state}`);
    if (d.over === id) el.classList.add("is-over");
  });
}

function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-sp-drop]");
  return el?.dataset.spDrop ?? null;
}

function startDrag(d: DragState) {
  d.keys = sp.selection.has(d.originKey) ? [...sp.selection] : [d.originKey];
  hideTip();
  closeMenu();
  // The ghost is drawn before the drag starts: the card left behind fades,
  // the one in the hand does not.
  const origin = issueByKey(d.originKey);
  const ghost = document.createElement("div");
  ghost.className = "sp-ghost";
  ghost.innerHTML = `${origin ? cardHtml(origin, { ...cardContext(), diff: false }) : ""}${d.keys.length > 1 ? `<span class="sp-ghost-count">${d.keys.length}</span>` : ""}`;
  ghost.style.transform = `translate(${d.x + 10}px, ${d.y + 8}px)`;
  document.body.appendChild(ghost);
  d.ghost = ghost;
  d.started = true;
  document.body.classList.add("sp-is-dragging");
  renderBoard();
  applyDropClasses();

  void Promise.all(
    d.keys.map(async (key) => [key, await transitionsFor(key).catch(() => [] as M.TransitionOption[])] as const),
  ).then((entries) => {
    if (drag !== d) return;
    d.options = new Map(entries);
    applyDropClasses();
  });
}

function autoScroll(x: number, y: number) {
  const scroller = root()?.querySelector<HTMLElement>("[data-sp-scroll]");
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  const edge = 48;
  const speed = 14;
  if (y > rect.bottom - edge) scroller.scrollTop += speed;
  else if (y < rect.top + edge && y > rect.top - 20) scroller.scrollTop -= speed;
  if (x > rect.right - edge) scroller.scrollLeft += speed;
  else if (x < rect.left + edge) scroller.scrollLeft -= speed;
}

function onPointerMove(event: PointerEvent) {
  const d = drag;
  if (!d) return;
  d.x = event.clientX;
  d.y = event.clientY;
  if (!d.started) {
    if (Math.hypot(event.clientX - d.startX, event.clientY - d.startY) < 5) return;
    startDrag(d);
  }
  if (d.ghost) d.ghost.style.transform = `translate(${event.clientX + 10}px, ${event.clientY + 8}px)`;
  autoScroll(event.clientX, event.clientY);
  const over = dropTargetAt(event.clientX, event.clientY);
  if (over !== d.over) {
    d.over = over;
    applyDropClasses();
  }
}

function endDrag() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointercancel", onPointerCancel);
  const d = drag;
  drag = null;
  d?.ghost?.remove();
  document.body.classList.remove("sp-is-dragging");
  applyDropClasses();
  return d;
}

function onPointerCancel() {
  if (endDrag()?.started) renderBoard();
}

function onPointerUp() {
  const d = endDrag();
  if (!d) return;
  if (!d.started) {
    clickCard(d.originKey, d.additive);
    return;
  }
  renderBoard();
  const target = d.over;
  if (!target) return;
  const state = dropState(target, d);
  if (state === "source") return;
  if (state === "blocked") {
    showToast(
      sp.data?.permissions.transition === false
        ? "Il tuo utente Jira non può spostare queste storie."
        : "Il workflow non porta lì dallo stato attuale.",
      { tone: "danger" },
    );
    return;
  }
  const [kind, a, b] = target.split(":");
  const anchor = new DOMRect(d.x, d.y, 0, 0);
  if (kind === "cat") {
    fileInCategory(d.keys, a);
    return;
  }
  if (kind === "col") {
    void moveToColumn(d.keys, Number(a), anchor);
    return;
  }
  if (kind === "cell") {
    const person = a === "" ? null : sp.data?.issues.find((i) => i.assignee?.accountId === a)?.assignee ?? null;
    const samePerson = d.keys.every((key) => (issueByKey(key)?.assignee?.accountId ?? "") === a);
    void moveToColumn(d.keys, Number(b), anchor, samePerson ? {} : { assignee: person });
  }
}

function clickCard(key: string, additive: boolean) {
  if (additive) {
    if (sp.selection.has(key)) sp.selection.delete(key);
    else sp.selection.add(key);
    rerender();
    return;
  }
  sp.selection.clear();
  openIssue(key);
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

let tipTimer: number | null = null;
let tipFor: string | null = null;

function tipEl(): HTMLElement {
  let el = document.querySelector<HTMLElement>("[data-sp-tip]");
  if (!el) {
    el = document.createElement("div");
    el.className = "sp-tip";
    el.dataset.spTip = "";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
  }
  return el;
}

function hideTip() {
  if (tipTimer !== null) window.clearTimeout(tipTimer);
  tipTimer = null;
  tipFor = null;
  document.querySelector("[data-sp-tip]")?.classList.remove("is-visible");
}

function scheduleTip(card: HTMLElement) {
  const key = card.dataset.spCard ?? "";
  if (tipFor === key || drag) return;
  hideTip();
  tipFor = key;
  tipTimer = window.setTimeout(() => showTip(card, key), 450);
}

function showTip(card: HTMLElement, key: string) {
  const issue = issueByKey(key);
  if (!issue || drag || !card.isConnected) return;
  const el = tipEl();
  const linked = prsFor(key);
  const signal = M.prSignal(linked, new Date());
  const meta = [issue.issueType, issue.points !== null ? `${M.formatPoints(issue.points)} pt` : "senza stima", issue.epic]
    .filter(Boolean)
    .map((part) => escHtml(String(part)))
    .join(" · ");
  el.innerHTML = `
    <div class="sp-tip-top"><span class="sp-key">${escHtml(issue.key)}</span><span class="sp-status sp-status--${columnCategory(issue)}">${escHtml(issue.statusName)}</span></div>
    <div class="sp-tip-title">${escHtml(issue.summary)}</div>
    <div class="sp-tip-meta">${meta}</div>
    <div class="sp-tip-person">${avatar(issue.assignee, 16)}${escHtml(issue.assignee?.displayName ?? "Non assegnata")}</div>
    ${signal ? `<div class="sp-tip-pr"><span class="sp-sig sp-sig--${signal}"></span>${escHtml(M.PR_SIGNAL_LABEL[signal])}${linked.length > 1 ? ` · ${linked.length} PR` : ""}</div>` : ""}
    ${issue.flagged ? `<div class="sp-tip-flag">${ICON.flag} ${escHtml(flagMeaning().label)}</div>` : ""}
    ${(() => {
      const change = standupChanges()?.get(key);
      if (!change) return "";
      const since = sp.standupSince ?? M.previousStandup(new Date(), standupClock());
      const lines = change.lines.slice(-4);
      return `<div class="sp-tip-changes">
        <div class="sp-tip-changes-title">Da ${escHtml(M.standupLabel(since, new Date()))}</div>
        ${change.lines.length > lines.length ? `<div class="sp-tip-change sp-tip-change--more">…e altri ${change.lines.length - lines.length}</div>` : ""}
        ${lines.map((line) => `<div class="sp-tip-change">${escHtml(line)}</div>`).join("")}
      </div>`;
    })()}`;
  const rect = card.getBoundingClientRect();
  el.classList.add("is-visible");
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

// ── Menus of the head ─────────────────────────────────────────────────────────

function openPickMenu(anchor: HTMLElement) {
  const data = sp.data;
  // Without data (a board that failed) the boards seen before still offer a way out.
  const boards = data?.boards.length ? data.boards : sp.knownBoards;
  const entries: MenuEntry[] = [];
  if (boards.length > 1 || (!data && boards.length)) {
    entries.push({ kind: "title", label: "Board" });
    for (const board of boards) {
      entries.push({
        label: board.name,
        hint: board.projectKey,
        checked: board.id === (data?.board?.id ?? sp.boardId),
        onSelect: () => chooseBoard(board.id),
      });
    }
  }
  if (!data) {
    if (entries.length) openMenu(anchor, entries, { width: 300 });
    return;
  }
  if (data.sprints.length) {
    entries.push({ kind: "title", label: "Sprint attivi" });
    for (const sprint of data.sprints) {
      entries.push({
        label: sprint.name,
        hint: sprint.endDate ? `fine ${new Date(sprint.endDate).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}` : undefined,
        checked: sprint.id === data.sprint?.id,
        onSelect: () => chooseSprint(sprint.id),
      });
    }
  }
  if (data.sprint?.goal) entries.push({ kind: "note", label: `Obiettivo: ${data.sprint.goal}` });
  if (data.board) {
    entries.push(
      { kind: "title", label: "Su questa board" },
      {
        label: "Nome del flag di Jira…",
        hint: flagMeaning().label,
        onSelect: () => openFlagMenu(anchor),
      },
    );
  }
  openMenu(anchor, entries, { width: 300 });
}

function openLegendMenu(anchor: HTMLElement) {
  const dot = (signal: M.PrSignal) => `<span class="sp-sig sp-sig--${signal}"></span>`;
  const entries: MenuEntry[] = [
    { kind: "title", label: "Card" },
    { kind: "legend", lead: avatar(null, 18), label: "Chi la sta facendo; tratteggiata se non è assegnata" },
    { kind: "legend", lead: `<span class="sp-pts">3</span>`, label: "Punti stimati; «–» se manca la stima" },
    { kind: "legend", lead: `<span class="sp-legend-key">PENT</span>`, label: "Chiave viola: la storia è tua" },
    { kind: "legend", lead: `<span class="sp-flag">${ICON.flag}</span>`, label: `Flag di Jira («${flagMeaning().label}»)` },
    { kind: "title", label: "Pallino della pull request" },
    { kind: "legend", lead: dot("approved"), label: "Approvata" },
    { kind: "legend", lead: dot("changes"), label: "Modifiche richieste, o review in attesa da più di 2 giorni" },
    { kind: "legend", lead: dot("ci"), label: "CI fallita" },
    { kind: "legend", lead: dot("review"), label: "In review o in bozza" },
    { kind: "title", label: "Board" },
    { kind: "legend", lead: `<span class="sp-legend-bar"><i></i><b></b></span>`, label: "Verde: punti chiusi. Tacca: dove saremmo oggi a ritmo costante" },
    { kind: "legend", lead: `<span class="sp-legend-hatch"></span>`, label: "Trascinando: colonna che il workflow non raggiunge" },
  ];
  openMenu(anchor, entries, { width: 340 });
}

function openCategoriesMenu(anchor: HTMLElement) {
  const keys = [...sp.selection];
  const entries: MenuEntry[] = [{ kind: "title", label: "Categorie" }];
  for (const category of sp.categories) {
    entries.push({
      label: category.name,
      lead: `<span class="sp-dot" style="--dot:${escHtml(category.color)}"></span>`,
      hint: String(category.keys.length),
      onSelect: () => openCategory(category.id),
    });
  }
  if (sp.categories.length === 0) {
    entries.push({
      kind: "note",
      label: "Le storie in una categoria (es. attività ricorrenti) escono dalla board, dai totali e dal riepilogo; le ritrovi in un elenco, dal chip che compare qui.",
    });
  }
  entries.push({ kind: "sep" });
  if (keys.length) {
    entries.push({ kind: "note", label: `${keys.length === 1 ? "La storia selezionata andrà" : `Le ${keys.length} storie selezionate andranno`} nella nuova categoria.` });
  }
  entries.push({
    kind: "input",
    placeholder: "Nuova categoria…",
    submitLabel: "Crea",
    onSubmit: (name) => openCategory(createCategory(name, keys)),
  });
  openMenu(anchor, entries, { width: 300 });
}

/** Right click on a card: the actions of the selection bar, for one story or
 *  the selection it belongs to. */
function openCardMenu(key: string, x: number, y: number) {
  const keys = sp.selection.has(key) ? [...sp.selection] : [key];
  const anchor = new DOMRect(x, y, 0, 0);
  const single = keys.length === 1;
  const entries: MenuEntry[] = [{ kind: "title", label: single ? key : `${keys.length} storie selezionate` }];
  if (single) entries.push({ label: "Apri il dettaglio", onSelect: () => openIssue(key) });
  entries.push(
    { label: "Cambia stato…", onSelect: () => void openStatusMenu(anchor, keys) },
    { label: "Assegna a…", onSelect: () => void openAssignMenu(anchor, keys) },
    { label: "Metti in una categoria…", onSelect: () => openCategoryMenu(anchor, keys) },
  );
  // The flag's name is a board setting; it is found where a flag is seen.
  if (keys.some((k) => issueByKey(k)?.flagged)) {
    entries.push({ label: "Nome del flag…", hint: flagMeaning().label, onSelect: () => openFlagMenu(anchor) });
  }
  if (single) {
    entries.push(
      { kind: "sep" },
      { label: "Apri in Jira", onSelect: () => openInJira(key) },
      {
        label: "Copia la chiave",
        onSelect: () => void navigator.clipboard?.writeText(key).then(() => showToast(`${key} copiata`)),
      },
    );
  }
  openMenu(anchor, entries, { width: 240 });
}

// ── Events ────────────────────────────────────────────────────────────────────

function bindEvents(el: HTMLElement) {
  el.addEventListener("contextmenu", (event) => {
    const card = (event.target as Element).closest<HTMLElement>("[data-sp-card]");
    if (!card) return;
    event.preventDefault();
    hideTip();
    openCardMenu(card.dataset.spCard ?? "", event.clientX, event.clientY);
  });

  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const card = (event.target as Element).closest<HTMLElement>("[data-sp-card]");
    if (!card || !el.querySelector("[data-sp-board]")?.contains(card)) return;
    event.preventDefault();
    drag = {
      originKey: card.dataset.spCard ?? "",
      keys: [],
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      additive: event.metaKey || event.ctrlKey || event.shiftKey,
      ghost: null,
      over: null,
      options: null,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
  });

  el.addEventListener("click", (event) => {
    const target = event.target as Element;
    const card = target.closest<HTMLElement>("[data-sp-card]");
    if (card) {
      // Mouse clicks are handled on pointerup (they may be drags); a click with
      // no pointer behind it is Enter or Space on a focused card.
      if (event.detail === 0) clickCard(card.dataset.spCard ?? "", event.metaKey || event.ctrlKey || event.shiftKey);
      return;
    }
    if (target.closest("[data-sp-panel]")) return; // the panel has its own handler

    const pick = target.closest<HTMLElement>("[data-sp-pick], [data-sp-pick-board]");
    if (pick) return openPickMenu(pick);
    const person = target.closest<HTMLElement>("[data-sp-person]");
    if (person) {
      const id = person.dataset.spPerson ?? "";
      sp.focusPerson = sp.focusPerson === id ? null : id;
      return rerender();
    }
    const addCategory = target.closest<HTMLElement>("[data-sp-cat-add]");
    if (addCategory) return openCategoriesMenu(addCategory);
    const cat = target.closest<HTMLElement>("[data-sp-cat]");
    if (cat) {
      const id = cat.dataset.spCat ?? "";
      if (sp.panel?.kind === "category" && sp.panel.id === id) return closePanel();
      return openCategory(id);
    }
    const view = target.closest<HTMLElement>("[data-sp-view]");
    if (view) {
      sp.view = view.dataset.spView === "person" ? "person" : "status";
      writePref("view", sp.view);
      return rerender();
    }
    const legend = target.closest<HTMLElement>("[data-sp-legend]");
    if (legend) return openLegendMenu(legend);
    if (target.closest("[data-sp-titles]")) {
      sp.titles = !sp.titles;
      writePref("titles", sp.titles ? "1" : "0");
      return rerender();
    }
    const timeButton = target.closest<HTMLElement>("[data-sp-su-time]");
    if (timeButton) return openStandupTimeMenu(timeButton);
    if (target.closest("[data-sp-diff]")) {
      sp.diffMode = !sp.diffMode;
      return rerender();
    }
    if (target.closest("[data-sp-su-toggle]")) {
      sp.standupOpen = !sp.standupOpen;
      writePref("standupOpen", sp.standupOpen ? "1" : "0");
      return renderStandup();
    }
    const suItem = target.closest<HTMLElement>("[data-sp-open-key]");
    if (suItem) {
      const key = suItem.dataset.spOpenKey ?? "";
      return issueByKey(key) ? openIssue(key) : openInJira(key);
    }
    if (target.closest("[data-sp-retry-load]")) return void loadSprint();

    const sel = target.closest<HTMLElement>("[data-sp-sel]");
    if (sel) {
      const keys = [...sp.selection];
      switch (sel.dataset.spSel) {
        case "category": return openCategoryMenu(sel, keys, { above: true });
        case "assign": return void openAssignMenu(sel, keys, { above: true });
        case "status": return void openStatusMenu(sel, keys, { above: true });
        case "clear":
          sp.selection.clear();
          return rerender();
      }
    }
    // A click on the empty board clears the selection.
    if (target.closest("[data-sp-scroll]") && sp.selection.size) {
      sp.selection.clear();
      rerender();
    }
  });

  el.querySelector<HTMLInputElement>("[data-sp-search]")?.addEventListener("input", (event) => {
    sp.query = (event.currentTarget as HTMLInputElement).value;
    renderBoard();
  });

  el.addEventListener("pointerover", (event) => {
    const card = (event.target as Element).closest<HTMLElement>("[data-sp-card]");
    if (card) scheduleTip(card);
  });
  el.addEventListener("pointerout", (event) => {
    const card = (event.target as Element).closest<HTMLElement>("[data-sp-card]");
    if (card && !card.contains(event.relatedTarget as Node | null)) hideTip();
  });
  el.querySelector("[data-sp-scroll]")?.addEventListener("scroll", hideTip, { passive: true });

  // A Jira avatar that does not load becomes initials (inline handlers are
  // not allowed by the CSP, so this listens for the error on the way down).
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.dataset.spInitials) return;
      const span = document.createElement("span");
      span.className = img.className;
      span.setAttribute("style", img.getAttribute("style") ?? "");
      span.setAttribute("aria-hidden", "true");
      span.textContent = img.dataset.spInitials;
      img.replaceWith(span);
    },
    true,
  );

  document.addEventListener("keydown", onKeyDown);

  // The PR dots and the standup's GitHub half follow the dashboard refresh;
  // the board itself is read again when it is a couple of minutes old.
  window.addEventListener("zugit:dashboard", () => {
    if (state.currentView !== "sprint") return;
    if (Date.now() - sp.loadedAt > STALE_MS && !sp.loading && sp.pending.size === 0) {
      forgetDetails();
      void loadSprint();
    } else {
      render();
    }
  });
  // A new day means a new standup window.
  window.addEventListener("focus", () => {
    if (state.currentView !== "sprint" || !sp.standupSince) return;
    if (M.previousStandup(new Date(), standupClock()).getTime() !== sp.standupSince.getTime()) void loadStandup();
  });
}

function onKeyDown(event: KeyboardEvent) {
  if (state.currentView !== "sprint" || !initialized) return;
  if (menuIsOpen() && handleMenuKey(event)) {
    event.preventDefault();
    return;
  }
  const target = event.target instanceof HTMLElement ? event.target : null;
  const typing = !!target && (target.matches("input, textarea, select") || target.isContentEditable);
  if (event.key === "Escape") {
    if (typing && target?.matches("[data-sp-search]") && sp.query) {
      (target as HTMLInputElement).value = "";
      sp.query = "";
      renderBoard();
      return;
    }
    // Typing a comment: Esc leaves the field (the draft is kept), not the panel.
    if (typing && target && !target.matches("[data-sp-search]")) {
      target.blur();
      return;
    }
    if (drag) {
      endDrag();
      renderBoard();
      return;
    }
    if (sp.selection.size) {
      sp.selection.clear();
      rerender();
      return;
    }
    if (sp.panel) {
      closePanel();
      return;
    }
    if (sp.focusPerson !== null) {
      sp.focusPerson = null;
      rerender();
      return;
    }
    if (sp.diffMode) {
      sp.diffMode = false;
      rerender();
    }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "/") {
    event.preventDefault();
    focusSprintSearch();
    return;
  }
  if (sp.panel?.kind === "issue" && ["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    step(event.key === "j" || event.key === "ArrowDown" ? 1 : -1);
  }
}
