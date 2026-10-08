import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alignSides, hunkFor, hunkSides, hunkTail, isGeneratedFile, languageFor, layerOrder, parsePatch, pathTree, sameCode,
  splitRows, treeOrder, withAgentOrder,
} from "../src/pr-diff-parse.ts";

test("the tail of a GitHub diff hunk is the code a comment was written on", () => {
  const hunk = "@@ -10,4 +10,5 @@ class A {\n ctx\n-old\n+new1\n+new2\n ctx2";
  assert.deepEqual(
    hunkTail(hunk, 2).map(l => [l.kind, l.oldNo, l.newNo, l.text]),
    [["add", null, 12, "new2"], ["ctx", 12, 13, "ctx2"]],
  );
  assert.equal(hunkTail(hunk, 10).length, 5);
  assert.deepEqual(hunkTail("", 4), []);
});

const PATCH = [
  "@@ -10,4 +10,5 @@ export class UserCard {",
  "   name = input.required<string>();",
  "-  age = 0;",
  "+  age = input(0);",
  "+  role = input<string>();",
  "   constructor() {}",
  "@@ -40 +41 @@",
  "-old",
  "+new",
  "\\ No newline at end of file",
].join("\n");

test("hunk headers set the line numbers of both sides", () => {
  const [first, second] = parsePatch(PATCH);
  assert.equal(first.section, "export class UserCard {");
  assert.deepEqual(
    first.lines.map(l => [l.kind, l.oldNo, l.newNo]),
    [["ctx", 10, 10], ["del", 11, null], ["add", null, 11], ["add", null, 12], ["ctx", 12, 13]],
  );
  assert.equal(first.lines[1].text, "  age = 0;");
  // A count left out of the header means one line.
  assert.deepEqual([second.oldStart, second.oldCount, second.newStart, second.newCount], [40, 1, 41, 1]);
});

test("the no-newline marker is not a line of code", () => {
  const [, second] = parsePatch(PATCH);
  assert.deepEqual(second.lines.map(l => l.text), ["old", "new"]);
});

test("a trailing newline does not add an empty context line", () => {
  const [hunk] = parsePatch("@@ -1 +1 @@\n-a\n+b\n");
  assert.equal(hunk.lines.length, 2);
});

test("an empty context line keeps its place", () => {
  const [hunk] = parsePatch("@@ -1,3 +1,3 @@\n a\n \n-b\n+c");
  assert.deepEqual(hunk.lines.map(l => [l.kind, l.text]), [["ctx", "a"], ["ctx", ""], ["del", "b"], ["add", "c"]]);
});

test("each side holds only the code that existed in that file", () => {
  const [hunk] = parsePatch(PATCH);
  const sides = hunkSides(hunk);
  assert.equal(sides.old, "  name = input.required<string>();\n  age = 0;\n  constructor() {}");
  assert.equal(sides.new, "  name = input.required<string>();\n  age = input(0);\n  role = input<string>();\n  constructor() {}");
});

test("aligned sides follow the diff order", () => {
  const [hunk] = parsePatch(PATCH);
  const oldSide = ["o:name", "o:age", "o:ctor"];
  const newSide = ["n:name", "n:age", "n:role", "n:ctor"];
  assert.deepEqual(alignSides(hunk, oldSide, newSide), ["n:name", "o:age", "n:age", "n:role", "n:ctor"]);
});

test("languages follow the stack: Angular, .NET, Python, Java", () => {
  assert.equal(languageFor("src/app/user/user-card.component.ts"), "angular-ts");
  assert.equal(languageFor("src/app/user/user-card.component.html"), "angular-html");
  assert.equal(languageFor("src/styles/_vars.scss"), "scss");
  assert.equal(languageFor("Api/Controllers/UsersController.cs"), "csharp");
  assert.equal(languageFor("Api/Views/Home/Index.cshtml"), "razor");
  assert.equal(languageFor("Api/Api.csproj"), "xml");
  assert.equal(languageFor("tsconfig.app.json"), "jsonc");
  assert.equal(languageFor("appsettings.Development.json"), "json");
  assert.equal(languageFor("deploy/Dockerfile"), "docker");
  assert.equal(languageFor("tools/seed.py"), "python");
  assert.equal(languageFor("README"), null);
  assert.equal(languageFor(".gitignore"), null);
  assert.equal(languageFor("assets/logo.png"), null);
});

test("lockfiles, bundles and EF snapshots count as generated", () => {
  assert.ok(isGeneratedFile("package-lock.json"));
  assert.ok(isGeneratedFile("web/pnpm-lock.yaml"));
  assert.ok(isGeneratedFile("Api/Migrations/AppDbContextModelSnapshot.cs"));
  assert.ok(isGeneratedFile("Api/Migrations/20260101_Init.Designer.cs"));
  assert.ok(isGeneratedFile("vendor/chart.min.js"));
  assert.ok(!isGeneratedFile("src/app/lock.service.ts"));
  assert.ok(!isGeneratedFile("Api/Migrations/20260101_Init.cs"));
});

