import { getVersion } from "@tauri-apps/api/app";

const STORAGE_KEY = "zugit-changelog-seen";

interface ChangelogEntry {
  title: string;
  body: string;
  imgs?: string[];
}

interface VersionBlock {
  label?: string; // section header; omit for the current release
  entries: ChangelogEntry[];
}

const VERSIONS: VersionBlock[] = [
  {
    entries: [
      {
        title: "Add reviewer from the dashboard",
        body: "Each PR row now has a <strong>+</strong> button next to the reviewer badges. Click it to pick any team member not already reviewing — they get added instantly without leaving the dashboard.",
        imgs: ["/assets/changelog/add-reviewer.png"],
      },
    ],
  },
  {
    label: "Older news",
    entries: [
      {
        title: "Jira transition on PR open — always triggered",
        body: "Opening a non-draft PR now always triggers the configured Jira workflow transition (default: <strong>MERGE REQUEST</strong>), even when the ticket has no acceptance criteria checklist. Previously the transition was silently skipped if the checklist was empty.",
      },
      {
        title: "Release status — smarter tag detection & last tag reference",
        body: "The release diff now finds the last tag strictly on the default branch, so hotfix or side-branch tags no longer skew what counts as 'merged since last release'. The tag itself is also shown in the tab bar as <strong>Since: vX.Y.Z</strong> so you always know the exact cutoff. Release notes also gained a <strong>PREVIEW</strong> badge on stories not yet Verified by QA.",
      },
      {
        title: "My Score — team responsiveness at a glance",
        body: "A new personal score section tracks how quickly and consistently you respond to review requests from teammates. See your average response time, pending reviews, and how you rank within the team — so you can stay on top of collaboration without losing focus. The section can be <strong>disabled from Settings</strong> if you prefer a cleaner dashboard.",
        imgs: ["/assets/changelog/my-score.png"],
      },
      {
        title: "My Score settings — fine-tune the rules",
        body: "A dedicated <strong>My Score</strong> card in Settings lets you enable or disable each scoring rule independently: review requests, changes requested, CI failures, and branch-behind checks. Each rule shows when it kicks in and its penalty weight. <em>Branch behind / conflicting</em> is off by default.",
        imgs: ["/assets/changelog/my-score-settings.png"],

      },
      {
        title: "Draft PR row — greyscale treatment",
        body: "Draft PRs now visually step back in the list: all colored elements fade to greyscale, while a dark solid <strong>DRAFT · KEY</strong> pill replaces the key chip and anchors the row at a glance. Ready PRs stay vibrant, making the queue easier to scan.",
        imgs: ["/assets/changelog/greyscale-draft.png"],
      },
      {
        title: "Release status",
        body: "A new <strong>Release status</strong> button is always visible in the header. Click it to open the release diff — a full breakdown of Jira stories across Done, Missing, Extra, and Flagged tabs for the selected fix version, with author avatars and branch info on every row. Stories can be <strong>deferred to the next release</strong> directly from the modal, and you can <strong>generate release notes</strong> from what's actually done with one click.",
        imgs: ["/assets/changelog/release-status.png"],
      },
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
    ],
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
        ${VERSIONS.map((block) => `
          <div class="cl-version-block">
            ${block.label ? `<div class="cl-version-label">${block.label}</div>` : ""}
            ${block.entries.map((e, i) => `
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
