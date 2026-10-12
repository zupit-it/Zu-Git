/**
 * Small UI primitives for the Sprint tab: a popover menu (with optional
 * search, an inline text field, colour swatches) and toasts with an action.
 * One menu at a time; it closes on Esc, on an outside click and on scroll.
 */

import { escHtml } from "./utils";

/** The modifier key as people read it: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD_KEY = navigator.platform.toUpperCase().includes("MAC") ? "⌘" : "Ctrl";

export interface MenuItem {
  kind?: "item";
  label: string;
  /** Raw HTML placed before the label (avatar, dot, icon). */
  lead?: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  /** Extra words the search matches besides the label. */
  keywords?: string;
  onSelect: () => void;
}

export type MenuEntry =
  | MenuItem
  | { kind: "sep" }
  | { kind: "title"; label: string }
  | { kind: "note"; label: string }
  /** A non-interactive row: a sample (HTML) and what it means. */
  | { kind: "legend"; lead: string; label: string }
  | { kind: "input"; placeholder: string; value?: string; submitLabel: string; onSubmit: (value: string) => void }
  | { kind: "swatches"; colors: string[]; selected?: string; onSelect: (color: string) => void };

export interface MenuOptions {
  searchable?: boolean;
  searchPlaceholder?: string;
  width?: number;
  /** Open above the anchor (for the selection bar at the bottom). */
  above?: boolean;
  /** Called once the menu is gone, however it closed. */
  onClose?: () => void;
}

interface OpenMenu {
  el: HTMLElement;
  entries: MenuEntry[];
  active: number;
  query: string;
  options: MenuOptions;
}

let current: OpenMenu | null = null;

function isItem(entry: MenuEntry): entry is MenuItem {
  return entry.kind === undefined || entry.kind === "item";
}