test("layer order puts contracts first, tests and generated files last", () => {
  const groups = layerOrder([
    "package-lock.json",
    "src/app/users/user-list.component.scss",
    "src/app/users/user-list.component.spec.ts",
    "src/app/users/user-list.component.html",
    "src/app/users/user-list.component.ts",
    "src/app/users/user.service.ts",
    "src/app/users/user.model.ts",
    "Api/Controllers/UsersController.cs",
    "Api/Dtos/UserDto.cs",
    "Api/Migrations/20260101_AddRole.cs",
    "Api/Services/IUserService.cs",
    "angular.json",
  ]);
  assert.deepEqual(groups.map(g => g.title), [
    "Models & contracts", "Data access", "Logic", "API", "UI", "Tests", "Config & other", "Generated",
  ]);
  assert.deepEqual(groups[0].files, ["Api/Dtos/UserDto.cs", "Api/Services/IUserService.cs", "src/app/users/user.model.ts"]);
  // A component's files stay together: logic, template, styles.
  assert.deepEqual(groups[4].files, [
    "src/app/users/user-list.component.ts",
    "src/app/users/user-list.component.html",
    "src/app/users/user-list.component.scss",
  ]);
});

test("the agent's order comes first and nothing is lost", () => {
  const paths = ["a.service.ts", "b.component.ts", "c.model.ts", "README.md"];
  const groups = withAgentOrder(
    [
      { title: "Start here", why: "the bug", files: ["b.component.ts", "ghost.ts"] },
      { title: "Then", why: "", files: ["b.component.ts", "a.service.ts"] },
    ],
    paths,
  );
  assert.deepEqual(groups.map(g => [g.title, g.files]), [
    ["Start here", ["b.component.ts"]],
    ["Then", ["a.service.ts"]],
    ["Other files", ["c.model.ts", "README.md"]],
  ]);
});

test("side by side pairs each removed run with the run that replaces it", () => {
  const [hunk] = parsePatch("@@ -1,6 +1,6 @@\n a\n-b\n-c\n+B\n d\n-e\n+E\n+F\n+G\n-h");
  const text = (l: { text: string } | null) => l?.text ?? "·";
  assert.deepEqual(
    splitRows(hunk).map(r => `${text(r.left)}|${text(r.right)}`),
    ["a|a", "b|B", "c|·", "d|d", "e|E", "·|F", "·|G", "h|·"],
  );
});

test("a comment's code is cut from its hunk like GitHub's diffHunk, ending on its last line", () => {
  const [hunk] = parsePatch(PATCH);
  assert.equal(
    hunkFor([hunk], "new", 12, null, 1),
    "@@ -12,0 +11,2 @@\n+  age = input(0);\n+  role = input<string>();",
  );
  assert.equal(hunkFor([hunk], "old", 11, null), "@@ -10,2 +10,1 @@\n   name = input.required<string>();\n-  age = 0;");
  assert.equal(hunkFor([hunk], "new", 99, null), null);
});

test("on a newer commit a comment stays under its line only while its code is the same", () => {
  const [hunk] = parsePatch(PATCH);
  const current = parsePatch(PATCH).flatMap(h => h.lines);
  const onRole = hunkFor([hunk], "new", 11, 12) ?? "";
  assert.ok(sameCode(onRole, "new", 11, 12, current));
  const pushed = parsePatch([
    "@@ -10,4 +10,5 @@",
    "   name = input.required<string>();",
    "-  age = 0;",
    "+  age = input(0);",
    "+  role = input<'admin' | 'user'>();",
    "   constructor() {}",
  ].join("\n")).flatMap(h => h.lines);
  assert.ok(!sameCode(onRole, "new", 11, 12, pushed));
  // Removed lines are compared on the base side.
  assert.ok(sameCode(hunkFor([hunk], "old", 11, null) ?? "", "old", 11, null, pushed));
});

test("the files group into folders as on GitHub: folders first, lone folders as one row", () => {
  const tree = pathTree([
    "src/app/transfers/transfer.service.ts",
    "README.md",
    "src/app/transfers/schedule/schedule.component.ts",
    "src/app/transfers/transfer.model.ts",
    "src/app/app.config.ts",
    "src/app/transfers/schedule/schedule.component.html",
    "docs/item10.md",
    "docs/item9.md",
  ]);
  const shape = (node: ReturnType<typeof pathTree>): unknown => ({
    name: node.name, dirs: node.dirs.map(shape), files: node.files.map(f => f.slice(f.lastIndexOf("/") + 1)),
  });
  assert.deepEqual(shape(tree), {
    name: "", files: ["README.md"], dirs: [
      { name: "docs", dirs: [], files: ["item9.md", "item10.md"] },
      { name: "src/app", files: ["app.config.ts"], dirs: [
        { name: "transfers", files: ["transfer.model.ts", "transfer.service.ts"], dirs: [
          { name: "schedule", dirs: [], files: ["schedule.component.html", "schedule.component.ts"] },
        ] },
      ] },
    ],
  });
  assert.equal(tree.dirs[1].path, "src/app");
  assert.equal(tree.dirs[1].dirs[0].path, "src/app/transfers");
  // The diff follows the tree, so the sidebar and the files read in the same order.
  assert.deepEqual(treeOrder(tree), [
    "docs/item9.md", "docs/item10.md",
    "src/app/transfers/schedule/schedule.component.html", "src/app/transfers/schedule/schedule.component.ts",
    "src/app/transfers/transfer.model.ts", "src/app/transfers/transfer.service.ts",
    "src/app/app.config.ts",
    "README.md",
  ]);
  assert.deepEqual(treeOrder(pathTree([])), []);
});
