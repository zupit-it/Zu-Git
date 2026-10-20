/**
 * The story panel beyond the Sprint tab, and the pinned story.
 *
 * The panel is one element that moves: in the Sprint tab it lies over the
 * board, as it always did; in the other views it docks on the right and the
 * content makes room for it. A story opens there from its key in the PR list.
 *
 * One story can be pinned (from the panel). The switch in the topbar shows and
 * hides it from any view: it reads "on" only while the pinned story is the one
 * on screen, so opening another story turns it off, and turning it back on
 * returns to the pinned one. Changing view keeps the pinned story on screen and
 * closes anything else — what follows the user around is only what they chose.
 */

import { state } from "./state";
import { handleMenuKey, menuIsOpen } from "./sprint-ui";
import { sp, issueByKey, onRender } from "./sprint-store";
import { applyPanelWidth, closePanel, initPanelEvents, openIssue, renderPanel } from "./sprint-panel";

let panelEl: HTMLElement | null = null;

export function mountStoryDock() {
  if (panelEl) return;
  panelEl = document.createElement("aside");
  panelEl.className = "sp-panel";
  panelEl.dataset.spPanel = "";
  panelEl.setAttribute("aria-hidden", "true");
  panelEl.setAttribute("aria-label", "Dettaglio");
  placePanel();
  applyPanelWidth();
  initPanelEvents();
  onRender(() => {
    renderPanel();
    renderPinSwitch();
  });

  document.querySelector("[data-pin-switch]")?.addEventListener("click", togglePinned);

  window.addEventListener("zugit:view", () => {
    const panel = sp.panel;
    if (panel && !(panel.kind === "issue" && panel.key === sp.pinned)) closePanel();
    placePanel();
    // The ↑/↓ buttons belong to the board's view only.
    renderPanel();
  });
  // The open story's PRs follow the dashboard.
  window.addEventListener("zugit:dashboard", () => {
    if (sp.panel) renderPanel();
  });
  window.addEventListener("zugit:settings", renderPinSwitch);
  document.addEventListener("keydown", onKeyDown);

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

  renderPinSwitch();
}

/** Opens a story in the panel, wherever the user is. */
export function openStory(key: string) {
  openIssue(key);
}

/** Puts the panel where the current view wants it: over the board in the
 *  Sprint tab (once the tab has built its frame), docked everywhere else. */
export function placePanel() {
  if (!panelEl) return;
  const slot =
    (state.currentView === "sprint" ? document.querySelector("[data-sp-main]") : null) ??
    document.querySelector("[data-app-body]");
  if (!slot || panelEl.parentElement === slot) return;
  slot.appendChild(panelEl);
  renderPanel();
}

function pinnedOnScreen(): boolean {
  return sp.panel?.kind === "issue" && sp.panel.key === sp.pinned;
}

function togglePinned() {
  const key = sp.pinned;
  if (!key) return;
  if (pinnedOnScreen()) closePanel();
  else openIssue(key);
}

function renderPinSwitch() {
  const el = document.querySelector<HTMLButtonElement>("[data-pin-switch]");
  if (!el) return;
  const key = sp.pinned;
  el.hidden = !key || !state.jiraReady;
  if (!key) return;
  const on = pinnedOnScreen();
  el.classList.toggle("is-on", on);
  el.setAttribute("aria-checked", String(on));
  const label = el.querySelector<HTMLElement>("[data-pin-switch-key]");
  if (label) label.textContent = key;
  const summary = issueByKey(key)?.summary;
  el.title = `${on ? "Nascondi" : "Mostra"} la storia fissata · ${key}${summary ? ` — ${summary}` : ""}`;
  el.setAttribute("aria-label", `Storia fissata ${key}`);
}

/** Outside the Sprint tab (which has its own keys): the panel's menus, and
 *  Esc to hide it — only when nothing else on the page had the focus. */
function onKeyDown(event: KeyboardEvent) {
  if (state.currentView === "sprint" || !sp.panel) return;
  if (menuIsOpen() && handleMenuKey(event)) {
    event.preventDefault();
    return;
  }
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target && target !== document.body && !panelEl?.contains(target)) return;
  // Typing a comment: Esc leaves the field (the draft is kept), not the panel.
  if (target?.matches("input, textarea, select") || target?.isContentEditable) {
    target.blur();
    return;
  }
  closePanel();
}
