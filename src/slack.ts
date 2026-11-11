// ── Slack nudges ──────────────────────────────────────────────────────────────
// The bell next to a pending reviewer puts a message on the clipboard and opens
// their DM in the Slack app (`slack_open_dm`). Settings → Slack holds who is
// who; an assistant can propose that table through `zugit --mcp`.

import { invoke } from "@tauri-apps/api/core";
import { state } from "./state";
import { renderListBoard, setStatus } from "./render";
import { applyListFilters } from "./filters";
import { registerSectionStatus, syncSettingsSections } from "./settings-sections";
import { escHtml, errorMessage } from "./utils";
import {
  directoryFromRows, nudgeMessage, reviewRows, slackMember,
  type ReviewRow, type SlackDirectory, type SlackProposal,
} from "./slack-people";

interface SlackPeopleState {
  directory: SlackDirectory;
  proposal: SlackProposal | null;
}

const PROMPT = "/mcp__zugit__map_slack_users";

let proposal: SlackProposal | null = null;
let rows: ReviewRow[] = [];
/** Edits not saved yet: a refresh must not wipe them. */
let tableDirty = false;

const card = () => document.querySelector<HTMLElement>("[data-slack-card]");
const one = <T extends HTMLElement = HTMLElement>(selector: string) =>
  card()?.querySelector<T>(selector) ?? null;

function savedDirectory(): SlackDirectory {
  return state.slackDirectory ?? { teamId: "", people: [] };
}

function rerenderList() {
  if (state.currentDashboard) renderListBoard(applyListFilters(state.currentDashboard));
}

