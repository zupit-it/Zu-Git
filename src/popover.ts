// ── Anchored popover ──────────────────────────────────────────────────────────
// One at a time, under the element that opened it; a click elsewhere, Esc or a
// click on `[data-popover-close]` closes it. The add-reviewer popover and the
// auto-merge / rebase ones share it.

let popover: HTMLElement | null = null;
let outside: ((event: MouseEvent) => void) | null = null;
let onKey: ((event: KeyboardEvent) => void) | null = null;

export function closePopover() {
  popover?.remove();
  popover = null;
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
    if ((event.target as Element).closest("[data-popover-close]")) closePopover();
  });
  // Deferred, so the click that opened it does not close it.
  window.setTimeout(() => {
    if (popover !== el) return;
    outside = (event: MouseEvent) => {
      if (!el.contains(event.target as Node) && !trigger.contains(event.target as Node)) closePopover();
    };
    onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); closePopover(); }
    };
    document.addEventListener("click", outside, { capture: true });
    document.addEventListener("keydown", onKey, { capture: true });
  }, 0);
  if (options.focus) el.querySelector<HTMLElement>(options.focus)?.focus();
  return el;
}
