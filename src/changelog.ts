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
        title: "PR diff — review a pull request without leaving ZuGit",
        body: "Click the <strong>+N −N</strong> chip on a PR row to open its changed files right in ZuGit: files listed foundations first, <strong>Unified</strong> or <strong>Split</strong> view, syntax colours. Click a line number — or press and drag over several — to <strong>comment</strong>. GitHub's conversations show under their lines as they do there, outdated ones above the files with the code they were written on, and you can <strong>reply</strong> to them or <strong>resolve</strong> them. Your comments stay in ZuGit until you press <strong>Publish review</strong> in the top bar: add a summary and choose <strong>Comment</strong>, <strong>Request changes</strong> or <strong>Approve</strong> — one GitHub review. If someone pushes while you read, ZuGit offers <strong>Reload</strong> and never publishes on code you have not seen; your comments follow their code, as on GitHub.",
        imgs: ["/assets/changelog/pr-review.png"],
      },
      {
        title: "AI review — Claude or Codex reads the PR first",
        body: "Press <strong>Copy review prompt</strong> in the diff and paste it into Claude Code, Codex or Claude Desktop — or run <code>/mcp__zugit__review_pr</code> in Claude Code. Through the ZuGit connector your agent reads the PR, its Jira story and checklist and the open conversations, reads the code with <strong>read-only git</strong> — your working tree is never touched — and hands back a summary, a reading order and line comments. They appear in the diff under their lines, with a chip on the PR row: <strong>Keep</strong>, <strong>Edit</strong> or <strong>Discard</strong> each one. Kept ones become your comments; <strong>nothing reaches GitHub</strong> until you publish your review.",
      },
    ],
  },
  {
    label: "Older news",
    entries: [
      {
        title: "Release status — see the release as a map",
        body: "The release diff now opens with a <strong>metro map</strong> of the release above the list. On <strong>main</strong> it is one line from the last tag to HEAD, a stop per story merged since, then a dotted stretch to the <strong>next tag</strong> through a dashed ghost for every planned story not merged yet — with its open PR when there is one. On a <strong>release branch</strong> main runs on top and the branch below: every <strong>cherry-pick</strong> drops from its stop on main, and a story <em>Verified</em> on main but missing from the branch drops to a <strong>ghost</strong> — the pick still to do, at a glance. A PR with several stories (<code>feat(PENT-1,PENT-2): …</code>) is one stop, and since it is picked whole, a verified story sharing it with one still in testing shows as <strong>held back</strong>, not as ready. Unplanned stories are diamonds, other PRs on main fold into <code>+N</code> stops, beta tags flag main. Hover a stop for its stories, click it to jump to their rows; the map follows the tab you are on, zooms with <strong>− / + / fit</strong> or a pinch, and <strong>Hide map</strong> folds it down to its legend. The window is bigger too, growing with your screen.",
        imgs: ["/assets/changelog/release-map.png"],
      },
      {
        title: "Jira — API tokens with scopes work too",
        body: "A Jira token created <strong>with scopes</strong> used to fail with an authentication error: Atlassian only accepts it through its own gateway, not on your site's address. ZuGit now recognises the token type on the first call and uses the right address on its own — <strong>nothing to change in Settings</strong>, the Jira URL stays your site and links still open there. Scoped tokens are now the <strong>recommended choice</strong>: they give ZuGit only what it uses, and Atlassian is phasing out the classic ones. Create one from <strong>Create token</strong> in <strong>Settings → Jira</strong> with <em>Create API token with scopes</em>, app Jira, and the scopes <code>read:jira-work</code>, <code>write:jira-work</code> and <code>read:jira-user</code>. Classic tokens keep working.",
      },
      {
        title: "Toggl — the bot's checks, before you submit",
        body: "No more surprises on Slack the next morning: every row of the planner is checked against the rules of the <strong>Zupit Toggl bot</strong> and shows, with the same emoji, what it would flag — a tag next to a story id 🚫, the wrong billable flag 💰, a tag on a Zupit entry 🟦, no story and no tag 🏷️, and the rest. Each line has its fix one click away, and <strong>Applica suggerimenti</strong> in the footer applies every fix that is certain, on all rows at once. ZuGit also spots what the bot lets through but gets wrong: a story booked on an unusual project 🔀, and <strong>several stories in one entry</strong> 🧩 — the bot only reads the first key — which you can <strong>split</strong> into one row per story, or turn into sprint work with no keys and a tag. Your AI assistant is now told the same rules, so its plans start clean. The story bar above the plan is gone too: <strong>+ Row</strong> or a click on free time already lists every active story first.",
      },
      {
        title: "Toggl — edit the plan like a calendar",
        body: "The timeline on the left is now yours to drag: <strong>move</strong> a block, <strong>resize</strong> it from its top or bottom edge, or drag the <strong>seam between two blocks</strong> to say \"this story ended at 11, not 10:30\" — the next one follows, so the day never gets a hole or an overlap. A <strong>click on free time</strong> adds a row covering exactly that gap. The pencil is gone: times and length are always editable, with <strong>↑ ↓</strong> for ±15 minutes or typed the quick way (<code>930</code>, <code>+45m</code>, <code>1h30</code>). The description <strong>suggests</strong> today's stories and what you booked before — pick one, or just type a Jira key, and project, tag and billable come from your history. Project and tag open a <strong>searchable picker</strong>, most used first.",
        imgs: ["/assets/changelog/toggl-editing.png"],
      },
      {
        title: "Toggl — the plan follows what you actually did",
        body: "The planner no longer guesses from Jira statuses alone. It also counts the stories <strong>you moved</strong> during the day — straight to <em>Developed</em> included — your <strong>commits</strong> on every branch, and your <strong>Claude Code and Codex sessions</strong>, whose branch names (<code>PENT-5755/…</code>, <code>ZUME-114/…</code>) say which story you were on. The day is then split <strong>in proportion</strong>, in blocks of at least an hour, instead of cutting every gap in half — and each row says why it is there (<em>Visto lavorare: 2 commits · → Merge Request</em>), with the other plausible stories one click away. Only the open sprint counts: a story forgotten in <em>In Progress</em> months ago no longer sneaks into your week. Meetings now remember how you booked them — per recurring series and per title, matched against your history by time — so next Wednesday's call comes pre-filled. Optional in <strong>Settings → Toggl</strong>: <strong>Gap filling</strong> shares the time nothing explains between the sprint's stories by what their estimate still leaves unbooked, at your own pace (minutes per story point, learned from your history).",
        imgs: ["/assets/changelog/toggl-evidence.png"],
      },
      {
        title: "Ask Claude or Codex to fill your day",
        body: "ZuGit is now an <strong>MCP connector</strong>: register it once from <strong>Settings → Assistenti AI</strong> (the commands for Claude Code, Codex and Claude Desktop are ready to copy) and ask your assistant <em>\"compila il mio Toggl di oggi\"</em>. It reads the same day ZuGit sees — meetings, stories, commits, sessions, free time — adds what it knows from your conversation, and hands back a plan. Nothing reaches Toggl: the plan opens straight away in the planner, with a note on how the day was split and a reason on every row, and you confirm it — or go back to ZuGit's own plan with one click. <strong>Your tokens never leave the keychain</strong> and never appear in the conversation.",
        imgs: ["/assets/changelog/toggl-ai-proposal.png"],
      },
      {
        title: "Release notes — you decide what goes in, grouped by epic",
        body: "Every row of the release diff now says whether it will end up in the notes — <strong>In notes</strong> or <strong>Skipped</strong> — and one click on it offers <strong>Include anyway</strong> / <strong>Exclude anyway</strong> / <strong>Auto (default)</strong>. A story sitting in <em>Missing</em> that shipped anyway can finally be announced, and a <em>Done</em> one can be kept quiet, without editing Jira first. Everything left on <em>Auto</em> keeps following the usual rule — only Done goes in — and your decisions are saved per release, surviving a refresh, a version switch and a restart. The notes panel also gained an <strong>Epic</strong> grouping: <em>POWER</em> and <em>BUG</em> still lead, and under each one the stories are split into per-epic sections read from Jira's <strong>Principale</strong> field, with anything without an epic last.",
        imgs: ["/assets/changelog/override-release-notes-logic.png"],
      },
      {
        title: "Release status — check a release on its own branch",
        body: "Next to the version in the release diff you can now pick the <strong>branch</strong> it is checked against: <strong>main</strong>, as before, or any branch starting with <code>release</code> — the prefix is yours to change in <strong>Settings → Jira</strong>. On a release branch the diff starts from <strong>that branch's latest tag</strong>, counts only the PRs merged into it, and reads the commits too, so a <strong>cherry-pick</strong> pushed without a PR still marks its story as there. A story that is <em>Verified</em> on Jira but never reached the branch stays in <strong>Missing</strong>, flagged <em>Jira ahead of git</em>: that is your cherry-pick still to do. ZuGit remembers the branch you picked for each release.",
      },
      {
        title: "Refresh picks up release changes from Jira",
        body: "Moved a story to another fix version on Jira? The next <strong>refresh</strong> now groups its PR under the <strong>new release</strong>. Before, ZuGit could keep showing it under the old one, because tickets it had already seen were served from memory instead of being read again. Every refresh now re-reads all linked tickets; if Jira does not answer, the last known data is kept.",
      },
      {
        title: "Settings — compact, open only what you need",
        body: "The settings page is now grouped into <strong>Connections</strong>, <strong>Dashboard features</strong>, <strong>Time tracking</strong> and <strong>General</strong>, and every section folds down to a single line with its state at a glance — <em>Configured</em> / <em>Needs setup</em>, <em>On</em> / <em>Off</em>. Open just the one you need, or use <strong>Expand all</strong> / <strong>Collapse all</strong>; ZuGit remembers which ones you left open. A dot next to a title marks unsaved edits, even when the section is closed.",
      },
      {
        title: "Stale branches — find what everyone forgot to delete",
        body: "Turn it on in <strong>Settings → Stale branches</strong> and a tab appears next to <em>Status</em>, listing the remote branches with <strong>no open PR</strong> that nobody has pushed to in more than <strong>15 days</strong> — the threshold is yours to change, and so is the list of ignored prefixes (<strong>release</strong> out of the box). The default branch, protected branches and anything that is the head or the base of an open PR never show up. What is left is sorted oldest commit first, scoped to the repositories you have selected in the toolbar, and can be filtered by <strong>Internal / Collaborator</strong> or narrowed to <strong>Only mine</strong> — branches whose last commit is yours, the only owner GitHub records for a ref. <strong>Group by author</strong> turns it into one section per person, so you know who to ask. It is read-only: a row opens the branch on GitHub, ZuGit never deletes anything.",
        imgs: ["/assets/changelog/stale-branches.png"],
      },
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
