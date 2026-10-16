// ── Tiny King: who he is ──────────────────────────────────────────────────────
// Settings → Fun: load a character pack (a zip, pet_pack.rs checks it) in the
// Tiny King's place, go back to him, or save his own pack to the Downloads
// folder, to start from. The pack shows from his next appearance.

import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./utils";

interface PackInfo {
  name: string;
  custom: boolean;
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector);

function show(info: PackInfo) {
  const name = $("[data-pet-pack-name]");
  if (name) name.textContent = info.custom ? info.name : `${info.name} (built in)`;
  const reset = $("[data-pet-pack-reset]");
  if (reset) reset.hidden = !info.custom;
}

function say(message: string, tone: "ok" | "danger" = "ok") {
  const result = $("[data-pet-pack-result]");
  if (!result) return;
  result.textContent = message;
  result.classList.toggle("is-danger", tone === "danger");
  result.hidden = false;
}

/** Runs `work` with `button` busy, and says how it went. */
async function busy(button: HTMLButtonElement, work: () => Promise<string>) {
  button.disabled = true;
  try {
    say(await work());
  } catch (error) {
    say(errorMessage(error, "Something went wrong with the character pack."), "danger");
  } finally {
    button.disabled = false;
  }
}

export function installPetPackControls() {
  void invoke<PackInfo>("pet_pack_info").then(show).catch(() => {});

  // Picked outside the settings form: choosing a file is not a setting to save.
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = ".zip,application/zip";
  const load = $<HTMLButtonElement>("[data-pet-pack-load]");
  load?.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (!file || !load) return;
    void busy(load, async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = await invoke<PackInfo>("pet_pack_import", bytes);
      show(info);
      return `${info.name} loaded: he shows from his next appearance.`;
    });
  });

  const reset = $<HTMLButtonElement>("[data-pet-pack-reset]");
  reset?.addEventListener("click", () => void busy(reset, async () => {
    show(await invoke<PackInfo>("pet_pack_reset"));
    return "Back to the Tiny King.";
  }));

  const save = $<HTMLButtonElement>("[data-pet-pack-export]");
  save?.addEventListener("click", () => void busy(save, async () => {
    const path = await invoke<string>("pet_pack_export");
    return `Saved to ${path}, with GUIDE.md on making your own.`;
  }));
}
