// ── Anchored popover ──────────────────────────────────────────────────────────
// One at a time, under the element that opened it; a click elsewhere, Esc or a
// click on `[data-popover-close]` closes it. The add-reviewer popover and the
// auto-merge / rebase ones share it.
//
// It is about the row it opened from: when a refresh redraws the list and that
// row's element is gone, it closes rather than float beside another PR's row.
// One that no longer hangs on its row says so with `data-popover-stay`.
//
// While it waits for GitHub to answer what it asked (`holdPopover`) it stays:
// no click, Esc or redraw closes it and nothing else opens, so the answer — a
// refusal above all — is always read where it was asked.

let popover: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let outside: ((event: MouseEvent) => void) | null = null;
let onKey: ((event: KeyboardEvent) => void) | null = null;
let held = false;
let holdTimer = 0;

/** Should GitHub never answer, the popover is let go after this long: it can be closed again. */
const HOLD_MS = 20_000;

/**
 * Keeps `el`, the open popover, up until the returned function is called:
 * meanwhile only `closePopover` takes it down. Let go by itself after HOLD_MS.
 */
export function holdPopover(el: HTMLElement): () => void {
  if (popover !== el) return () => {};
  const release = () => {
    if (popover !== el) return;
    held = false;
    window.clearTimeout(holdTimer);
  };
  held = true;
  window.clearTimeout(holdTimer);
  holdTimer = window.setTimeout(release, HOLD_MS);
  return release;
}

/** Closes the open popover — `only` that one, when given: an answer that comes late closes no other. */
export function closePopover(only?: HTMLElement) {
  if (only && popover !== only) return;
  held = false;
  window.clearTimeout(holdTimer);
  popover?.remove();
  popover = null;
  anchor = null;
  if (outside) document.removeEventListener("click", outside, { capture: true });
  if (onKey) document.removeEventListener("keydown", onKey, { capture: true });
  outside = null;
  onKey = null;
}

export interface PopoverOptions {
  /** Classes beside `arv-popover`. */
  className?: string;
  /** Selector of what takes the focus once open; nothing by default. */
  focus?: string;
}

/** Opens `html` in a popover under `trigger`, closing any other, and returns it. */
export function openPopover(trigger: HTMLElement, html: string, options: PopoverOptions = {}): HTMLElement {
  closePopover();
  const el = document.createElement("div");
  el.className = options.className ? `arv-popover ${options.className}` : "arv-popover";
  el.setAttribute("role", "dialog");
  el.innerHTML = html;
  document.body.appendChild(el);
  popover = el;
  anchor = trigger;

  // Below the trigger, aligned to its left edge; above it when there is no room below.
  const rect = trigger.getBoundingClientRect();
  const width = el.offsetWidth || 240;
  const height = el.offsetHeight || 160;
  let top = rect.bottom + 6;
  let left = rect.left;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${Math.max(8, left)}px`;

  el.addEventListener("click", (event) => {
    if (!held && (event.target as Element).closest("[data-popover-close]")) closePopover();
  });
  // Deferred, so the click that opened it does not close it.
  window.setTimeout(() => {
    if (popover !== el) return;
    outside = (event: MouseEvent) => {
      if (el.contains(event.target as Node)) return;
      // Held: the click goes nowhere, so nothing else opens over the answer awaited.
      if (held) { event.stopPropagation(); event.preventDefault(); return; }
      if (!trigger.contains(event.target as Node)) closePopover();
    };
    onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!held) closePopover();
    };
    document.addEventListener("click", outside, { capture: true });
    document.addEventListener("keydown", onKey, { capture: true });
  }, 0);
  if (options.focus) el.querySelector<HTMLElement>(options.focus)?.focus();
  return el;
}

// A new snapshot was drawn (api.ts says so once it is on screen).
window.addEventListener("zugit:dashboard", () => {
  if (popover && anchor && !held && !anchor.isConnected && !popover.hasAttribute("data-popover-stay")) closePopover();
});
