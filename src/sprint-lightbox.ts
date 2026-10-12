/**
 * Full-size view of a story's pictures, over the whole window. Shows at once
 * the copy the panel already holds — usually the original — and the original
 * when it arrives; ← / → step through the story's pictures, Esc or a click
 * outside closes.
 */

import { formatBytes } from "./sprint-model";

export interface LightboxItem {
  id: string;
  filename: string;
  size: number;
}

export interface LightboxSource {
  /** Object URL of the picture at its own quality. */
  load: (id: string) => Promise<string>;
  /** The picture already in memory, to show without waiting. */
  cached: (id: string) => string | undefined;
  /** Where "Apri nel browser" goes (the user's Jira session downloads it). */
  browserUrl: (item: LightboxItem) => string;
  openExternal: (url: string) => void;
}

const ARROW_LEFT = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4 6 9l5 5"/></svg>`;
const ARROW_RIGHT = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m7 4 5 5-5 5"/></svg>`;
const CLOSE = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`;
const EXTERNAL = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5H2.5v7h7V7M7 2h3v3M5.5 6.5 10 2"/></svg>`;

let current: { el: HTMLElement; items: LightboxItem[]; index: number; source: LightboxSource; seq: number } | null = null;

export function lightboxIsOpen(): boolean {
  return current !== null;
}

export function closeLightbox() {
  if (!current) return;
  current.el.remove();
  current = null;
  window.removeEventListener("keydown", onKey, true);
}

function onKey(event: KeyboardEvent) {
  if (!current) return;
  if (event.key === "Escape") closeLightbox();
  else if (event.key === "ArrowLeft") show(current.index - 1);
  else if (event.key === "ArrowRight") show(current.index + 1);
  else return;
  // Caught on the way down: the board's own keys (Esc closes the panel) wait.
  event.preventDefault();
  event.stopPropagation();
}

function show(index: number) {
  const box = current;
  if (!box || box.items.length === 0) return;
  box.index = (index + box.items.length) % box.items.length;
  const item = box.items[box.index];
  const seq = ++box.seq;
  const img = box.el.querySelector<HTMLImageElement>("[data-lb-img]");
  const stage = box.el.querySelector<HTMLElement>("[data-lb-stage]");
  const name = box.el.querySelector<HTMLElement>("[data-lb-name]");
  const meta = box.el.querySelector<HTMLElement>("[data-lb-meta]");
  // textContent: the file name is shown as it is, never parsed as HTML.
  if (name) name.textContent = item.filename;
  if (meta) {
    meta.textContent = [
      item.size ? formatBytes(item.size) : "",
      box.items.length > 1 ? `${box.index + 1} di ${box.items.length}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  box.el.querySelectorAll<HTMLElement>("[data-lb-step]").forEach((button) => {
    button.hidden = box.items.length < 2;
  });
  if (!img || !stage) return;
  stage.classList.remove("is-failed");
  const thumb = box.source.cached(item.id);
  img.alt = item.filename;
  if (thumb) img.src = thumb;
  else img.removeAttribute("src");
  stage.classList.add("is-loading");
  box.source
    .load(item.id)
    .then((url) => {
      if (current?.seq !== seq) return;
      img.src = url;
      stage.classList.remove("is-loading");
    })
    .catch(() => {
      if (current?.seq !== seq) return;
      stage.classList.remove("is-loading");
      // The thumbnail is better than nothing; without one, say so.
      if (!thumb) stage.classList.add("is-failed");
    });
}

export function openLightbox(items: LightboxItem[], startId: string, source: LightboxSource) {
  closeLightbox();
  const el = document.createElement("div");
  el.className = "sp-lb";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Allegato");
  el.innerHTML = `
    <div class="sp-lb-top">
      <span class="sp-lb-name" data-lb-name></span>
      <span class="sp-lb-meta" data-lb-meta></span>
      <span class="sp-grow"></span>
      <button type="button" class="sp-lb-btn" data-lb-browser>Apri nel browser ${EXTERNAL}</button>
      <button type="button" class="sp-lb-icon" data-lb-close aria-label="Chiudi (Esc)" title="Chiudi (Esc)">${CLOSE}</button>
    </div>
    <div class="sp-lb-stage" data-lb-stage>
      <button type="button" class="sp-lb-nav sp-lb-nav--prev" data-lb-step="-1" aria-label="Immagine precedente">${ARROW_LEFT}</button>
      <img class="sp-lb-img" data-lb-img alt="" draggable="false">
      <span class="sp-lb-failed">Anteprima non disponibile: apri il file nel browser.</span>
      <button type="button" class="sp-lb-nav sp-lb-nav--next" data-lb-step="1" aria-label="Immagine successiva">${ARROW_RIGHT}</button>
    </div>`;
  document.body.appendChild(el);
  current = { el, items, index: 0, source, seq: 0 };
  window.addEventListener("keydown", onKey, true);

  el.addEventListener("click", (event) => {
    const target = event.target as Element;
    const box = current;
    if (!box) return;
    if (target.closest("[data-lb-close]")) return closeLightbox();
    const step = target.closest<HTMLElement>("[data-lb-step]");
    if (step) return show(box.index + Number(step.dataset.lbStep));
    if (target.closest("[data-lb-browser]")) {
      box.source.openExternal(box.source.browserUrl(box.items[box.index]));
      return;
    }
    // A click on the dark backdrop, not on the picture or the bar, closes.
    if (!target.closest("[data-lb-img], .sp-lb-top")) closeLightbox();
  });

  const start = Math.max(0, items.findIndex((item) => item.id === startId));
  show(start);
  el.querySelector<HTMLElement>("[data-lb-close]")?.focus();
}
