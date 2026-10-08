/**
 * Review-comment Markdown, as far as the diff view needs it: fenced code (a
 * ```suggestion block shows as a suggested change, as on GitHub), `code`,
 * **bold** and links. Comments come from other people, so everything is
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

/** Prose: code spans stay literal, the rest gets bold and links. */
function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(LINK, (match: string, label?: string, url?: string) => (label && url ? link(url, label) : bareLink(match)));
  }).join("");
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
