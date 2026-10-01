/**
 * CHANGELOG.md → structured releases, for the update modal. Pure, with no DOM
 * or Tauri dependency, so it can be tested on its own.
 */

export interface ChangelogItem {
  title: string;
  body: string;
  category: string;
  /** Screenshots, from `![alt](url)` paragraphs under the entry. */
  imgs: string[];
}

export interface Release {
  /** "0.9.7", or "Unreleased". */
  version: string;
  date: string;
  items: ChangelogItem[];
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\]\s*(?:-\s*(.+))?$/;
const CATEGORY_HEADING = /^###\s+(.+)$/;
const BULLET = /^[-*]\s+(.*)$/;
/** A screenshot paragraph. Only images from this repository are shown — the
 *  CSP allows nothing else, and the release body is the only source. */
const IMAGE = /^!\[[^\]]*\]\((https:\/\/raw\.githubusercontent\.com\/zupit-it\/[^)\s]+)\)$/;

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let category = "";
  let item: ChangelogItem | null = null;
  /** The entry an image paragraph belongs to — it comes after a blank line,
   *  which has already flushed the entry itself. */
  let last: ChangelogItem | null = null;

  const flush = () => {
    if (release && item && (item.title || item.body)) {
      release.items.push(item);
      last = item;
    }
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
      last = null;
      continue;
    }
    if (!release) continue;

    const categoryLine = CATEGORY_HEADING.exec(line);
    if (categoryLine) {
      flush();
      category = categoryLine[1].trim();
      continue;
    }

    // Image paragraphs are written apart from the entry text, after a blank
    // line, so that app versions which predate them skip the line instead of
    // printing raw markdown.
    const image = IMAGE.exec(line.trim());
    if (image) {
      (item ?? last)?.imgs.push(image[1]);
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
        ? { title: titled[1].trim(), body: titled[2].trim(), category, imgs: [] }
        : { title: "", body: text, category, imgs: [] };
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