function visibleItems(menu: OpenMenu): MenuItem[] {
  const q = menu.query.trim().toLowerCase();
  return menu.entries.filter(isItem).filter((item) => {
    if (!q) return true;
    return `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(q);
  });
}

const CHECK = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.2L5 9l5-6"/></svg>`;

function renderMenu(menu: OpenMenu) {
  const q = menu.query.trim();
  const items = visibleItems(menu);
  // The check column only where something can be checked: no empty gutter.
  const hasChecks = menu.entries.some((entry) => isItem(entry) && entry.checked !== undefined);
  menu.el.classList.toggle("sp-menu--plain", !hasChecks);
  let itemIndex = 0;
  const parts: string[] = [];
  if (menu.options.searchable) {
    parts.push(
      `<div class="sp-menu-search"><input type="text" data-sp-menu-search placeholder="${escHtml(menu.options.searchPlaceholder ?? "Cerca…")}" value="${escHtml(menu.query)}" autocomplete="off" spellcheck="false"></div>`,
    );
  }
  for (const entry of menu.entries) {
    if (isItem(entry)) {
      if (!items.includes(entry)) continue;
      const index = itemIndex++;
      parts.push(
        `<button type="button" class="sp-mi${index === menu.active ? " is-active" : ""}${entry.danger ? " sp-mi--danger" : ""}" data-sp-mi="${index}"${entry.disabled ? " disabled" : ""}>
          ${hasChecks ? `<span class="sp-mi-check">${entry.checked ? CHECK : ""}</span>` : ""}
          ${entry.lead ?? ""}
          <span class="sp-mi-label">${escHtml(entry.label)}</span>
          ${entry.hint ? `<span class="sp-mi-hint">${escHtml(entry.hint)}</span>` : ""}
        </button>`,
      );
      continue;
    }
    // While searching, only matching items are shown.
    if (q) continue;
    switch (entry.kind) {
      case "sep":
        parts.push(`<div class="sp-menu-sep"></div>`);
        break;
      case "title":
        parts.push(`<div class="sp-menu-title">${escHtml(entry.label)}</div>`);
        break;
      case "note":
        parts.push(`<div class="sp-menu-note">${escHtml(entry.label)}</div>`);
        break;
      case "legend":
        parts.push(`<div class="sp-menu-legend"><span class="sp-menu-legend-lead">${entry.lead}</span><span>${escHtml(entry.label)}</span></div>`);
        break;
      case "input":
        parts.push(
          `<form class="sp-menu-form" data-sp-menu-form>
            <input type="text" data-sp-menu-input placeholder="${escHtml(entry.placeholder)}" value="${escHtml(entry.value ?? "")}" autocomplete="off" spellcheck="false">
            <button type="submit" class="sp-menu-submit">${escHtml(entry.submitLabel)}</button>
          </form>`,
        );
        break;
      case "swatches":
        parts.push(
          `<div class="sp-menu-swatches">${entry.colors
            .map(
              (color) =>
                `<button type="button" class="sp-swatch${color === entry.selected ? " is-on" : ""}" data-sp-swatch="${escHtml(color)}" style="--sw:${escHtml(color)}" aria-label="Colore ${escHtml(color)}"></button>`,
            )
            .join("")}</div>`,
        );
        break;
    }
  }
  if (q && items.length === 0) parts.push(`<div class="sp-menu-note">Nessun risultato</div>`);
  menu.el.innerHTML = parts.join("");
}

function position(menu: OpenMenu, anchor: HTMLElement | DOMRect) {
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
  const el = menu.el;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const margin = 8;
  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, rect.right - width);
  let top = menu.options.above ? rect.top - height - 6 : rect.bottom + 6;
  if (!menu.options.above && top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 6);
  if (menu.options.above && top < margin) top = rect.bottom + 6;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function select(menu: OpenMenu, index: number) {
  const item = visibleItems(menu)[index];
  if (!item || item.disabled) return;
  closeMenu();
  item.onSelect();
}

export function openMenu(anchor: HTMLElement | DOMRect, entries: MenuEntry[], options: MenuOptions = {}) {
  closeMenu();
  const el = document.createElement("div");
  el.className = "sp-menu";
  el.setAttribute("role", "menu");
  if (options.width) el.style.width = `${options.width}px`;
  document.body.appendChild(el);
  const firstEnabled = Math.max(0, entries.filter(isItem).findIndex((item) => !item.disabled));
  const menu: OpenMenu = { el, entries, active: options.searchable ? 0 : firstEnabled, query: "", options };
  current = menu;
  renderMenu(menu);
  position(menu, anchor);

  el.addEventListener("click", (event) => {
    const target = event.target as Element;
    const item = target.closest<HTMLElement>("[data-sp-mi]");
    if (item) {
      select(menu, Number(item.dataset.spMi));
      return;
    }
    const swatch = target.closest<HTMLElement>("[data-sp-swatch]");
    if (swatch) {
      const entry = menu.entries.find((e) => e.kind === "swatches");
      closeMenu();
      if (entry?.kind === "swatches") entry.onSelect(swatch.dataset.spSwatch ?? "");
    }
  });
  el.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = el.querySelector<HTMLInputElement>("[data-sp-menu-input]");
    const entry = menu.entries.find((e) => e.kind === "input");
    const value = input?.value.trim() ?? "";
    if (!value || entry?.kind !== "input") {
      input?.focus();
      return;
    }
    closeMenu();
    entry.onSubmit(value);
  });
  el.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.matches("[data-sp-menu-search]")) return;
    menu.query = target.value;
    menu.active = 0;
    renderMenu(menu);
    const search = el.querySelector<HTMLInputElement>("[data-sp-menu-search]");
    search?.focus();
    search?.setSelectionRange(search.value.length, search.value.length);
  });
  el.addEventListener("mousemove", (event) => {
    const item = (event.target as Element).closest<HTMLElement>("[data-sp-mi]");
    if (!item) return;
    const index = Number(item.dataset.spMi);
    if (index === menu.active) return;
    menu.active = index;
    el.querySelectorAll(".sp-mi.is-active").forEach((node) => node.classList.remove("is-active"));
    item.classList.add("is-active");
  });

  const focusTarget =
    el.querySelector<HTMLInputElement>("[data-sp-menu-search]") ??
    el.querySelector<HTMLInputElement>("[data-sp-menu-input]");
  // The input entry is often the reason the menu opened ("Nuova categoria"),
  // but a list with items keeps keyboard navigation on the items.
  if (focusTarget && (options.searchable || entries.filter(isItem).length === 0)) focusTarget.focus();
}

