// Unit tests for the snippet extractor. Run with: node --test
//
// These drive extractFromSource() directly (no filesystem) so each case is a
// small, readable source string paired with its expected snippet output. The
// suite covers every documented marker use case across JS/TS/TSX, Java and
// C/C++/Arduino, plus regression tests for the annotation/`modifiers`
// extraction bug.

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
// C / C++ / Arduino
// ---------------------------------------------------------------------------
test("C: extracts a function", () => {
  const src = [
    `#include <stdio.h>`,
    ``,
    `// extract-code fn`,
    `int add(int a, int b) {`,
    `  return a + b;`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".c"), `int add(int a, int b) {\n  return a + b;\n}`);
});

test("C: a typedef'd struct keeps its trailing semicolon", () => {
  const src = [
    `// extract-code s`,
    `typedef struct {`,
    `  int id;`,
    `} Thing;`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".c"), `typedef struct {\n  int id;\n} Thing;`);
});

test("C: a marker on #include emits the whole file", () => {
  const src = [
    `// extract-code whole`,
    `#include <stdio.h>`,
    ``,
    `int main(void) { return 0; }`,
    ``,
  ].join("\n");
  const out = only(src, ".c");
  assert.match(out, /#include <stdio\.h>/);
  assert.match(out, /int main/);
  assert.doesNotMatch(out, /extract-code/);
});

test("C++: a class marker swallows the trailing semicolon", () => {
  const src = [
    `// extract-code cls`,
    `class Widget {`,
    ` public:`,
    `  int size() const { return 1; }`,
    `};`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".cpp"), `class Widget {\n public:\n  int size() const { return 1; }\n};`);
});

test("C++: ignore strips a member from an enclosing class snippet", () => {
  const src = [
    `// extract-code cls`,
    `class C {`,
    ` public:`,
    `  int keep = 1;`,
    `  // extract-code ignore`,
    `  const char* secret = "sk-do-not-leak";`,
    `};`,
    ``,
  ].join("\n");
  const out = only(src, ".cpp");
  assert.doesNotMatch(out, /sk-do-not-leak/);
  assert.match(out, /keep = 1;/);
});

