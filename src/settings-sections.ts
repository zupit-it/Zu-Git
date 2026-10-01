// ── Collapsible settings sections ─────────────────────────────────────────────
// Every settings card is a <details>: the summary shows a status badge so the
// page can be scanned closed, and only the section being edited is opened.

const OPEN_SECTIONS_KEY = "zugit.settings.openSections";

type SectionStatus = { label: string; tone: "ok" | "warn" | "neutral" } | null;

function formValue(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement && field.type === "checkbox") return field.checked ? "on" : "";
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) return field.value.trim();
  return "";
}

function toggle(form: HTMLFormElement, name: string): SectionStatus {
  return formValue(form, name) ? { label: "On", tone: "ok" } : { label: "Off", tone: "neutral" };
}

const statusBySection: Record<string, (form: HTMLFormElement) => SectionStatus> = {
  github: (form) =>
    formValue(form, "githubToken") && formValue(form, "githubRepos")
      ? { label: "Configured", tone: "ok" }
      : { label: "Needs setup", tone: "warn" },
  jira: (form) =>
    formValue(form, "jiraBaseUrl") && formValue(form, "jiraEmail") && formValue(form, "jiraToken")
      ? { label: "Configured", tone: "ok" }
      : { label: "Not set", tone: "neutral" },
  score: (form) => toggle(form, "reactionScoreEnabled"),
  "merge-queue": (form) => toggle(form, "mergeQueueEnabled"),
  stale: (form) => toggle(form, "staleBranchesEnabled"),
  toggl: (form) => toggle(form, "togglEnabled"),
  calendar: (form) => toggle(form, "googleCalendarEnabled"),
  accessibility: (form) => toggle(form, "colorBlindMode"),
};

function sections(): HTMLDetailsElement[] {
  return [...document.querySelectorAll<HTMLDetailsElement>("details[data-settings-section]")];
}

function readOpenSections(): string[] | null {
  try {
    const raw = localStorage.getItem(OPEN_SECTIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : null;
  } catch {
    return null;
  }
}

function persistOpenSections() {
  const open = sections().filter((section) => section.open).map((section) => section.dataset.settingsSection);
  try {
    localStorage.setItem(OPEN_SECTIONS_KEY, JSON.stringify(open));
  } catch {
    // Storage unavailable: the sections just start closed next time.
  }
}

/** Refreshes the badge in each section's summary from the current form values. */
export function syncSettingsSections() {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  if (!form) return;
  for (const section of sections()) {
    const badge = section.querySelector<HTMLElement>("[data-section-status]");
    const status = statusBySection[section.dataset.settingsSection ?? ""]?.(form) ?? null;
    if (!badge) continue;
    badge.hidden = !status;
    badge.textContent = status?.label ?? "";
    badge.dataset.tone = status?.tone ?? "neutral";
  }
}

/** Drops the "unsaved changes" dot from every section (after save or discard). */
export function clearSettingsSectionsDirty() {
  for (const section of sections()) delete section.dataset.dirty;
}

/** Opens GitHub when it is not configured yet — nothing works without it. */
export function openUnconfiguredSections() {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  const github = document.querySelector<HTMLDetailsElement>('details[data-settings-section="github"]');
  if (form && github && statusBySection.github(form)?.tone === "warn") github.open = true;
}

export function initSettingsSections() {
  const form = document.querySelector<HTMLFormElement>("[data-settings-form]");
  if (!form) return;

  const open = new Set(readOpenSections() ?? []);
  for (const section of sections()) {
    section.open = open.has(section.dataset.settingsSection ?? "");
    section.addEventListener("toggle", persistOpenSections);
  }

  const markDirty = (event: Event) => {
    const section = (event.target as Element | null)?.closest<HTMLDetailsElement>("details[data-settings-section]");
    if (section) section.dataset.dirty = "";
    syncSettingsSections();
  };
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);

  // A field failing validation inside a closed section could not be focused or
  // shown: open its section first so the browser can point at it.
  form.addEventListener(
    "invalid",
    (event) => {
      const section = (event.target as Element | null)?.closest<HTMLDetailsElement>("details[data-settings-section]");
      if (section) section.open = true;
    },
    true,
  );

  document.querySelectorAll<HTMLButtonElement>("[data-settings-expand]").forEach((button) => {
    button.addEventListener("click", () => {
      const expand = button.dataset.settingsExpand === "all";
      for (const section of sections()) section.open = expand;
    });
  });

  syncSettingsSections();
}
