import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMarkdown, type MdEdit, type MdFormat } from "../src/md-format.ts";

/** `[` and `]` mark the selection, in and out: "a [b] c" selects b. */
function run(format: MdFormat, marked: string, code?: string | null): string | null {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  const value = marked.replace("[", "").replace("]", "");
  const edit: MdEdit | null = formatMarkdown(format, { value, start, end }, code);
  if (!edit) return null;
  const out = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
  return out.slice(0, edit.selStart) + "[" + out.slice(edit.selStart, edit.selEnd) + "]" + out.slice(edit.selEnd);
}

test("wrapping marks go around the selection, and come off again", () => {
  assert.equal(run("bold", "make [this] loud"), "make **[this]** loud");
  assert.equal(run("bold", "make **[this]** loud"), "make [this] loud");
  assert.equal(run("bold", "make [**this**] loud"), "make [this] loud");
  assert.equal(run("italic", "an [] here"), "an _[]_ here");
  assert.equal(run("strike", "[old]"), "~~[old]~~");
});

test("code is a span on one line, a fence over several", () => {
  assert.equal(run("code", "call [foo()] now"), "call `[foo()]` now");
  assert.equal(run("code", "see:\n[a\nb]"), "see:\n\n```\n[a\nb]\n```");
});

test("a link selects its url to type over, or takes the selected url", () => {
  assert.equal(run("link", "read [the docs] first"), "read [the docs]([url]) first");
  assert.equal(run("link", "at [https://x.dev/a]"), "at [[]](https://x.dev/a)");
});

test("line prefixes cover every line the selection touches, and come off again", () => {
  assert.equal(run("quote", "he said[]"), "> he said[]");
  assert.equal(run("bullets", "[one\ntwo]"), "[- one\n- two]");
  assert.equal(run("numbers", "x\n[one\ntwo]\ny"), "x\n[1. one\n2. two]\ny");
  assert.equal(run("tasks", "[a]"), "[- [ ] a]");
  assert.equal(run("bullets", "[- one\n- two]"), "[one\ntwo]");
  assert.equal(run("quote", "[> a\n> b]"), "[a\nb]");
});

test("a suggestion holds the commented code, selected, on lines of its own", () => {
  assert.equal(
    run("suggestion", "Better:[]", "  const a = 1;"),
    "Better:\n\n```suggestion\n[  const a = 1;]\n```",
  );
  assert.equal(run("suggestion", "[]", "x"), "```suggestion\n[x]\n```");
  assert.equal(run("suggestion", "[]", null), null);
});
