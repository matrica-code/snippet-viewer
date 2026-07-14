// Unit tests for the snippet extractor. Run with: node --test
//
// These drive extractFromSource() directly (no filesystem) so each case is a
// small, readable source string paired with its expected snippet output. The
// suite covers every documented marker use case across JS/TS/TSX and Java, plus
// regression tests for the annotation/`modifiers` extraction bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { extractFromSource } from "./extractSnippets.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));

// Extract a single source string and return the snippets map.
function extract(source, ext, basename = `Fixture${ext}`) {
  return extractFromSource(source, ext, {}, basename);
}

// Convenience: the sole snippet value, asserting exactly one was produced.
function only(source, ext, basename) {
  const snippets = extract(source, ext, basename);
  const keys = Object.keys(snippets);
  assert.equal(keys.length, 1, `expected exactly one snippet, got: ${keys.join(", ")}`);
  return snippets[keys[0]];
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------
test("keys snippets as <name>@<basename>", () => {
  const snippets = extract(`// extract-code widget\nconst a = 1;\n`, ".ts", "Thing.ts");
  assert.deepEqual(Object.keys(snippets), ["widget@Thing.ts"]);
});

test("the same name in two files does not collide", () => {
  const snippets = {};
  extractFromSource(`// extract-code dup\nconst a = 1;\n`, ".ts", snippets, "A.ts");
  extractFromSource(`// extract-code dup\nconst b = 2;\n`, ".ts", snippets, "B.ts");
  assert.deepEqual(Object.keys(snippets).sort(), ["dup@A.ts", "dup@B.ts"]);
});

test("a marker with no name is skipped", () => {
  const snippets = extract(`// extract-code\nconst a = 1;\n`, ".ts");
  assert.deepEqual(snippets, {});
});

test("prose that merely mentions extract-code is not a marker", () => {
  const src = [
    `// extract-code real`,
    `const a = 1;`,
    `// this snippet ends at \`extract-code end\`, see the docs`,
    `const b = 2;`,
    ``,
  ].join("\n");
  assert.deepEqual(Object.keys(extract(src, ".ts")), ["real@Fixture.ts"]);
});

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------
test("TS: extracts a plain statement", () => {
  const src = `// extract-code decl\nexport const MODEL = "m";\n`;
  assert.equal(only(src, ".ts"), `export const MODEL = "m";`);
});

test("TS: extracts an interface", () => {
  const src = [
    `// extract-code props`,
    `export interface Props {`,
    `  initial?: number;`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `export interface Props {\n  initial?: number;\n}`);
});

test("TS: a class marker keeps stacked decorators and its whole body", () => {
  const src = [
    `// extract-code model`,
    `@kosModel()`,
    `@kosLoggerAware()`,
    `export class Impl {`,
    `  id = "1";`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.match(out, /^@kosModel\(\)/);
  assert.match(out, /@kosLoggerAware\(\)/);
  assert.match(out, /export class Impl/);
  assert.match(out, /id = "1";/);
});

test("TS: a decorated method marker includes the decorator", () => {
  const src = [
    `class C {`,
    `  // extract-code m`,
    `  @kosFuture()`,
    `  async start() {`,
    `    return 1;`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  // Re-indented to column 0.
  assert.equal(
    only(src, ".ts"),
    `@kosFuture()\nasync start() {\n  return 1;\n}`,
  );
});

test("TS: a getter property marker", () => {
  const src = [
    `class C {`,
    `  // extract-code p`,
    `  get progress() {`,
    `    return 1;`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `get progress() {\n  return 1;\n}`);
});

test("TSX: extracts a function component", () => {
  const src = [
    `// extract-code cmp`,
    `export function Counter() {`,
    `  return <button>hi</button>;`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".tsx"), `export function Counter() {\n  return <button>hi</button>;\n}`);
});

// ---------------------------------------------------------------------------
// Whole-file mode (import trigger)
// ---------------------------------------------------------------------------
test("TS: a marker on an import emits the whole file", () => {
  const src = [
    `// extract-code whole`,
    `import { x } from "./x";`,
    ``,
    `export const y = x + 1;`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.equal(out, `import { x } from "./x";\n\nexport const y = x + 1;\n`);
  assert.doesNotMatch(out, /extract-code/);
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------
test("Java: an annotated class keeps its annotation", () => {
  const src = [
    `package p;`,
    ``,
    `// extract-code svc`,
    `@Service`,
    `public class WidgetService {`,
    `    public String render() { return ""; }`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".java");
  assert.match(out, /^@Service\npublic class WidgetService/);
  assert.match(out, /render\(\)/);
});

test("Java: an annotated field, with trailing semicolon", () => {
  const src = [
    `public class C {`,
    `    // extract-code f`,
    `    @Autowired`,
    `    private Repo repository;`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".java"), `@Autowired\nprivate Repo repository;`);
});

test("Java: an annotated method", () => {
  const src = [
    `public class C {`,
    `    // extract-code m`,
    `    @GetMapping("/w")`,
    `    public String describe() {`,
    `        return "x";`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(
    only(src, ".java"),
    `@GetMapping("/w")\npublic String describe() {\n    return "x";\n}`,
  );
});

// ---------------------------------------------------------------------------
// ignore marker
// ---------------------------------------------------------------------------
test("ignore strips the following node from an enclosing snippet", () => {
  const src = [
    `// extract-code cls`,
    `export class C {`,
    `  keep = 1;`,
    ``,
    `  // extract-code ignore`,
    `  private secret = "sk-do-not-leak";`,
    ``,
    `  method() { return this.keep; }`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.doesNotMatch(out, /sk-do-not-leak/);
  assert.match(out, /keep = 1;/);
  assert.match(out, /method\(\)/);
});

test("ignore does not emit a snippet of its own", () => {
  const src = [
    `// extract-code cls`,
    `export class C {`,
    `  // extract-code ignore`,
    `  private secret = "x";`,
    `  keep = 1;`,
    `}`,
    ``,
  ].join("\n");
  const snippets = extract(src, ".ts");
  assert.deepEqual(Object.keys(snippets), ["cls@Fixture.ts"]);
});

// ---------------------------------------------------------------------------
// No marker directive ever leaks into a rendered snippet
// ---------------------------------------------------------------------------
test("a container snippet does not embed its members' marker lines", () => {
  const src = [
    `// extract-code cls`,
    `export class C {`,
    `  // extract-code member`,
    `  method() { return 1; }`,
    `}`,
    ``,
  ].join("\n");
  const snippets = extract(src, ".ts");
  assert.doesNotMatch(snippets["cls@Fixture.ts"], /extract-code/);
  assert.equal(snippets["member@Fixture.ts"], `method() { return 1; }`);
});

// ---------------------------------------------------------------------------
// Regression: annotation / `modifiers` bug (reported by James Pringle)
//
// Markers stacked on annotations that decorate the SAME class used to (a) drop
// the class marker entirely — it was the last child of `modifiers`, so it had
// no next named sibling — and (b) make the first marker swallow the whole class
// plus the raw marker comment lines of the others.
// ---------------------------------------------------------------------------
const LISTENERS = [
  `package com.example;`,
  ``,
  `// extract-code listeners-s4`,
  `@ListenerPolicy(ListenerPolicy.Policy.NO_CALLBACK)`,
  ``,
  `// extract-code listeners-s5`,
  `@ListenerPolicies({`,
  `    @ListenerPolicy(value = ListenerPolicy.Policy.CALLBACK)`,
  `})`,
  ``,
  `// extract-code listeners-s3`,
  `public class AutosaveService implements DocumentListener {`,
  `    @Override`,
  `    public void onDocumentChanged(String c) {`,
  `        System.out.println(c);`,
  `    }`,
  `}`,
  ``,
].join("\n");

test("regression: all three stacked-annotation markers are emitted", () => {
  const snippets = extract(LISTENERS, ".java", "Listeners.java");
  assert.deepEqual(Object.keys(snippets).sort(), [
    "listeners-s3@Listeners.java",
    "listeners-s4@Listeners.java",
    "listeners-s5@Listeners.java",
  ]);
});

test("regression: a marker on a single annotation captures only that annotation", () => {
  const snippets = extract(LISTENERS, ".java", "Listeners.java");
  assert.equal(
    snippets["listeners-s4@Listeners.java"],
    `@ListenerPolicy(ListenerPolicy.Policy.NO_CALLBACK)`,
  );
});

test("regression: a marker on the class captures the class, not its annotations", () => {
  const snippets = extract(LISTENERS, ".java", "Listeners.java");
  const s3 = snippets["listeners-s3@Listeners.java"];
  assert.match(s3, /^public class AutosaveService/);
  assert.doesNotMatch(s3, /ListenerPolicy/);
});

test("regression: no snippet leaks a raw marker comment", () => {
  const snippets = extract(LISTENERS, ".java", "Listeners.java");
  for (const [key, value] of Object.entries(snippets)) {
    assert.doesNotMatch(value, /extract-code/, `${key} leaked a marker directive`);
  }
});

// ---------------------------------------------------------------------------
// Scoped ignore: `// extract-code ignore a, b` strips a node only from the
// named snippets, leaving it intact in every other snippet that encloses it.
// ---------------------------------------------------------------------------
test("scoped ignore strips only from the listed snippets", () => {
  const src = [
    `// extract-code full`,
    `// extract-code lite`,
    `export class C {`,
    `  keep = 1;`,
    ``,
    `  // extract-code ignore lite`,
    `  advanced() { return "adv"; }`,
    `}`,
    ``,
  ].join("\n");
  const snippets = extract(src, ".ts");
  assert.match(snippets["full@Fixture.ts"], /advanced\(\)/);
  assert.doesNotMatch(snippets["lite@Fixture.ts"], /advanced\(\)/);
});

test("scoped ignore accepts several names", () => {
  const src = [
    `// extract-code a`,
    `// extract-code b`,
    `// extract-code c`,
    `export class C {`,
    `  // extract-code ignore a, c`,
    `  secret() { return 1; }`,
    `  keep = 2;`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.doesNotMatch(s["a@Fixture.ts"], /secret/);
  assert.match(s["b@Fixture.ts"], /secret/);
  assert.doesNotMatch(s["c@Fixture.ts"], /secret/);
});

test("un-scoped ignore still strips from every enclosing snippet", () => {
  const src = [
    `// extract-code a`,
    `// extract-code b`,
    `export class C {`,
    `  // extract-code ignore`,
    `  secret = "x";`,
    `  keep = 1;`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.doesNotMatch(s["a@Fixture.ts"], /secret/);
  assert.doesNotMatch(s["b@Fixture.ts"], /secret/);
});

// ---------------------------------------------------------------------------
// Terminator: `// extract-code end <name>` bounds a snippet explicitly, so a
// run of loose sibling statements can be grouped under one marker.
// ---------------------------------------------------------------------------
test("terminator groups a run of statements", () => {
  const src = [
    `function f() {`,
    `  // extract-code pair`,
    `  a();`,
    `  b();`,
    `  // extract-code end pair`,
    `  c();`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `a();\nb();`);
});

test("two terminated groups in the same block stay separate", () => {
  const src = [
    `function f() {`,
    `  // extract-code s2`,
    `  set("k", "v");`,
    `  const val = get("k");`,
    `  // extract-code end s2`,
    ``,
    `  // extract-code s3`,
    `  const ns = new Ns();`,
    `  ns.set("k", "v");`,
    `  // extract-code end s3`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.equal(s["s2@Fixture.ts"], `set("k", "v");\nconst val = get("k");`);
  assert.equal(s["s3@Fixture.ts"], `const ns = new Ns();\nns.set("k", "v");`);
});

test("a terminator line never appears in output", () => {
  const src = [
    `function f() {`,
    `  // extract-code g`,
    `  a();`,
    `  // extract-code end g`,
    `}`,
    ``,
  ].join("\n");
  assert.doesNotMatch(only(src, ".ts"), /extract-code/);
});

test("without a terminator the whole AST node is still captured", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  a();`,
    `  b();`,
    `}`,
    ``,
  ].join("\n");
  // No terminator -> falls back to the whole function, not one statement.
  assert.equal(only(src, ".ts"), `function f() {\n  a();\n  b();\n}`);
});

// ---------------------------------------------------------------------------
// A marker inside a block, with no terminator, captures a SINGLE statement.
// To group a run of sibling statements, add `// extract-code end <name>`
// (see the terminator tests above).
// ---------------------------------------------------------------------------
test("a block marker with no terminator captures only one statement", () => {
  const src = [
    `function f() {`,
    `  // extract-code pair`,
    `  a();`,
    `  b();`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `a();`);
});

// ---------------------------------------------------------------------------
// The committed smoke fixtures stay in sync with the extractor.
// ---------------------------------------------------------------------------
test("smoke fixtures produce the expected snippet set", () => {
  const dir = path.join(here, "..", ".github", "smoke-test", "fixtures");
  const snippets = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else extractFromSource(fs.readFileSync(p, "utf8"), path.extname(p), snippets, e.name);
    }
  };
  walk(dir);
  assert.deepEqual(
    Object.keys(snippets).sort(),
    [
      "java-class@WidgetService.java",
      "java-method@WidgetMembers.java",
      "java-property@WidgetMembers.java",
      "react-component@Counter.tsx",
      "react-hook@Counter.tsx",
      "react-props@Counter.tsx",
      "ts-class@FuturesModel.ts",
      "ts-method@FuturesModel.ts",
      "ts-property@FuturesModel.ts",
    ],
  );
  // No snippet may carry a stray marker directive.
  for (const [key, value] of Object.entries(snippets)) {
    assert.doesNotMatch(value, /extract-code/, `${key} leaked a marker directive`);
  }
  // The planted secret must never survive the ignore marker.
  for (const value of Object.values(snippets)) {
    assert.doesNotMatch(value, /sk-do-not-leak/);
  }
});
