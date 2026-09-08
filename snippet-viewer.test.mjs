// Tests for the snippet-viewer web component's Prism loader. Run with: node --test
//
// snippet-viewer.js is a browser IIFE, so it is evaluated inside a vm context
// with just enough of a fake DOM to load it. The fake models the one browser
// behaviour these tests care about: dynamically inserted <script> elements run
// in *arrival* order unless `async` is false, in which case they run in
// insertion order. Prism language components extend grammars registered by
// earlier components (tsx extends jsx and clones typescript), so a loader that
// leaves execution order to the network intermittently — in practice, almost
// always, since prism-tsx is the smallest file — ends up with no tsx grammar.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const viewerSource = fs.readFileSync(path.join(here, "snippet-viewer.js"), "utf8");

// Which grammars each Prism component needs to find already registered. Only
// the ones the viewer loads; core ships markup/javascript/css/clike.
const PRISM_CORE = ["markup", "css", "clike", "javascript"];
const PRISM_DEPS = {
  typescript: ["javascript"],
  jsx: ["markup", "javascript"],
  tsx: ["jsx", "typescript"],
  bash: [],
  json: [],
  yaml: [],
  python: [],
  java: ["clike"],
  c: ["clike"],
  cpp: ["c"],
  arduino: ["cpp"],
};

function componentName(src) {
  const m = /components\/prism-([a-z]+)\.min\.js$/.exec(src);
  return m ? m[1] : null;
}

// Build a context with a fake document, evaluate the viewer in it, and return
// the handles the tests need. `arrival` decides the order async scripts run in.
function loadViewer({ arrival }) {
  const appended = [];
  const ctx = {
    console,
    document: {
      head: { appendChild: (el) => appended.push(el) },
      createElement: (tag) => ({ tag, async: true, style: {} }),
      querySelector: () => null,
    },
    customElements: { define() {} },
    HTMLElement: class {},
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(viewerSource, ctx, { filename: "snippet-viewer.js" });

  // Simulate the browser draining the script queue. Ordered (async=false)
  // scripts run in insertion order; the rest run in `arrival` order. Each
  // script's "execution" registers its grammar iff its dependencies exist.
  function flushScripts() {
    const pending = appended.splice(0);
    const ordered = pending.filter((s) => s.async === false);
    const unordered = arrival(pending.filter((s) => s.async !== false));
    for (const script of [...ordered, ...unordered]) {
      const src = script.src;
      if (/\/prism\.min\.js$/.test(src)) {
        ctx.Prism = { languages: Object.fromEntries(PRISM_CORE.map((l) => [l, {}])), highlightElement() {} };
      } else if (/plugins\//.test(src)) {
        // line-numbers plugin: nothing to model
      } else {
        const name = componentName(src);
        const deps = PRISM_DEPS[name] ?? [];
        if (deps.every((d) => ctx.Prism.languages[d])) ctx.Prism.languages[name] = {};
        // else: the real component throws here and registers nothing
      }
      script.onload?.();
    }
    return pending;
  }

  return { ctx, flushScripts, appended };
}

// Drive loadPrism to completion, flushing the queue each time the loader
// appends another wave of scripts (core, then plugin, then components).
async function loadPrismFully(viewer) {
  const done = viewer.ctx.SnippetViewer.loadPrism();
  const waves = [];
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    waves.push(viewer.flushScripts());
  }
  const Prism = await done;
  return { Prism, components: waves.flat().map((s) => componentName(s.src)).filter(Boolean) };
}

const reverse = (scripts) => [...scripts].reverse();
const identity = (scripts) => scripts;

test("language components are inserted with async=false so they execute in insertion order", async () => {
  const viewer = loadViewer({ arrival: identity });
  const done = viewer.ctx.SnippetViewer.loadPrism();
  const scripts = [];
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    scripts.push(...viewer.flushScripts());
  }
  await done;
  const langScripts = scripts.filter((s) => componentName(s.src));
  assert.ok(langScripts.length > 0, "no language components were loaded");
  for (const s of langScripts) assert.equal(s.async, false, `${s.src} was left async`);
});

test("the component list registers every dependency before the component that needs it", async () => {
  const viewer = loadViewer({ arrival: identity });
  const { components } = await loadPrismFully(viewer);
  for (const [name, deps] of Object.entries(PRISM_DEPS)) {
    if (!components.includes(name)) continue;
    for (const dep of deps) {
      if (PRISM_CORE.includes(dep)) continue;
      assert.ok(
        components.indexOf(dep) < components.indexOf(name),
        `${name} is loaded before its dependency ${dep}`,
      );
    }
  }
});

test("tsx grammar is registered even when the network delivers scripts in the worst order", async () => {
  const viewer = loadViewer({ arrival: reverse });
  const { Prism } = await loadPrismFully(viewer);
  assert.ok(Prism.languages.tsx, "tsx grammar missing");
  assert.ok(Prism.languages.jsx, "jsx grammar missing");
  assert.ok(Prism.languages.typescript, "typescript grammar missing");
});

test("highlightWith highlights when the grammar exists and warns when it does not", () => {
  const viewer = loadViewer({ arrival: identity });
  const { highlightWith } = viewer.ctx.SnippetViewer;
  const calls = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const Prism = { languages: { tsx: {} }, highlightElement: (el) => calls.push(el) };
    const el = { className: "language-tsx" };
    assert.equal(highlightWith(Prism, el, "tsx", "Counter.tsx"), true);
    assert.deepEqual(calls, [el]);
    assert.deepEqual(warnings, []);

    assert.equal(highlightWith(Prism, el, "jsx", "App.jsx"), false);
    assert.equal(calls.length, 1, "must not highlight without a grammar");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no Prism grammar registered for "jsx" \(App\.jsx\)/);

    assert.equal(highlightWith(null, el, "tsx", "x.tsx"), false);
  } finally {
    console.warn = origWarn;
  }
});