export function closeMenu(): boolean {
  if (!current) return false;
  const menu = current;
  current = null;
  menu.el.remove();
  menu.options.onClose?.();
  return true;
}

export function menuIsOpen(): boolean {
  return current !== null;
}

/** Keyboard handling while a menu is open. Returns whether the key was used. */
export function handleMenuKey(event: KeyboardEvent): boolean {
  const menu = current;
  if (!menu) return false;
  const inTextField = (event.target as Element | null)?.matches?.("[data-sp-menu-input]") ?? false;
  if (event.key === "Escape") {
    closeMenu();
    return true;
  }
  if (inTextField) return false;
  const count = visibleItems(menu).length;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (count === 0) return true;
    menu.active = (menu.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    renderMenu(menu);
    menu.el.querySelector<HTMLInputElement>("[data-sp-menu-search]")?.focus();
    menu.el.querySelector(".sp-mi.is-active")?.scrollIntoView({ block: "nearest" });
    return true;
  }
  if (event.key === "Enter") {
    select(menu, menu.active);
    return true;
  }
  return false;
}

document.addEventListener(
  "pointerdown",
  (event) => {
    if (current && !current.el.contains(event.target as Node)) closeMenu();
  },
  { capture: true },
);
window.addEventListener("resize", () => closeMenu());

// ── Toasts ────────────────────────────────────────────────────────────────────

export interface ToastOptions {
  tone?: "neutral" | "danger" | "success";
  action?: { label: string; run: () => void };
  /** Milliseconds; errors stay longer by default. */
  duration?: number;
}

function toastHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>("[data-sp-toasts]");
  if (!host) {
    host = document.createElement("div");
    host.className = "sp-toasts";
    host.dataset.spToasts = "";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

export function showToast(message: string, options: ToastOptions = {}) {
  const host = toastHost();
  const toast = document.createElement("div");
  const tone = options.tone ?? "neutral";
  const duration = options.duration ?? (tone === "danger" ? 9000 : options.action ? 7000 : 3500);
  toast.className = `sp-toast sp-toast--${tone}`;
  toast.innerHTML = `
    <span class="sp-toast-text">${escHtml(message)}</span>
    ${options.action ? `<button type="button" class="sp-toast-action">${escHtml(options.action.label)}</button>` : ""}
    <button type="button" class="sp-toast-close" aria-label="Chiudi">×</button>
    <span class="sp-toast-timer" style="animation-duration:${duration}ms"></span>`;
  host.appendChild(toast);
  // Older toasts make room: three at most.
  while (host.children.length > 3) host.firstElementChild?.remove();

  let timer = window.setTimeout(dismiss, duration);
  function dismiss() {
    window.clearTimeout(timer);
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 160);
  }
  toast.querySelector(".sp-toast-close")?.addEventListener("click", dismiss);
  toast.querySelector(".sp-toast-action")?.addEventListener("click", () => {
    dismiss();
    options.action?.run();
  });
  // Hovering keeps it: the user is about to click "Annulla".
  toast.addEventListener("mouseenter", () => {
    window.clearTimeout(timer);
    toast.classList.add("is-held");
  });
  toast.addEventListener("mouseleave", () => {
    toast.classList.remove("is-held");
    timer = window.setTimeout(dismiss, 2500);
  });
}
