// ── Comment editor ────────────────────────────────────────────────────────────
// Every comment written in the diff view: Write and Preview, as on GitHub, and
// buttons for the Markdown GitHub reads (md-format.ts does the editing, the
// view wires the buttons). In meme mode the sad reviewer peeks over its top
// edge, his eyes on the caret, taking no room from the text.

import type { MdFormat } from "./md-format";
import { sadReviewer } from "./meme";

const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
const MOD = isMac ? "⌘" : "Ctrl+";

/** 16 × 16 strokes, drawn in the text colour. */
const icon = (paths: string) =>
  `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const TOOLS: Array<{ format: MdFormat; label: string; keys?: string; body: string } | "|"> = [
  { format: "bold", label: "Bold", keys: "B", body: `<b>B</b>` },
  { format: "italic", label: "Italic", keys: "I", body: `<i>I</i>` },
  { format: "strike", label: "Strikethrough", body: `<s>S</s>` },
  "|",
  { format: "code", label: "Code", keys: "E", body: icon(`<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>`) },
  { format: "link", label: "Link", keys: "K", body: icon(`<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.2 9.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/>`) },
  { format: "quote", label: "Quote", body: icon(`<path d="M3 4v8M6 5h7M6 8h7M6 11h4"/>`) },
  "|",
  { format: "bullets", label: "Bulleted list", body: icon(`<circle cx="3" cy="4.5" r=".6" fill="currentColor"/><circle cx="3" cy="8" r=".6" fill="currentColor"/><circle cx="3" cy="11.5" r=".6" fill="currentColor"/><path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/>`) },
  { format: "numbers", label: "Numbered list", body: icon(`<path d="M2.5 3.5h1v3M2.5 6.5h2M2.4 9.6c.3-.5 1.9-.6 1.9.4 0 .8-1.9 1.3-1.9 2.5h2"/><path d="M7 4.5h6.5M7 8h6.5M7 11.5h6.5"/>`) },
  { format: "tasks", label: "Task list", body: icon(`<rect x="2" y="3" width="4" height="4" rx="1"/><path d="m2.8 11 1 1 1.7-2"/><path d="M8.5 5h5M8.5 11h5"/>`) },
];

const SUGGEST_BUTTON =
  `<button class="pd-cbox__suggest" type="button" data-pd-format="suggestion" ` +
  `title="Suggest a change: the commented lines, ready to edit">` +
  icon(`<path d="M4 2.5v11M12 2.5v6M12 11v2.5M10 12.2h4M2.2 5.5h3.6M2.2 10.5h3.6"/>`) +
  `<span>Suggest</span></button>`;

function tools(suggest: boolean): string {
  return TOOLS.map((tool) =>
    tool === "|"
      ? `<span class="pd-cbox__sep" aria-hidden="true"></span>`
      : `<button type="button" data-pd-format="${tool.format}" ` +
        `title="${tool.label}${tool.keys ? ` (${MOD}${tool.keys})` : ""}" aria-label="${tool.label}">${tool.body}</button>`,
  ).join("") + (suggest ? SUGGEST_BUTTON : "");
}

/**
 * `textarea` with its tabs and buttons around it. `suggest` when the comment is
 * on lines of the new code: a suggestion can only change those.
 */
export function commentBox(textarea: string, { suggest = false } = {}): string {
  const face = sadReviewer();
  return `<div class="pd-cbox${face ? " pd-cbox--face" : ""}">` +
    face +
    `<div class="pd-cbox__bar">` +
      `<div class="pd-cbox__tabs" role="tablist">` +
        `<button type="button" role="tab" class="is-on" aria-selected="true" data-pd-tab="write">Write</button>` +
        `<button type="button" role="tab" aria-selected="false" data-pd-tab="preview">Preview</button>` +
      `</div>` +
      `<div class="pd-cbox__tools" role="toolbar" aria-label="Formatting">${tools(suggest)}</div>` +
    `</div>` +
    textarea +
    `<div class="pd-cbox__preview pd-ai-card__body" hidden></div>` +
  `</div>`;
}
