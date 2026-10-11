import { test } from "node:test";
import assert from "node:assert/strict";

import { adfToHtml, safeUrl, type MediaRef } from "../src/adf.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks: unknown[] = []) => ({ type: "text", text: value, marks });

test("text is escaped and marks nest", () => {
  const html = adfToHtml(doc(p(text("<b>hi</b> "), text("bold", [{ type: "strong" }, { type: "em" }]))));
  assert.equal(html, "<p>&lt;b&gt;hi&lt;/b&gt; <em><strong>bold</strong></em></p>");
});

test("links keep only http(s) and mailto targets", () => {
  const ok = adfToHtml(doc(p(text("site", [{ type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } }]))));
  assert.match(ok, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" data-ext-link/);
  const bad = adfToHtml(doc(p(text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))));
  assert.equal(bad, "<p>x</p>");
  assert.equal(safeUrl(" mailto:a@b.it "), "mailto:a@b.it");
  assert.equal(safeUrl("data:text/html,x"), null);
});

test("lists, headings, code and quotes", () => {
  const html = adfToHtml(
    doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Criteri")] },
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("uno"))] }] },
      { type: "orderedList", attrs: { order: 3 }, content: [{ type: "listItem", content: [p(text("tre"))] }] },
      { type: "codeBlock", content: [text("let a = <T>() => 1;")] },
      { type: "blockquote", content: [p(text("citazione"))] },
    ),
  );
  assert.ok(html.includes("<h5>Criteri</h5>"));
  assert.ok(html.includes("<ul><li><p>uno</p></li></ul>"));
  assert.ok(html.includes('<ol start="3">'));
  assert.ok(html.includes("<pre class=\"adf-code\"><code>let a = &lt;T&gt;() =&gt; 1;</code></pre>"));
  assert.ok(html.includes("<blockquote><p>citazione</p></blockquote>"));
});

test("mentions, status lozenges, tasks and media", () => {
  const html = adfToHtml(
    doc(
      p({ type: "mention", attrs: { text: "@Sara" } }, { type: "status", attrs: { text: "BLOCCATO", color: "red" } }),
      { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("fatto")] }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] },
    ),
  );
  assert.ok(html.includes('<span class="adf-mention">@Sara</span>'));
  assert.ok(html.includes('adf-status--red">BLOCCATO'));
  assert.ok(html.includes('class="adf-task is-done"'));
  assert.ok(html.includes("Allegato non disponibile qui"));
});

test("media resolve to pictures, tiles and file chips", () => {
  const refs: Record<string, MediaRef> = {
    "uuid-a": { id: "101", filename: "shot.png", image: true },
    "uuid-b": { id: "102", filename: "spec.pdf", image: false, sizeLabel: "2 MB" },
    "uuid-c": { id: "103", filename: "<x>.png", image: true, src: "blob:abc" },
  };
  const media = (attrs: Record<string, unknown>) => refs[String(attrs.id)] ?? null;
  const html = adfToHtml(
    doc(
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "uuid-a", width: 1600, height: 900 } }, { type: "caption", content: [text("Dashboard")] }] },
      { type: "mediaGroup", content: [{ type: "media", attrs: { id: "uuid-b" } }, { type: "media", attrs: { id: "uuid-c" } }] },
      p(text("vedi "), { type: "mediaInline", attrs: { id: "uuid-a" } }),
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "unknown" } }] },
    ),
    { media },
  );
  assert.ok(html.includes('class="adf-img is-loading" data-att-img="101"'), "a picture not loaded yet waits");
  assert.ok(html.includes('style="aspect-ratio:1600 / 900;max-width:1600px"'), "its size is reserved");
  assert.ok(html.includes("<figcaption>Dashboard</figcaption>"));
  assert.ok(html.includes('data-att-file="102"') && html.includes("2 MB"), "a PDF is a file chip");
  assert.ok(html.includes('class="adf-img adf-img--tile" data-att-img="103"'), "a picture in a group is a tile");
  assert.ok(html.includes('<img src="blob:abc" alt="&lt;x&gt;.png"'), "a loaded picture is shown, its name escaped");
  assert.ok(html.includes('<p>vedi <button type="button" class="adf-file" data-att-file="101"'), "inline media are chips");
  assert.ok(html.includes("Allegato non disponibile qui"), "an unresolved node says so");
});

test("without a resolver media stay a note", () => {
  const html = adfToHtml(doc({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] }));
  assert.ok(html.includes("Allegato non disponibile qui"));
  assert.ok(!html.includes("data-att-img"));
});

test("empty or odd input", () => {
  assert.equal(adfToHtml(null), "");
  assert.equal(adfToHtml(doc()), "");
  assert.equal(adfToHtml("riga uno\nriga due\n\nsecondo <p>"), "<p>riga uno<br>riga due</p><p>secondo &lt;p&gt;</p>");
  assert.equal(adfToHtml(doc({ type: "unknownBlock", content: [text("salvato")] })), "salvato");
});
