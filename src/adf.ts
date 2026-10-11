/**
 * Atlassian Document Format → HTML, for Jira descriptions and comments.
 *
 * The HTML is built here from the JSON tree, every text escaped, so nothing
 * Jira sends is ever injected as markup. Links keep only http(s) and mailto
 * targets and carry `data-ext-link`: the app opens them in the browser.
 *
 * Media nodes only name a media-services id. The caller resolves it to an
 * attachment (`AdfOptions.media`): pictures become `[data-att-img]` holders
 * the panel fills with a downloaded blob, other files `[data-att-file]` chips.
 *
 * Pure, with no DOM or Tauri dependency, so it can be tested on its own.
 */

/** What a media node shows, as the caller resolved it. */
export interface MediaRef {
  /** Attachment id. */
  id: string;
  filename: string;
  /** A picture the webview can show; otherwise a file chip. */
  image: boolean;
  sizeLabel?: string;
  /** Object URL, when the picture is already loaded. */
  src?: string;
}

export interface AdfOptions {
  media?: (attrs: Record<string, unknown>) => MediaRef | null;
}

type MediaMode = "block" | "group" | "inline";

const FILE_ICON = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L8 1.5Z"/><path d="M8 1.5V5h3.5"/></svg>`;

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function attr(node: AdfNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function link(href: string, inner: string): string {
  const url = safeUrl(href);
  return url ? `<a href="${esc(url)}" data-ext-link title="${esc(url)}">${inner}</a>` : inner;
}

function renderText(node: AdfNode): string {
  let html = esc(node.text ?? "");
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "strong": html = `<strong>${html}</strong>`; break;
      case "em": html = `<em>${html}</em>`; break;
      case "code": html = `<code>${html}</code>`; break;
      case "strike": html = `<s>${html}</s>`; break;
      case "underline": html = `<u>${html}</u>`; break;
      case "subsup": html = mark.attrs?.type === "sup" ? `<sup>${html}</sup>` : `<sub>${html}</sub>`; break;
      case "link": html = link(String(mark.attrs?.href ?? ""), html); break;
      default: break;
    }
  }
  return html;
}

let options: AdfOptions = {};

function children(node: AdfNode, mode?: MediaMode): string {
  return (node.content ?? []).map((child) => renderNode(child, mode)).join("");
}

function fileChip(ref: MediaRef): string {
  return `<button type="button" class="adf-file" data-att-file="${esc(ref.id)}" title="Apri ${esc(ref.filename)} nel browser">${FILE_ICON}<span class="adf-file-name">${esc(ref.filename)}</span>${ref.sizeLabel ? `<span class="adf-file-size">${esc(ref.sizeLabel)}</span>` : ""}</button>`;
}

function renderMedia(node: AdfNode, mode: MediaMode): string {
  const attrs = node.attrs ?? {};
  const ref = options.media?.(attrs) ?? null;
  if (!ref) {
    const url = attr(node, "type") === "external" ? safeUrl(attr(node, "url")) : null;
    if (url) return link(url, "Immagine esterna");
    return `<span class="adf-media">Allegato non disponibile qui</span>`;
  }
  if (!ref.image || mode === "inline") return fileChip(ref);
  const width = Number(attrs.width) || 0;
  const height = Number(attrs.height) || 0;
  // The original size reserves the space: the text does not jump when it loads.
  const box = mode === "block" && width > 0 && height > 0 ? ` style="aspect-ratio:${width} / ${height};max-width:${width}px"` : "";
  const img = ref.src ? `<img src="${esc(ref.src)}" alt="${esc(ref.filename)}" draggable="false">` : "";
  return `<button type="button" class="adf-img${mode === "group" ? " adf-img--tile" : ""}${ref.src ? "" : " is-loading"}" data-att-img="${esc(ref.id)}" title="${esc(ref.filename)}"${box}>${img}</button>`;
}

function plainText(node: AdfNode): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(plainText).join("");
}

const PANEL_TYPES = new Set(["info", "note", "warning", "error", "success", "tip"]);
const STATUS_COLORS = new Set(["neutral", "purple", "blue", "red", "yellow", "green"]);

