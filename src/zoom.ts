import { getCurrentWebview } from "@tauri-apps/api/webview";

// The whole window zooms, like a browser does: every view follows without
// sizing anything by hand. ⌘+ / ⌘− step through the levels, ⌘0 goes back to 100%.
const LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const STORAGE_KEY = "zugit.zoom";
const PILL_MS = 1800;

let current = 1;
let pill: HTMLElement | null = null;
let pillTimer = 0;

function savedZoom(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return LEVELS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

async function applyZoom(level: number, announce: boolean) {
  current = level;
  try {
    localStorage.setItem(STORAGE_KEY, String(level));
  } catch { /* the zoom still applies, it just won't survive a restart */ }
  await getCurrentWebview().setZoom(level).catch(() => undefined);
  if (announce) showPill();
}

function step(direction: 1 | -1) {
  const index = LEVELS.indexOf(current);
  const next = LEVELS[Math.min(LEVELS.length - 1, Math.max(0, index + direction))];
  void applyZoom(next, true);
}

function showPill() {
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "sp-toast zoom-pill";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    pill.innerHTML = `
      <span class="sp-toast-text" data-zoom-value></span>
      <button type="button" class="sp-toast-action" data-zoom-reset>Ripristina 100%</button>`;
    pill.querySelector("[data-zoom-reset]")?.addEventListener("click", () => void applyZoom(1, true));
    pill.addEventListener("mouseenter", () => window.clearTimeout(pillTimer));
    pill.addEventListener("mouseleave", () => hidePillLater());
    document.body.appendChild(pill);
  }
  pill.classList.remove("is-leaving");
  const value = pill.querySelector("[data-zoom-value]");
  if (value) value.textContent = `Zoom ${Math.round(current * 100)}%`;
  const reset = pill.querySelector<HTMLButtonElement>("[data-zoom-reset]");
  if (reset) reset.hidden = current === 1;
  hidePillLater();
}

function hidePillLater() {
  window.clearTimeout(pillTimer);
  pillTimer = window.setTimeout(() => {
    pill?.classList.add("is-leaving");
    window.setTimeout(() => {
      if (pill?.classList.contains("is-leaving")) {
        pill.remove();
        pill = null;
      }
    }, 160);
  }, PILL_MS);
}

export function installZoom(isMac: boolean) {
  const saved = savedZoom();
  if (saved !== 1) void applyZoom(saved, false);

  document.addEventListener("keydown", (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    // "+" covers the Italian layout and the numpad, "=" the US one (⌘= without Shift).
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      step(1);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "0" || e.code === "Numpad0") {
      e.preventDefault();
      void applyZoom(1, true);
    }
  });
}
