import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { escHtml, errorMessage } from "./utils";
import { setStatus } from "./render";
import { parseChangelog, type ChangelogItem } from "./changelog-parse";

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
        title: "PR list — Needs you without rebases, unresolved straight to the conversation",
        body: "One of your PRs whose branch is only behind its base no longer shows in <strong>Needs you</strong>, nor counts there: its row still says <strong>Needs rebase</strong>, a click away, and it is listed again when something else waits on you — changes requested, a failed check, conflicts. And <strong>N unresolved</strong> on a row is now a button: it opens the diff on the first conversation not resolved yet on GitHub — by file as the diff lists them, then by line — and lights it up a moment. One left only on code that has since changed is unfolded in the GitHub panel above the files.",
      },
      {
        title: "Silent mode — do not disturb between two times of day",
        body: "In <strong>Settings → Silent mode</strong>, a switch and two times, <strong>From</strong> and <strong>To</strong>. Between them ZuGit sends no notification, the Tiny King stays away and the Toggl planner does not open by itself. A <strong>To</strong> earlier than <strong>From</strong> is the next day's — 14:00 → 08:00 is until 8 the next morning — and the same time twice is the whole day. Once it is over nothing is replayed one by one: at the next refresh you are told once what changed in the meantime and is still there, and the Toggl reminder comes for the day it was due on. What answers something you just did — a status line, the King when you try him out — stays as it is, and GitHub is asked nothing more.",
      },
      {
        title: "Your review shows on the list as soon as it is published",
        body: "After <strong>Request changes</strong> or <strong>Approve</strong> from the diff, your badge on the PR's row says so at once, dimmed until GitHub's own Reviewers list shows it. After <strong>Comment</strong> it says <em>Commented</em> — or, when a review was asked of you, <em>Review required</em> stays, dimmed, until GitHub says where you stand: an earlier verdict of yours may stand again. Before, closing the diff right after publishing could find <em>Review required</em> still there until the next refresh. GitHub is asked no more than before: that one PR, once, and once more only if it does not show your review yet.",
      },
      {
        title: "Only the repositories you select are loaded",
        body: "A repository turned off in the list's selector is no longer asked to GitHub at every refresh — less of your token's hourly limit — and its PRs are no longer counted: the numbers on <strong>All</strong>, <strong>Mine</strong>, <strong>Needs you</strong> and in <strong>Review load</strong> are about the selected repositories only, so they match the list. Turn one back on and it loads right away. The Sprint cards, the merge queue and the notifications follow the same selection.",
      },
      {
        title: "Auto-merge and rebase, without opening GitHub",
        body: "Where GitHub lets you, a PR row offers <strong>Auto-merge</strong>: GitHub then merges the PR by itself, by <strong>Squash and merge</strong>, once its reviews and checks pass — the commit message is yours to edit first — and a click on the chip turns it off again. <strong>Needs rebase</strong> rebases the branch on its base, as GitHub's <em>Update with rebase</em>, after saying what changes. On a colleague's PR it says so, with how recent their last commit is, and afterwards offers to open Slack with a message telling them to run <code>git pull --rebase</code>. With conflicts, or a push meanwhile, GitHub refuses and nothing changes: ZuGit reads the PR again and tells you when the branch has moved. Your GitHub token needs write access to <strong>Pull requests</strong> and <strong>Contents</strong>.",
      },
      {
        title: "What you just did on a PR shows at once",
        body: "After a rebase, a reviewer asked or asked again, the row shows it straight away, dimmed, until GitHub shows it too; an auto-merge switch is answered by GitHub with the PR as it now is. For that ZuGit reads that one PR, no longer the whole list: a fraction of what a refresh costs your token's hourly limit. The list is only ever what GitHub last said, so a row cannot be left showing a guess.",
      },
      {
        title: "Needs you — one place for what waits on you",
        body: "<strong>Show</strong> is now <strong>All</strong>, <strong>Mine</strong> and <strong>Needs you</strong>: the reviews asked of you, and your own PRs with changes requested, a failed check or conflicts. Its count is the only one filled in. The line under the filters is gone — the toolbar already says what is on — and the reviewer you pick in <strong>Review load</strong> is tinted, with an × to turn it off.",
      },
      {
        title: "GitHub's hourly limit in the top bar",
        body: "Turn on <strong>Settings → GitHub → API usage</strong> and the top bar shows, beside the sync status, how much of your token's hourly limit is used, as <strong>52/5000</strong>: the one used the most of GraphQL and REST, with both and when they start again on hover. Amber from 70%, red from 90%. GitHub says it in every answer, so nothing is asked for it.",
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
          ${
            item.imgs.length
              ? `<div class="cl-entry-imgs">${item.imgs
                  .map((src) => `<img class="cl-entry-img" src="${escHtml(src)}" alt="" onerror="this.hidden=true" loading="lazy" />`)
                  .join("")}</div>`
              : ""
          }
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
