/**
 * The comment editor's formatting buttons, as GitHub's: each takes the text
 * and its selection and says what to put where, and what to select after.
 * Pure, so the node tests load it; the view applies the edit so ⌘Z undoes it.
 */

export type MdFormat =
  | "bold" | "italic" | "strike" | "code" | "link"
  | "quote" | "bullets" | "numbers" | "tasks" | "suggestion";

export interface MdSelection {
  value: string;
  start: number;
  end: number;
}

/** Replace value[from, to) with `text`, then select [selStart, selEnd) of the result. */
export interface MdEdit {
  from: number;
  to: number;
  text: string;
  selStart: number;
  selEnd: number;
}

const WRAPS: Partial<Record<MdFormat, string>> = { bold: "**", italic: "_", strike: "~~", code: "`" };
const PREFIXES: Partial<Record<MdFormat, (i: number) => string>> = {
  quote: () => "> ",
  bullets: () => "- ",
  numbers: (i) => `${i + 1}. `,
  tasks: () => "- [ ] ",
};
/** What a line's prefix looks like, whatever its number: to take it off again. */
const PREFIX_OF: Partial<Record<MdFormat, RegExp>> = {
  quote: /^> ?/,
  bullets: /^[-*+] (?!\[[ xX]\] )/,
  numbers: /^\d+[.)] /,
  tasks: /^[-*+] \[[ xX]\] /,
};

/** Wraps the selection in `mark`, or unwraps it when it already is. With nothing
 *  selected, leaves the caret between the marks. */
function wrap({ value, start, end }: MdSelection, mark: string): MdEdit {
  const selected = value.slice(start, end);
  const n = mark.length;
  if (value.slice(start - n, start) === mark && value.slice(end, end + n) === mark) {
    return { from: start - n, to: end + n, text: selected, selStart: start - n, selEnd: end - n };
  }
  if (selected.length > 2 * n && selected.startsWith(mark) && selected.endsWith(mark)) {
    const inner = selected.slice(n, -n);
    return { from: start, to: end, text: inner, selStart: start, selEnd: start + inner.length };
  }
  return { from: start, to: end, text: mark + selected + mark, selStart: start + n, selEnd: end + n };
}

/** Code: a span on one line, a fenced block over several. */
function code(sel: MdSelection): MdEdit {
  const selected = sel.value.slice(sel.start, sel.end);
  if (!selected.includes("\n")) return wrap(sel, "`");
  const block = blockAround(sel.value, sel.start, sel.end, "```\n" + selected + "\n```");
  return { ...block, selStart: block.selStart + 4, selEnd: block.selStart + 4 + selected.length };
}

/** [text](url), the url selected to be typed over; or the url as the target
 *  when that is what was selected. */
function link({ value, start, end }: MdSelection): MdEdit {
  const selected = value.slice(start, end);
  if (/^https?:\/\/\S+$/.test(selected)) {
    const text = `[](${selected})`;
    return { from: start, to: end, text, selStart: start + 1, selEnd: start + 1 };
  }
  const text = `[${selected}](url)`;
  const url = start + selected.length + 3;
  return { from: start, to: end, text, selStart: url, selEnd: url + 3 };
}

/** The whole lines the selection touches, prefixed; or unprefixed when each
 *  already is. */
function prefix({ value, start, end }: MdSelection, format: MdFormat): MdEdit {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const has = PREFIX_OF[format] as RegExp;
  const add = PREFIXES[format] as (i: number) => string;
  const off = lines.every((line) => has.test(line));
  const text = lines.map((line, i) => (off ? line.replace(has, "") : add(i) + line)).join("\n");
  // Nothing selected: the caret stays on its text, after the new prefix.
  if (start === end) {
    const caret = Math.max(lineStart, start + (text.length - (lineEnd - lineStart)));
    return { from: lineStart, to: lineEnd, text, selStart: caret, selEnd: caret };
  }
  return { from: lineStart, to: lineEnd, text, selStart: lineStart, selEnd: lineStart + text.length };
}

/** `text` on lines of its own: a blank line before and after unless at an edge. */
function blockAround(value: string, start: number, end: number, text: string): MdEdit {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after === "" ? "" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const at = start + lead.length;
  return { from: start, to: end, text: lead + text + tail, selStart: at, selEnd: at + text.length };
}

/** A ```suggestion block with the lines' code to edit, on lines of its own. */
function suggestion({ value, start, end }: MdSelection, code: string): MdEdit {
  const block = blockAround(value, start, end, "```suggestion\n" + code + "\n```");
  const first = block.selStart + "```suggestion\n".length;
  return { ...block, selStart: first, selEnd: first + code.length };
}

/**
 * What `format` does to `sel`. `code` is the commented lines' code, for a
 * suggestion; without it there is no suggestion to make.
 */
export function formatMarkdown(format: MdFormat, sel: MdSelection, codeLines?: string | null): MdEdit | null {
  if (format === "suggestion") return codeLines === null || codeLines === undefined ? null : suggestion(sel, codeLines);
  if (format === "code") return code(sel);
  if (format === "link") return link(sel);
  const mark = WRAPS[format];
  if (mark) return wrap(sel, mark);
  return prefix(sel, format);
}

/** ⌘B, ⌘I, ⌘E and ⌘K, as on GitHub. */
export const MD_SHORTCUTS: Record<string, MdFormat> = { b: "bold", i: "italic", e: "code", k: "link" };