function renderNode(node: AdfNode, mode: MediaMode = "inline"): string {
  switch (node.type) {
    case "doc":
      return children(node);
    case "text":
      return renderText(node);
    case "paragraph":
      return `<p>${children(node) || "&nbsp;"}</p>`;
    case "hardBreak":
      return "<br>";
    case "heading": {
      // Headings sit inside a side panel: h4–h6 keep them in proportion.
      const level = Math.min(6, Math.max(4, Number(node.attrs?.level ?? 1) + 3));
      return `<h${level}>${children(node)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${children(node)}</ul>`;
    case "orderedList": {
      const start = Number(node.attrs?.order ?? 1);
      return `<ol${start > 1 ? ` start="${start}"` : ""}>${children(node)}</ol>`;
    }
    case "listItem":
      return `<li>${children(node)}</li>`;
    case "taskList":
      return `<ul class="adf-tasks">${children(node)}</ul>`;
    case "taskItem": {
      const done = node.attrs?.state === "DONE";
      return `<li class="adf-task${done ? " is-done" : ""}"><span class="adf-task-box" aria-hidden="true"></span><span>${children(node)}</span></li>`;
    }
    case "decisionList":
      return `<ul class="adf-tasks">${children(node)}</ul>`;
    case "decisionItem":
      return `<li class="adf-task"><span class="adf-decision" aria-hidden="true">◆</span><span>${children(node)}</span></li>`;
    case "codeBlock":
      return `<pre class="adf-code"><code>${esc(plainText(node))}</code></pre>`;
    case "blockquote":
      return `<blockquote>${children(node)}</blockquote>`;
    case "rule":
      return "<hr>";
    case "panel": {
      const type = attr(node, "panelType");
      return `<div class="adf-panel adf-panel--${PANEL_TYPES.has(type) ? type : "info"}">${children(node)}</div>`;
    }
    case "expand":
    case "nestedExpand":
      return `<details class="adf-expand"><summary>${esc(attr(node, "title") || "Dettagli")}</summary>${children(node)}</details>`;
    case "table":
      return `<div class="adf-table"><table><tbody>${children(node)}</tbody></table></div>`;
    case "tableRow":
      return `<tr>${children(node)}</tr>`;
    case "tableHeader":
      return `<th>${children(node)}</th>`;
    case "tableCell":
      return `<td>${children(node)}</td>`;
    case "mention":
      return `<span class="adf-mention">${esc(attr(node, "text") || "@utente")}</span>`;
    case "emoji":
      return esc(attr(node, "text") || attr(node, "shortName"));
    case "status": {
      const color = attr(node, "color");
      return `<span class="adf-status adf-status--${STATUS_COLORS.has(color) ? color : "neutral"}">${esc(attr(node, "text"))}</span>`;
    }
    case "date": {
      const timestamp = Number(attr(node, "timestamp"));
      return Number.isFinite(timestamp) && timestamp > 0
        ? esc(new Date(timestamp).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" }))
        : "";
    }
    case "inlineCard":
    case "blockCard":
    case "embedCard": {
      const url = attr(node, "url");
      const card = link(url, esc(url));
      return node.type === "inlineCard" ? card : `<p>${card}</p>`;
    }
    case "mediaSingle":
      return `<figure class="adf-figure">${children(node, "block")}</figure>`;
    case "caption":
      return `<figcaption>${children(node)}</figcaption>`;
    case "mediaGroup":
      return `<div class="adf-files">${children(node, "group")}</div>`;
    case "media":
      return renderMedia(node, mode);
    case "mediaInline":
      return renderMedia(node, "inline");
    default:
      // Unknown block: keep whatever text it holds rather than dropping it.
      return node.content ? children(node) : node.text ? esc(node.text) : "";
  }
}

/** HTML for an ADF document; "" when it holds nothing. Plain strings (Jira
 *  Server's wiki text) are shown as escaped paragraphs. */
export function adfToHtml(doc: unknown, adfOptions: AdfOptions = {}): string {
  if (typeof doc === "string") {
    return doc
      .split(/\n{2,}/)
      .filter((block) => block.trim())
      .map((block) => `<p>${esc(block).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }
  if (!doc || typeof doc !== "object") return "";
  options = adfOptions;
  try {
    const html = renderNode(doc as AdfNode);
    return html.replace(/(<p>&nbsp;<\/p>)+$/g, "");
  } finally {
    options = {};
  }
}
