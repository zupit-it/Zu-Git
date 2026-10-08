/**
 * Syntax highlighting for the PR diff view, on Shiki. Everything here is
 * loaded on demand: Shiki itself when the first diff opens, each grammar when
 * a file in that language shows up — the dashboard never pays for it.
 */

import type { HighlighterCore, ThemedToken } from "shiki/core";
import type { DiffLang } from "./pr-diff-parse";

const THEME = "github-light";

const GRAMMARS: Record<DiffLang, () => Promise<unknown>> = {
  "angular-ts":   () => import("shiki/langs/angular-ts.mjs"),
  "angular-html": () => import("shiki/langs/angular-html.mjs"),
  scss:           () => import("shiki/langs/scss.mjs"),
  css:            () => import("shiki/langs/css.mjs"),
  csharp:         () => import("shiki/langs/csharp.mjs"),
  razor:          () => import("shiki/langs/razor.mjs"),
  xml:            () => import("shiki/langs/xml.mjs"),
  json:           () => import("shiki/langs/json.mjs"),
  jsonc:          () => import("shiki/langs/jsonc.mjs"),
  python:         () => import("shiki/langs/python.mjs"),
  java:           () => import("shiki/langs/java.mjs"),
  sql:            () => import("shiki/langs/sql.mjs"),
  yaml:           () => import("shiki/langs/yaml.mjs"),
  markdown:       () => import("shiki/langs/markdown.mjs"),
  shellscript:    () => import("shiki/langs/shellscript.mjs"),
  docker:         () => import("shiki/langs/docker.mjs"),
};

/** Minified one-liners would stall the tokenizer; past this they stay plain. */
const MAX_LINE_LENGTH = 1000;

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<DiffLang, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs")],
      langs: [],
      // The JS engine avoids shipping Oniguruma's WASM; every grammar above runs on it.
      engine: createJavaScriptRegexEngine(),
    });
  })();
  // A failed load (it should not happen, the chunks are local) is retried next time.
  highlighter.catch(() => { highlighter = null; });
  return highlighter;
}

async function ensureLanguage(h: HighlighterCore, lang: DiffLang): Promise<void> {
  let pending = loaded.get(lang);
  if (!pending) {
    pending = GRAMMARS[lang]().then(mod => h.loadLanguage((mod as { default: Parameters<HighlighterCore["loadLanguage"]>[0] }).default));
    pending.catch(() => loaded.delete(lang));
    loaded.set(lang, pending);
  }
  await pending;
}

export type Token = Pick<ThemedToken, "content" | "color" | "fontStyle">;

/** One array of tokens per line of `code`. */
export async function tokenize(code: string, lang: DiffLang): Promise<Token[][]> {
  const h = await getHighlighter();
  await ensureLanguage(h, lang);
  return h.codeToTokensBase(code, { lang, theme: THEME, tokenizeMaxLineLength: MAX_LINE_LENGTH });
}
