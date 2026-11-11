// ── Slack nudges: the pure part ───────────────────────────────────────────────
// The table GitHub login → Slack member (see `slack.rs`), how a proposal from
// an assistant lays over what is saved, and the message a nudge copies.

export type MatchKind = "email" | "name" | "manual";

export interface SlackPerson {
  login: string;
  memberId: string;
  slackName?: string;
  match?: MatchKind;
  note?: string;
}

export interface SlackDirectory {
  teamId: string;
  teamName?: string;
  people: SlackPerson[];
  updatedAt?: string;
}

export interface SlackUnmatched {
  login: string;
  reason: string;
}

export interface SlackProposal {
  createdAt: string;
  source: string;
  teamId: string;
  teamName?: string;
  people: SlackPerson[];
  unmatched: SlackUnmatched[];
  note?: string;
}

/** What the proposal does to a row: adds it, changes its member, or confirms it. */
export type RowChange = "new" | "changed" | "same";

export interface ReviewRow {
  login: string;
  memberId: string;
  slackName: string;
  match?: MatchKind;
  note?: string;
  change?: RowChange;
  /** Why the assistant could not find this person. */
  unmatched?: string;
}

const lower = (login: string) => login.toLowerCase();

/**
 * One row per person: the team, everyone already saved and everyone the
 * proposal names. A proposed row replaces the saved one, marked with what it
 * changes; the rest stay as saved, or empty to fill by hand.
 */
export function reviewRows(team: string[], directory: SlackDirectory, proposal: SlackProposal | null): ReviewRow[] {
  const logins = new Map<string, string>();
  const add = (login: string) => {
    if (login && !logins.has(lower(login))) logins.set(lower(login), login);
  };
  team.forEach(add);
  directory.people.forEach((p) => add(p.login));
  proposal?.people.forEach((p) => add(p.login));
  proposal?.unmatched.forEach((u) => add(u.login));

  const find = <T extends { login: string }>(list: T[] | undefined, key: string) =>
    list?.find((item) => lower(item.login) === key);

  return [...logins.entries()]
    .map(([key, login]): ReviewRow => {
      const saved = find(directory.people, key);
      const proposed = find(proposal?.people, key);
      if (proposed) {
        return {
          login,
          memberId: proposed.memberId,
          slackName: proposed.slackName ?? saved?.slackName ?? "",
          match: proposed.match,
          note: proposed.note,
          change: !saved ? "new" : saved.memberId === proposed.memberId ? "same" : "changed",
        };
      }
      return {
        login,
        memberId: saved?.memberId ?? "",
        slackName: saved?.slackName ?? "",
        match: saved?.match,
        note: saved?.note,
        unmatched: find(proposal?.unmatched, key)?.reason,
      };
    })
    .sort((a, b) => lower(a.login).localeCompare(lower(b.login)));
}

/** The table to save: rows with a member id, trimmed. */
export function directoryFromRows(teamId: string, teamName: string | undefined, rows: ReviewRow[]): SlackDirectory {
  return {
    teamId: teamId.trim(),
    teamName: teamName?.trim() || undefined,
    people: rows
      .filter((row) => row.memberId.trim())
      .map((row) => ({
        login: row.login,
        memberId: row.memberId.trim(),
        slackName: row.slackName.trim() || undefined,
        match: row.match,
        note: row.note,
      })),
  };
}

export function slackMember(directory: SlackDirectory | null, login: string): SlackPerson | undefined {
  if (!directory?.teamId) return undefined;
  return directory.people.find((p) => lower(p.login) === lower(login));
}

/** "Mario" from "Mario Rossi"; nothing from a handle like "mario.rossi". */
export function firstName(slackName: string | undefined): string | null {
  const first = slackName?.trim().split(/\s+/)[0] ?? "";
  return /^\p{L}[\p{L}'’-]*$/u.test(first) ? first : null;
}

export interface NudgedPr {
  repo: string;
  id: number;
  title: string;
  url: string;
}

/** What a nudge puts on the clipboard, to paste in the reviewer's DM. */
export function nudgeMessage(pr: NudgedPr, slackName?: string): string {
  const name = firstName(slackName);
  const title = pr.title.trim() || `${pr.repo}#${pr.id}`;
  return `Ciao${name ? ` ${name}` : ""}! Quando hai un attimo, riusciresti a dare un'occhiata alla mia PR ` +
    `“${title}”? ${pr.url}\nGrazie!`;
}
