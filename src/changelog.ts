import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { escHtml, errorMessage } from "./utils";
import { setStatus } from "./render";

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
        title: "Orphan branches — find what everyone forgot to delete",
        body: "Turn it on in <strong>Settings → Orphan branches</strong> and a tab appears next to <em>Status</em>, listing the remote branches with <strong>no open PR</strong> that nobody has pushed to in more than <strong>15 days</strong> — the threshold is yours to change, and so is the list of ignored prefixes (<strong>release</strong> out of the box). The default branch, protected branches and anything that is the head or the base of an open PR never show up. What is left is sorted oldest commit first, scoped to the repositories you have selected in the toolbar, and can be filtered by <strong>Internal / Collaborator</strong> or narrowed to <strong>Only mine</strong> — branches whose last commit is yours, the only owner GitHub records for a ref. <strong>Group by author</strong> turns it into one section per person, so you know who to ask. It is read-only: a row opens the branch on GitHub, ZuGit never deletes anything.",
        imgs: ["/assets/changelog/orphan.png"],
      },
    ],
  },
  {
    label: "Older news",
    entries: [
      {
        title: "Toggl — fill your timesheet from the day you actually had",
        body: "Turn it on in <strong>Settings → Toggl</strong> and a <strong>Toggl</strong> button appears next to Refresh. It reads the entries you already have, finds the free slots of your working range (default <strong>08:00–14:00</strong>) and fills them with the Jira stories assigned to you — using <em>when</em> each story changed status to split the day: the one you moved to merge request at 10:30 gets the morning, the one you picked up then gets the afternoon. Project, tags and the billable flag come from your own Toggl history. When two stories are equally plausible the row asks which one, or splits the slot between them. Nothing is written until you press <strong>Create in Toggl</strong>.",
        imgs: ["/assets/changelog/toggl.png"],
      },
      {
        title: "Meetings from Google Calendar, in the same plan",
        body: "Connect your calendar in <strong>Settings → Google Calendar</strong> (read-only) and the meetings inside your working range become rows of their own, taking their slot before the stories are placed — the retro lands on the project and tags you always give it. Declined invitations, all-day entries and anything already tracked are skipped.",
      },
      {
        title: "Stories across multiple releases",
        body: "A story/PR can now belong to several Jira fix versions at once. The dashboard groups it under its <strong>primary</strong> (most imminent) release with a <strong>+N release</strong> badge listing the others, and the release diff finally classifies it correctly — <strong>Done/Missing instead of Extra</strong> — whenever any of its versions matches. <strong>Move, Defer, Adopt and Drop</strong> now act only on the current release, preserving the story's other version assignments instead of overwriting them.",
      },
      {
        title: "Add graphic warning for expired tokens",
        body: "Removed mock data",
      },
      {
        title: "Add reviewer from the dashboard",
        body: "Each PR row now has a <strong>+</strong> button next to the reviewer badges. Click it to pick any team member not already reviewing — they get added instantly without leaving the dashboard.",
        imgs: ["/assets/changelog/add-reviewer.png"],
      },
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

/** Links inside release notes must open in the real browser, not inside the app. */
function wireExternalLinks(root: HTMLElement) {
  root.addEventListener("click", (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>("[data-external-link]");
    if (!link) return;
    event.preventDefault();
    void invoke("open_external", { url: link.getAttribute("href") ?? "" }).catch(() => {});
  });
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

// ── Update release notes ──────────────────────────────────────────────────────
//
// Fed by the body published with the release, not by CHANGELOG.md: what goes in
// the What's new modal above is curated by hand, on purpose.

interface ChangelogItem {
  title: string;
  body: string;
  category: string;
}

interface Release {
  /** "0.9.7", or "Unreleased". */
  version: string;
  date: string;
  items: ChangelogItem[];
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\]\s*(?:-\s*(.+))?$/;
const CATEGORY_HEADING = /^###\s+(.+)$/;
const BULLET = /^[-*]\s+(.*)$/;

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let category = "";
  let item: ChangelogItem | null = null;

  const flush = () => {
    if (release && item && (item.title || item.body)) release.items.push(item);
    item = null;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    const heading = RELEASE_HEADING.exec(line);
    if (heading) {
      flush();
      release = { version: heading[1], date: (heading[2] ?? "").trim(), items: [] };
      releases.push(release);
      category = "";
      continue;
    }
    if (!release) continue;

    const categoryLine = CATEGORY_HEADING.exec(line);
    if (categoryLine) {
      flush();
      category = categoryLine[1].trim();
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      const text = bullet[1].trim();
      // "**Title** — body" is the shape used throughout the changelog; anything
      // else becomes a body-only item so nothing is lost.
      const titled = /^\*\*(.+?)\*\*\s*[—–-]?\s*(.*)$/.exec(text);
      item = titled
        ? { title: titled[1].trim(), body: titled[2].trim(), category }
        : { title: "", body: text, category };
      continue;
    }

    // Continuation of the current bullet: the changelog wraps long entries.
    if (item && line.trim()) {
      item.body = `${item.body} ${line.trim()}`.trim();
      continue;
    }
    if (!line.trim()) flush();
  }
  flush();

  return releases.filter((entry) => entry.items.length > 0);
}

/** Inline markdown → HTML, for the small subset the changelog actually uses. */
export function renderInline(markdown: string): string {
  return escHtml(markdown)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-external-link>$1</a>');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderItems(items: ChangelogItem[]): string {
  let lastCategory = "";
  return items
    .map((item, index) => {
      const heading =
        item.category && item.category !== lastCategory
          ? `<div class="cl-category">${escHtml(item.category)}</div>`
          : "";
      lastCategory = item.category || lastCategory;
      return `
        ${heading}
        <div class="cl-entry">
          <div class="cl-entry-body">
            <div class="cl-entry-num">${index + 1}</div>
            <div>
              ${item.title ? `<div class="cl-entry-title">${renderInline(item.title)}</div>` : ""}
              <div class="cl-entry-desc">${renderInline(item.body)}</div>
            </div>
          </div>
        </div>`;
    })
    .join("");
}

/**
 * What is in the update, before installing it. The body is the release notes
 * published with the update, so this is the one place where the notes are read
 * from the release rather than from the bundled changelog.
 */
export function showUpdateNotes(version: string, body: string | null) {
  document.querySelector("[data-changelog-overlay]")?.remove();

  const notes = (body ?? "").trim();
  const items = notes ? parseChangelog(`## [${version}]\n\n${notes}`)[0]?.items ?? [] : [];

  const overlay = document.createElement("div");
  overlay.className = "cl-overlay";
  overlay.dataset.changelogOverlay = "";
  overlay.innerHTML = `
    <div class="cl-modal" role="dialog" aria-modal="true" aria-label="Update available">
      <div class="cl-header">
        <span class="cl-badge cl-badge--update">Update available</span>
        <span class="cl-version">v${escHtml(version)}</span>
      </div>
      <div class="cl-entries">
        ${
          items.length
            ? `<div class="cl-version-block">${renderItems(items)}</div>`
            : notes
              ? `<div class="cl-entry"><div class="cl-entry-body"><div>${renderInline(notes)}</div></div></div>`
              : `<div class="cl-entry"><div class="cl-entry-body"><div class="cl-entry-desc">
                   This release ships without notes. Install it to get the latest fixes.
                 </div></div></div>`
        }
      </div>
      <div class="cl-footer">
        <button class="secondary-button" data-update-later type="button">Later</button>
        <button class="primary-button" data-update-install type="button">Install and restart</button>
      </div>
    </div>
  `;

  const dismiss = () => overlay.remove();
  overlay.querySelector("[data-update-later]")?.addEventListener("click", dismiss);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) dismiss();
  });
  wireExternalLinks(overlay);

  overlay.querySelector("[data-update-install]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = true;
    button.textContent = "Installing…";
    try {
      await invoke("install_update");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Install and restart";
      setStatus(errorMessage(error, "Could not install the update."), "danger");
    }
  });

  document.body.appendChild(overlay);
}
