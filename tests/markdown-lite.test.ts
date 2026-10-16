import { test } from "node:test";
import assert from "node:assert/strict";

import { renderMarkdown } from "../src/markdown-lite.ts";

test("comment text is escaped: no tag or attribute gets through", () => {
  const html = renderMarkdown(`<img src=x onerror="alert(1)"> & <script>x</script>`);
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;script&gt;"));
});

test("code spans and fences stay literal", () => {
  assert.equal(renderMarkdown("use `<b>` here"), `<div class="pd-md-p">use <code>&lt;b&gt;</code> here</div>`);
  assert.equal(
    renderMarkdown("before\n```ts\nconst a = '<x>';\n```\nafter"),
    `<div class="pd-md-p">before</div><pre class="pd-md-code">const a = '&lt;x&gt;';</pre><div class="pd-md-p">after</div>`,
  );
});

test("a suggestion block reads as a suggested change", () => {
  const html = renderMarkdown("Try:\n```suggestion\n  role = input.required<string>();\n```");
  assert.ok(html.includes("Suggested change"));
  assert.ok(html.includes("role = input.required&lt;string&gt;();"));
});

test("only http(s) links become links, and quotes cannot leave the attribute", () => {
  const html = renderMarkdown(
    `See [docs](https://example.com/a?b=1&c=2), https://x.dev/p. Not [this](javascript:alert(1)) nor javascript:alert(1). "https://q.io/"`,
  );
  assert.ok(html.includes(`data-pd-link="https://example.com/a?b=1&amp;c=2"`));
  // Sentence punctuation and quotes stay out of a bare link.
  assert.ok(html.includes(`data-pd-link="https://x.dev/p"`));
  assert.ok(html.includes(`data-pd-link="https://q.io/"`));
  assert.ok(!html.includes(`data-pd-link="javascript`));
  assert.equal(html.match(/data-pd-link=/g)?.length, 3);
});

test("bold, and an unclosed fence runs to the end", () => {
  assert.equal(renderMarkdown("**careful**"), `<div class="pd-md-p"><strong>careful</strong></div>`);
  assert.equal(renderMarkdown("```\nopen"), `<pre class="pd-md-code">open</pre>`);
});

test("italic and struck text, but not snake_case or arithmetic", () => {
  assert.equal(
    renderMarkdown("_why_ *here* ~~old~~ a_b_c 2*3*4"),
    `<div class="pd-md-p"><em>why</em> <em>here</em> <del>old</del> a_b_c 2*3*4</div>`,
  );
  assert.equal(renderMarkdown("**bold** and *it*"), `<div class="pd-md-p"><strong>bold</strong> and <em>it</em></div>`);
});

test("quotes nest the rest of the Markdown", () => {
  assert.equal(
    renderMarkdown("> you wrote **this**\n> twice\n\nReply"),
    `<blockquote class="pd-md-quote"><div class="pd-md-p">you wrote <strong>this</strong>\ntwice</div></blockquote><div class="pd-md-p">Reply</div>`,
  );
});

test("lists, numbered or not, and task lists", () => {
  assert.equal(
    renderMarkdown("Steps:\n- one\n- `two`\n1. first\n2) second"),
    `<div class="pd-md-p">Steps:</div><ul class="pd-md-list"><li>one</li><li><code>two</code></li></ul>` +
      `<ol class="pd-md-list"><li>first</li><li>second</li></ol>`,
  );
  assert.equal(
    renderMarkdown("- [ ] tests\n- [x] lint"),
    `<ul class="pd-md-list"><li class="pd-md-task"><input type="checkbox" disabled> tests</li>` +
      `<li class="pd-md-task"><input type="checkbox" disabled checked> lint</li></ul>`,
  );
});

test("a heading is a line of its own, escaped like the rest", () => {
  assert.equal(renderMarkdown("## Note <b>\ntext"), `<div class="pd-md-h">Note &lt;b&gt;</div><div class="pd-md-p">text</div>`);
});