test("ino: extracts Arduino sketch functions via the C++ grammar", () => {
  const src = [
    `#include <Arduino.h>`,
    ``,
    `// extract-code setup`,
    `void setup() {`,
    `  Serial.begin(9600);`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ino", "Blink.ino"), `void setup() {\n  Serial.begin(9600);\n}`);
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
// Additive snippets: one <name> reused on several markers in a file collects
// every marked piece, in source order, into a single snippet — for showing an
// include and a macro alongside the code that uses them.
// ---------------------------------------------------------------------------
test("a reused name concatenates its segments in source order", () => {
  const src = [
    `// extract-code wifi`,
    `#include <WiFi.h>`,
    ``,
    `// extract-code wifi`,
    `#define WIFI_SSID "net"`,
    ``,
    `static int retries = 0;`,
    ``,
    `// extract-code wifi`,
    `void connect() {`,
    `  WiFi.begin(WIFI_SSID);`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(
    only(src, ".ino", "Sketch.ino"),
    [
      `#include <WiFi.h>`,
      ``,
      `#define WIFI_SSID "net"`,
      ``,
      `void connect() {`,
      `  WiFi.begin(WIFI_SSID);`,
      `}`,
    ].join("\n"),
  );
});

test("segments skip the unmarked code between them", () => {
  const src = [
    `// extract-code parts`,
    `const first = 1;`,
    ``,
    `const NOT_IN_SNIPPET = "skipped";`,
    ``,
    `// extract-code parts`,
    `const second = 2;`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.equal(out, `const first = 1;\n\nconst second = 2;`);
  assert.doesNotMatch(out, /skipped/);
});

test("each segment can be grouped with its own terminator", () => {
  const src = [
    `// extract-code wifi`,
    `#include <WiFi.h>`,
    `#include <WiFiClient.h>`,
    `// extract-code end wifi`,
    `#include <stdio.h>`,
    ``,
    `// extract-code wifi`,
    `#define WIFI_SSID "net"`,
    `#define WIFI_PASS "pw"`,
    `// extract-code end wifi`,
    ``,
    `// extract-code wifi`,
    `void connect() { WiFi.begin(WIFI_SSID, WIFI_PASS); }`,
    ``,
  ].join("\n");
  assert.equal(
    only(src, ".c", "main.c"),
    [
      `#include <WiFi.h>`,
      `#include <WiFiClient.h>`,
      ``,
      `#define WIFI_SSID "net"`,
      `#define WIFI_PASS "pw"`,
      ``,
      `void connect() { WiFi.begin(WIFI_SSID, WIFI_PASS); }`,
    ].join("\n"),
  );
});

test("a terminator binds to its own segment, not an earlier one", () => {
  // Regression: segment 1 has no terminator of its own, so it must NOT run to
  // segment 2's `end` marker and duplicate what segment 2 already contributes.
  const src = [
    `// extract-code wifi`,
    `#include <WiFi.h>`,
    ``,
    `// extract-code wifi`,
    `#define WIFI_SSID "net"`,
    `#define WIFI_PASS "pw"`,
    `// extract-code end wifi`,
    ``,
    `// extract-code wifi`,
    `void connect() { WiFi.begin(WIFI_SSID, WIFI_PASS); }`,
    ``,
  ].join("\n");
  assert.equal(
    only(src, ".ino", "Sketch.ino"),
    [
      `#include <WiFi.h>`,
      ``,
      `#define WIFI_SSID "net"`,
      `#define WIFI_PASS "pw"`,
      ``,
      `void connect() { WiFi.begin(WIFI_SSID, WIFI_PASS); }`,
    ].join("\n"),
  );
});

test("an additive name does not trigger whole-file mode on an include segment", () => {
  const src = [
    `// extract-code pair`,
    `#include <WiFi.h>`,
    ``,
    `int secretHelper() { return 42; }`,
    ``,
    `// extract-code pair`,
    `void use() { WiFi.begin(); }`,
    ``,
  ].join("\n");
  const out = only(src, ".c", "main.c");
  assert.doesNotMatch(out, /secretHelper/);
  assert.equal(out, `#include <WiFi.h>\n\nvoid use() { WiFi.begin(); }`);
});

test("a single import marker still emits the whole file", () => {
  const src = [
    `// extract-code whole`,
    `import { a } from "./a";`,
    ``,
    `const other = 1;`,
    ``,
  ].join("\n");
  assert.match(only(src, ".ts"), /const other = 1;/);
});

test("additive segments each re-indent to column 0", () => {
  const src = [
    `class C {`,
    `  // extract-code bits`,
    `  a() { return 1; }`,
    ``,
    `  // extract-code bits`,
    `  b() { return 2; }`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `a() { return 1; }\n\nb() { return 2; }`);
});

test("ignore still applies inside each additive segment", () => {
  const src = [
    `// extract-code bits`,
    `function f() {`,
    `  keep1();`,
    `  // extract-code ignore`,
    `  const secret = "sk-do-not-leak";`,
    `}`,
    ``,
    `// extract-code bits`,
    `function g() {`,
    `  // extract-code ignore start`,
    `  hidden1();`,
    `  hidden2();`,
    `  // extract-code ignore end`,
    `  keep2();`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.doesNotMatch(out, /sk-do-not-leak|hidden/);
  assert.match(out, /keep1\(\);/);
  assert.match(out, /keep2\(\);/);
  assert.doesNotMatch(out, /extract-code/);
});

test("additive names stay independent of other snippets in the file", () => {
  const src = [
    `// extract-code bits`,
    `const a = 1;`,
    ``,
    `// extract-code solo`,
    `const b = 2;`,
    ``,
    `// extract-code bits`,
    `const c = 3;`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.deepEqual(Object.keys(s).sort(), ["bits@Fixture.ts", "solo@Fixture.ts"]);
  assert.equal(s["bits@Fixture.ts"], `const a = 1;\n\nconst c = 3;`);
  assert.equal(s["solo@Fixture.ts"], `const b = 2;`);
});

test("Java: an additive name joins an import with the code that uses it", () => {
  const src = [
    `package com.example;`,
    ``,
    `// extract-code autosave`,
    `import com.example.Autosave;`,
    `// extract-code end autosave`,
    ``,
    `public class C {`,
    `  // extract-code autosave`,
    `  public void save() { new Autosave().run(); }`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(
    only(src, ".java", "C.java"),
    `import com.example.Autosave;\n\npublic void save() { new Autosave().run(); }`,
  );
});

// ---------------------------------------------------------------------------
// Block ignore: `ignore start` ... `ignore end` brackets a run of loose lines
// the AST wouldn't bundle into one node — the ignore-side counterpart of the
// `extract-code end <name>` terminator.
// ---------------------------------------------------------------------------
test("block ignore strips everything between start and end", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  keep1();`,
    `  // extract-code ignore start`,
    `  const secret = "sk-do-not-leak";`,
    `  boilerplate();`,
    `  more();`,
    `  // extract-code ignore end`,
    `  keep2();`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `function f() {\n  keep1();\n  keep2();\n}`);
});

test("C: block ignore strips an option-parsing preamble from a main() snippet", () => {
  const src = [
    `// extract-code arduino-s1`,
    `int main(int argc, char *argv[]) {`,
    `  // extract-code ignore start arduino-s1`,
    `  int console = 0;`,
    `  signed char c;`,
    `  while ((c = getopt(argc, argv, "hc:")) != -1) {`,
    `    switch (c) {`,
    `    case 'h':`,
    `      return usage();`,
    `    }`,
    `  }`,
    `  srand(time(NULL));`,
    `  // extract-code ignore end arduino-s1`,
    `  run();`,
    `  return 0;`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".c", "main.c");
  assert.equal(out, `int main(int argc, char *argv[]) {\n  run();\n  return 0;\n}`);
});

test("block ignore is scoped to the snippets it names", () => {
  const src = [
    `// extract-code full`,
    `// extract-code lite`,
    `function f() {`,
    `  keep();`,
    `  // extract-code ignore start lite`,
    `  detail1();`,
    `  detail2();`,
    `  // extract-code ignore end lite`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.match(s["full@Fixture.ts"], /detail1\(\);\n  detail2\(\);/);
  assert.doesNotMatch(s["lite@Fixture.ts"], /detail/);
  assert.match(s["lite@Fixture.ts"], /keep\(\);/);
});

test("an un-scoped block ignore strips from every enclosing snippet", () => {
  const src = [
    `// extract-code a`,
    `// extract-code b`,
    `function f() {`,
    `  // extract-code ignore start`,
    `  secret1();`,
    `  secret2();`,
    `  // extract-code ignore end`,
    `  keep();`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.doesNotMatch(s["a@Fixture.ts"], /secret/);
  assert.doesNotMatch(s["b@Fixture.ts"], /secret/);
});

test("block ignore markers never appear in output and mint no snippet", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  // extract-code ignore start`,
    `  x();`,
    `  // extract-code ignore end`,
    `  keep();`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  assert.deepEqual(Object.keys(s), ["fn@Fixture.ts"]);
  assert.doesNotMatch(s["fn@Fixture.ts"], /extract-code/);
});

test("two block ignores in the same body are independent", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  // extract-code ignore start`,
    `  drop1();`,
    `  // extract-code ignore end`,
    `  keep();`,
    `  // extract-code ignore start`,
    `  drop2();`,
    `  // extract-code ignore end`,
    `}`,
    ``,
  ].join("\n");
  assert.equal(only(src, ".ts"), `function f() {\n  keep();\n}`);
});

test("nested block ignores pair like brackets", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  // extract-code ignore start outer`,
    `  a();`,
    `  // extract-code ignore start inner`,
    `  b();`,
    `  // extract-code ignore end inner`,
    `  c();`,
    `  // extract-code ignore end outer`,
    `  keep();`,
    `}`,
    ``,
  ].join("\n");
  const s = extract(src, ".ts");
  // Only `outer`/`inner` are scope names, so `fn` keeps everything...
  assert.match(s["fn@Fixture.ts"], /a\(\);/);
  assert.match(s["fn@Fixture.ts"], /keep\(\);/);
  assert.doesNotMatch(s["fn@Fixture.ts"], /extract-code/);
});

test("an unterminated block ignore runs to end of file", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  keep();`,
    `  // extract-code ignore start`,
    `  secret();`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.doesNotMatch(out, /secret/);
  assert.match(out, /keep\(\);/);
});

test("an orphan `ignore end` is skipped without dropping content", () => {
  const src = [
    `// extract-code fn`,
    `function f() {`,
    `  keep();`,
    `  // extract-code ignore end`,
    `  alsoKeep();`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".ts");
  assert.match(out, /keep\(\);/);
  assert.match(out, /alsoKeep\(\);/);
  assert.doesNotMatch(out, /extract-code/);
});

test("Java: block ignore strips a run of statements from a method snippet", () => {
  const src = [
    `public class C {`,
    `  // extract-code m`,
    `  public void m() {`,
    `    setup();`,
    `    // extract-code ignore start`,
    `    String token = "sk-do-not-leak";`,
    `    warmUp(token);`,
    `    // extract-code ignore end`,
    `    run();`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
  const out = only(src, ".java", "C.java");
  assert.doesNotMatch(out, /sk-do-not-leak/);
  assert.match(out, /setup\(\);/);
  assert.match(out, /run\(\);/);
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
      "c-function@sensor.c",
      "c-struct@sensor.c",
      "cpp-class@RingBuffer.cpp",
      "cpp-method@RingBuffer.cpp",
      "ino-loop@Blink.ino",
      "ino-setup@Blink.ino",
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