/** Reads the table and any waiting proposal; the PR list follows the table. */
export async function loadSlackPeople() {
  let loaded: SlackPeopleState;
  try {
    loaded = await invoke<SlackPeopleState>("slack_people_load");
  } catch {
    return;
  }
  const changed = JSON.stringify(state.slackDirectory) !== JSON.stringify(loaded.directory);
  state.slackDirectory = loaded.directory;
  if (changed) rerenderList();
  if (!tableDirty) {
    proposal = loaded.proposal;
    renderSlackCard();
  }
  syncSettingsSections();
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The tag after a row: where its member id comes from, and what to check. */
function rowTag(row: ReviewRow): { label: string; tone: string } | null {
  if (row.unmatched !== undefined) return { label: "Non trovato", tone: "warn" };
  if (row.change === "changed") return { label: "Cambiato", tone: "warn" };
  if (row.change && row.match === "name") return { label: "Solo nome: controlla", tone: "warn" };
  if (row.change === "new") {
    if (row.match === "email") return { label: "Nuovo · email", tone: "ok" };
    return { label: row.match === "manual" ? "Nuovo · a mano" : "Nuovo", tone: "neutral" };
  }
  if (row.change === "same") return { label: "Confermato", tone: "neutral" };
  if (!row.memberId) return null;
  if (row.match === "email") return { label: "Email", tone: "ok" };
  if (row.match === "name") return { label: "Nome", tone: "neutral" };
  return { label: "A mano", tone: "neutral" };
}

function renderRow(row: ReviewRow, index: number): string {
  const tag = rowTag(row);
  const note = row.unmatched ?? row.note ?? "";
  return `<div class="slack-person" data-slack-row="${index}">
    <span class="slack-person-login" title="${escHtml(row.login)}">${escHtml(row.login)}</span>
    <input form="slack-people" type="text" data-field="slackName" value="${escHtml(row.slackName)}"
           placeholder="Nome su Slack" aria-label="Nome su Slack di ${escHtml(row.login)}" autocomplete="off" />
    <input form="slack-people" type="text" data-field="memberId" value="${escHtml(row.memberId)}"
           placeholder="U…" aria-label="ID membro di ${escHtml(row.login)}" autocomplete="off" spellcheck="false" />
    <span class="slack-person-tag">${tag ? `<span class="token-store-badge token-store-badge-${tag.tone}">${tag.label}</span>` : ""}</span>
    ${note ? `<span class="slack-person-note">${escHtml(note)}</span>` : ""}
  </div>`;
}

function renderSlackCard() {
  const directory = savedDirectory();
  rows = reviewRows(state.currentCollaborators, directory, proposal);

  const team = one<HTMLInputElement>("[data-slack-team-id]");
  if (team) team.value = proposal?.teamId || directory.teamId;
  const teamName = one("[data-slack-team-name]");
  if (teamName) {
    const name = proposal?.teamName ?? directory.teamName;
    teamName.textContent = name ? `Workspace: ${name}` : "Si apre la chat in questo workspace.";
  }

  const banner = one("[data-slack-proposal]");
  if (banner) banner.hidden = !proposal;
  if (proposal) {
    const found = proposal.people.length;
    // Rows typed by hand were checked by whoever typed them; a name match was not.
    const toCheck = proposal.people.filter((p) => p.match === "name").length;
    const meta = one("[data-slack-proposal-meta]");
    if (meta) {
      meta.textContent = [
        `${proposal.source} · ${formatDate(proposal.createdAt)}`,
        `${found} person${found === 1 ? "a" : "e"}`,
        toCheck ? `${toCheck} da controllare` : "",
        proposal.unmatched.length ? `${proposal.unmatched.length} non trovat${proposal.unmatched.length === 1 ? "o" : "i"}` : "",
      ].filter(Boolean).join(" · ");
    }
    const note = one("[data-slack-proposal-note]");
    if (note) {
      note.textContent = proposal.note ?? "";
      note.hidden = !proposal.note;
    }
  }

  const list = one("[data-slack-people]");
  if (list) {
    list.innerHTML = rows.length
      ? rows.map(renderRow).join("")
      : `<p class="field-hint">Nessuna persona: aggiungi i GitHub del team nella card GitHub (<em>Team members</em>) e salva.</p>`;
  }
  const save = one<HTMLButtonElement>("[data-slack-save]");
  if (save) save.textContent = proposal ? "Salva la proposta" : "Salva tabella";
  setSaveStatus(proposal ? "Controlla le righe, poi salva: fino ad allora i solleciti usano la tabella salvata." : "");
}

function setSaveStatus(message: string, tone: "neutral" | "danger" = "neutral") {
  const target = one("[data-slack-save-status]");
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("slack-save-error", tone === "danger");
}

async function saveTable(button: HTMLButtonElement) {
  const team = one<HTMLInputElement>("[data-slack-team-id]")?.value ?? "";
  const teamName = proposal?.teamName ?? state.slackDirectory?.teamName;
  button.disabled = true;
  try {
    const saved = await invoke<SlackDirectory>("slack_people_save", {
      directory: directoryFromRows(team, teamName, rows),
    });
    state.slackDirectory = saved;
    proposal = null;
    tableDirty = false;
    renderSlackCard();
    rerenderList();
    syncSettingsSections();
    const count = saved.people.length;
    setSaveStatus(`Salvata: ${count} person${count === 1 ? "a" : "e"} su Slack.`);
  } catch (error) {
    setSaveStatus(errorMessage(error, "Salvataggio non riuscito."), "danger");
  } finally {
    button.disabled = false;
  }
}

function setShareStatus(message: string, tone: "neutral" | "danger" = "neutral") {
  const target = one("[data-slack-share-status]");
  if (!target) return;
  target.textContent = message;
  target.hidden = !message;
  target.classList.add("slack-share-status");
  target.classList.toggle("slack-save-error", tone === "danger");
}

async function exportTable(button: HTMLButtonElement) {
  button.disabled = true;
  try {
    const path = await invoke<string>("slack_people_export");
    setShareStatus(
      `Salvata in ${path}${tableDirty ? " (la tabella salvata: le modifiche non salvate restano fuori)" : ""}. Mandala ai colleghi.`,
    );
  } catch (error) {
    setShareStatus(errorMessage(error, "Esportazione non riuscita."), "danger");
  } finally {
    button.disabled = false;
  }
}

async function importTable(file: File, button: HTMLButtonElement) {
  button.disabled = true;
  try {
    proposal = await invoke<SlackProposal>("slack_people_import", { content: await file.text(), fileName: file.name });
    // The file is the proposal now: edits left unsaved give way to it.
    tableDirty = false;
    renderSlackCard();
    syncSettingsSections();
    setShareStatus(`Importata da ${file.name}: controlla le righe qui sotto, poi salva.`);
  } catch (error) {
    setShareStatus(errorMessage(error, "Importazione non riuscita."), "danger");
  } finally {
    button.disabled = false;
  }
}

async function discardProposal(button: HTMLButtonElement) {
  button.disabled = true;
  try {
    await invoke("slack_people_discard_proposal");
    proposal = null;
    tableDirty = false;
    renderSlackCard();
    syncSettingsSections();
  } catch (error) {
    setSaveStatus(errorMessage(error, "Impossibile scartare la proposta."), "danger");
  } finally {
    button.disabled = false;
  }
}

function onCardInput(event: Event) {
  // These fields are not settings: the settings form must not see them change.
  event.stopPropagation();
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  tableDirty = true;
  setSaveStatus("Modifiche non salvate.");
  const index = Number(input.closest<HTMLElement>("[data-slack-row]")?.dataset.slackRow);
  const row = rows[index];
  const field = input.dataset.field;
  if (!row || (field !== "memberId" && field !== "slackName")) return;
  row[field] = input.value;
  // A member id typed or corrected by hand is the user's word, not a match.
  if (field === "memberId") {
    row.match = "manual";
    row.change = undefined;
    row.unmatched = undefined;
  }
}

/** Opens the reviewer's Slack DM with the nudge on the clipboard. */
export async function nudgeReviewer(button: HTMLButtonElement) {
  const { nudgeLogin: login, repo, prNumber } = button.dataset;
  const pr = state.currentDashboard?.prs.find((p) => p.repo === repo && String(p.id) === prNumber);
  const person = login ? slackMember(state.slackDirectory, login) : undefined;
  if (!login || !pr || !person) return;

  try {
    await navigator.clipboard.writeText(nudgeMessage(pr, person.slackName));
  } catch {
    setStatus("Copia del messaggio non riuscita: Slack non è stato aperto.", "danger");
    return;
  }
  button.disabled = true;
  try {
    await invoke("slack_open_dm", { login });
    setStatus(`Messaggio per ${escHtml(person.slackName ?? login)} negli appunti: incollalo nella chat Slack e invia.`);
  } catch (error) {
    setStatus(escHtml(errorMessage(error, "Impossibile aprire Slack.")), "danger");
  } finally {
    window.setTimeout(() => (button.disabled = false), 1500);
  }
}

export function initSlack() {
  registerSectionStatus("slack", () => {
    if (proposal) return { label: "Da rivedere", tone: "warn" };
    const count = state.slackDirectory?.people.length ?? 0;
    return count ? { label: `${count} su Slack`, tone: "ok" } : { label: "Off", tone: "neutral" };
  });

  const body = card();
  // Picked outside the settings form: choosing a file is not a setting to save.
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".json,application/json";
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    const button = one<HTMLButtonElement>("[data-slack-import]");
    if (file && button) void importTable(file, button);
  });

  body?.addEventListener("input", onCardInput);
  body?.addEventListener("change", (event) => event.stopPropagation());
  body?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const save = target?.closest<HTMLButtonElement>("[data-slack-save]");
    if (save) { void saveTable(save); return; }
    const discard = target?.closest<HTMLButtonElement>("[data-slack-discard]");
    if (discard) { void discardProposal(discard); return; }
    const exportButton = target?.closest<HTMLButtonElement>("[data-slack-export]");
    if (exportButton) { void exportTable(exportButton); return; }
    if (target?.closest("[data-slack-import]")) { picker.click(); return; }
    const copy = target?.closest<HTMLButtonElement>("[data-slack-copy-prompt]");
    if (copy) {
      void navigator.clipboard.writeText(PROMPT).then(
        () => {
          copy.textContent = "Copiato";
          window.setTimeout(() => (copy.textContent = "Copia"), 1500);
        },
        () => setSaveStatus("Copia non riuscita: seleziona il comando a mano.", "danger"),
      );
    }
  });

  // A proposal arrives while ZuGit runs: look again when the card opens and
  // when the user comes back from the assistant.
  const details = body?.closest("details");
  details?.addEventListener("toggle", () => {
    if (details.open) void loadSlackPeople();
  });
  window.addEventListener("focus", () => void loadSlackPeople());
  void loadSlackPeople();
}
