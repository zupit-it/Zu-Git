/**
 * Review-comment Markdown, as far as the diff view needs it: fenced code (a
 * ```suggestion block shows as a suggested change, as on GitHub), `code`,
 * **bold**, _italic_, ~~struck~~, links, > quotes, - and 1. lists, - [ ] task
 * lists and # headings. Comments come from other people, so everything is
 * escaped first; a link is a data attribute the view opens through
 * open_external, which takes http(s) only. No imports: the node tests load it.
 */

/** utils.escHtml, repeated so this module stays importable on its own. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FENCE_OPEN = /^\s*```\s*([\w-]*)/;
const FENCE_CLOSE = /^\s*```\s*$/;
/** [label](https://…) or a bare https://… — run on escaped text, so quotes are entities already. */
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<)]+/g;

export function suggestionBlock(code: string): string {
  return `<div class="pd-ai-suggestion"><div class="pd-ai-suggestion__label">Suggested change</div><pre>${esc(code)}</pre></div>`;
}

/** Punctuation and quotes that end a sentence, not the bare URL before them. */
const URL_TAIL = /(?:&quot;|&gt;|[.,;:!?'])+$/;

function link(url: string, label: string): string {
  return `<a class="pd-md-link" href="#" data-pd-link="${url}" title="${url}">${label}</a>`;
}

function bareLink(match: string): string {
  const tail = URL_TAIL.exec(match)?.[0] ?? "";
  const url = match.slice(0, match.length - tail.length);
  return link(url, url) + tail;
}

/** Prose: code spans stay literal, the rest gets emphasis and links. Italic
 *  needs a word boundary around it, so snake_case and 2*3*4 stay as they are. */
function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^\w*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(LINK, (match: string, label?: string, url?: string) => (label && url ? link(url, label) : bareLink(match)));
  }).join("");
}

const QUOTE = /^\s*>\s?(.*)$/;
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;

/** One list's items, numbered or not as its first one is. */
function list(items: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  const lis = items.map((item) => {
    const task = TASK.exec(item);
    if (!task) return `<li>${inline(item)}</li>`;
    const done = task[1] !== " ";
    return `<li class="pd-md-task"><input type="checkbox" disabled${done ? " checked" : ""}> ${inline(task[2])}</li>`;
  });
  return `<${tag} class="pd-md-list">${lis.join("")}</${tag}>`;
}

export function renderMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    const block = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (block) html.push(`<div class="pd-md-p">${inline(block)}</div>`);
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (QUOTE.test(lines[i])) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(QUOTE.exec(lines[i])?.[1] ?? "");
      i--;
      html.push(`<blockquote class="pd-md-quote">${renderMarkdown(quoted.join("\n"))}</blockquote>`);
      continue;
    }
    const first = ITEM.exec(lines[i]);
    if (first) {
      flush();
      const ordered = !first[1];
      const items: string[] = [];
      // Items of the same kind; a bullet after numbers starts a list of its own.
      let item: RegExpExecArray | null = first;
      while (item && !item[1] === ordered) {
        items.push(item[3]);
        item = ++i < lines.length ? ITEM.exec(lines[i]) : null;
      }
      i--;
      html.push(list(items, ordered));
      continue;
    }
    const heading = HEADING.exec(lines[i]);
    if (heading) {
      flush();
      html.push(`<div class="pd-md-h">${inline(heading[1])}</div>`);
      continue;
    }
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) { prose.push(lines[i]); continue; }
    flush();
    const code: string[] = [];
    // An unclosed fence runs to the end, as on GitHub.
    while (++i < lines.length && !FENCE_CLOSE.test(lines[i])) code.push(lines[i]);
    html.push(open[1].toLowerCase() === "suggestion"
      ? suggestionBlock(code.join("\n"))
      : `<pre class="pd-md-code">${esc(code.join("\n"))}</pre>`);
  }
  flush();
  return html.join("");
}
