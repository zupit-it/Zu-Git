import { getVersion } from "@tauri-apps/api/app";

const STORAGE_KEY = "zugit-changelog-seen";

const ENTRIES: {
  title: string;
  body: string;
  imgs?: string[];
}[] = [
  {
    title: "New PR — branch auto-detection",
    body: "Click <strong>+ New PR</strong> and ZuGit finds your latest push across all active repos and proposes it against main. Edit the title, description, reviewers, and Jira acceptance criteria before opening. Reviewers are sorted by current review load. If not all criteria are checked you can only open as draft — check them all to publish directly.",
    imgs: ["/assets/changelog/new-pr-card.png"],
  },
  {
    title: "Promote draft PR",
    body: "Each draft PR row now has a <strong>Promote</strong> button. It opens the same card pre-filled with the existing title, body, reviewers, and fetches the Jira checklist fresh. On publish, all criteria are marked done and the configured Jira workflow transition is triggered (default: <strong>MERGE REQUEST</strong>).",
    imgs: ["/assets/changelog/promote-button.png"],
  },
  {
    title: "Branch status chips",
    body: "New inline chips show branch health at a glance: CI status, needs rebase, merge conflicts, and unresolved review conversations — right on the PR row.",
    imgs: ["/assets/changelog/branch-status.png", "/assets/changelog/branch-status-2.png"],
  },
];

function buildModal(version: string): HTMLElement {
  const overlay = document.createElement("div");
  overlay.className = "cl-overlay";
  overlay.dataset.changelogOverlay = "";

  overlay.innerHTML = `
    <div class="cl-modal" role="dialog" aria-modal="true" aria-label="What's new">
      <div class="cl-header">
        <span class="cl-badge">What's new</span>
        <span class="cl-version">v${version}</span>
      </div>

      <div class="cl-entries">
        ${ENTRIES.map((e, i) => `
          <div class="cl-entry">
            <div class="cl-entry-body">
              <div class="cl-entry-num">${i + 1}</div>
              <div>
                <div class="cl-entry-title">${e.title}</div>
                <div class="cl-entry-desc">${e.body}</div>
              </div>
            </div>
            ${e.imgs?.length ? `<div class="cl-entry-imgs">${e.imgs.map(src => `<img class="cl-entry-img" src="${src}" alt="${e.title}" onerror="this.hidden=true" loading="lazy" />`).join("")}</div>` : ""}
          </div>
        `).join("")}
      </div>

      <div class="cl-footer">
        <button class="primary-button" data-changelog-close type="button">Got it</button>
      </div>
    </div>
  `;

  overlay.querySelector("[data-changelog-close]")?.addEventListener("click", () => close(version));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(version);
  });

  return overlay;
}

function close(version: string) {
  localStorage.setItem(STORAGE_KEY, version);
  document.querySelector("[data-changelog-overlay]")?.remove();
}

export async function maybeShowChangelog() {
  const version = await getVersion();
  if (localStorage.getItem(STORAGE_KEY) === version) return;
  document.body.appendChild(buildModal(version));
}

export async function showChangelog() {
  if (document.querySelector("[data-changelog-overlay]")) return;
  const version = await getVersion();
  document.body.appendChild(buildModal(version));
}
