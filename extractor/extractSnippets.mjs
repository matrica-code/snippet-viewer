#!/usr/bin/env node
// Portable, multi-language snippet extractor.
//
// Drop-in replacement for the jscodeshift-based extractSnippets.mjs that works
// across JS/TS/TSX *and* Java (and any other Tree-sitter grammar you register).
//
// Usage:
//   node tools/codemod/extractSnippets.portable.mjs \
//     --snippetFile=path/to/snippets.json [--reset] <dir-or-file> [<dir-or-file> ...]
//
// Marker conventions:
//   // extract-code <name>        -> export the node that follows this comment
//   // extract-code end <name>    -> optional terminator: end snippet <name> here,
//                                    grouping a run of loose statements the AST
//                                    wouldn't bundle on its own
//   // extract-code ignore        -> strip the following node from every snippet
//   // extract-code ignore a, b   -> strip it only from snippets a and b
//   // extract-code ignore start  -> block ignore: strip everything from here up
//   ...                              to the matching `ignore end` — the ignore-side
//   // extract-code ignore end        counterpart of `extract-code end <name>`,
//                                     for a run of loose lines the AST won't bundle
//   // extract-code ignore start a, b / ignore end a, b
//                                  -> same, scoped to snippets a and b
//
//   Reusing one <name> on several markers in a file is *additive*: each marker
//   contributes a segment and they are concatenated, in source order, into one
//   snippet — for pulling an include, a macro and the code that uses them out of
//   the distinct regions of a file they legitimately live in.
//
// Behaviors preserved from the jscodeshift version:
//   * snippet keys are `<name>@<basename>` so the same name in two files is safe
//   * if the marked node is an import (whole-file trigger), the ENTIRE file is emitted
//   * the existing snippet file is merged into, not overwritten
//   * whole-file snippets do NOT honor `ignore` (only node-mode snippets do) — faithful
//     to the original, where ignore removal only affected AST-serialized nodes.

import fs from "fs";
import path from "path";
import url from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Language registry. Grammars are loaded lazily so a project that never touches
// Java doesn't need tree-sitter-java installed, and vice versa.
//
// `decorators` lists node types that appear as *siblings preceding* a
// declaration (JS/TS `@decorator`). Java annotations are NOT listed here: the
// Java grammar folds them into the declaration's `modifiers`, so they are
// captured automatically without sibling-walking.
// ---------------------------------------------------------------------------
const LANGUAGES = {
  ".ts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".tsx": { load: () => require("tree-sitter-typescript").tsx, comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".mts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".cts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".js": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".jsx": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".mjs": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"], decorators: ["decorator"] },
  ".java": { load: () => require("tree-sitter-java"), comments: ["line_comment", "block_comment"], wholeFile: ["import_declaration"], decorators: [] },
  ".cpp": { load: () => require("tree-sitter-cpp"), comments: ["comment"], wholeFile: ["preproc_include"], decorators: [] },
  ".c": { load: () => require("tree-sitter-c"), comments: ["comment"], wholeFile: ["preproc_include"], decorators: [] },
  ".ino": { load: () => require("tree-sitter-cpp"), comments: ["comment"], wholeFile: ["preproc_include"], decorators: [] },
};

// Cache one Parser per extension so we don't reload grammars per file.
const parserCache = new Map();
function getParser(ext) {
  if (parserCache.has(ext)) return parserCache.get(ext);
  const cfg = LANGUAGES[ext];
  if (!cfg) return null;
  const Parser = require("tree-sitter");
  const parser = new Parser();
  parser.setLanguage(cfg.load());
  const entry = { parser, cfg };
  parserCache.set(ext, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  let snippetFile = null;
  let reset = false;
  const paths = [];
  for (const arg of argv) {
    if (arg.startsWith("--snippetFile=")) snippetFile = arg.slice("--snippetFile=".length);
    else if (arg === "--reset") reset = true;
    else if (arg.startsWith("--")) continue; // ignore unknown flags (e.g. legacy jscodeshift flags)
    else paths.push(arg);
  }
  return { snippetFile, reset, paths };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage"]);

function* walk(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(target, entry.name));
    } else if (entry.isFile()) {
      yield path.join(target, entry.name);
    }
  }
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
function collectComments(root, commentTypes) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (commentTypes.includes(node.type)) out.push(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) stack.push(node.namedChild(i));
  }
  return out;
}

const MARKER = "extract-code";

// A marker is a comment whose directive begins the comment body — `// extract-code
// <name>`, not prose that merely mentions the word (e.g. "…up to `extract-code
// end`."), which must never mint a spurious snippet.
function isMarker(comment) {
  const body = comment.text.replace(/^\s*(?:\/\/+|\/\*+|\*+)?\s*/, "");
  return /^extract-code(?:\s|$)/.test(body);
}

// A comma-separated scope list -> Set of snippet names, or null for "every
// snippet" (the un-scoped form).
function parseScope(text) {
  const names = text.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

// Classify a marker comment's directive from the text after `extract-code`:
//   extract-code <name>            -> { kind: "start", name }
//   extract-code end <name>        -> { kind: "end", name }      (snippet terminator)
//   extract-code ignore            -> { kind: "ignore", names: null }   (global)
//   extract-code ignore a, b       -> { kind: "ignore", names: Set{a,b} } (scoped)
//   extract-code ignore start [a, b] -> { kind: "ignore-start", names }  (block open)
//   extract-code ignore end   [a, b] -> { kind: "ignore-end", names }    (block close)
function classifyMarker(commentText) {
  const after = (commentText.split(MARKER)[1] ?? "")
    .replace(/\*\/\s*$/, "") // trailing block-comment close
    .replace(/\r?\n[\s\S]*$/, "") // anything past the first line
    .trim();
  const [head, ...rest] = after.split(/\s+/);
  const tail = rest.join(" ").trim();
  if (head === "ignore") {
    // `ignore start` / `ignore end` open and close a *block* ignore; anything
    // else after `ignore` is a scope list applying to the next node.
    const [sub, ...subRest] = rest;
    if (sub === "start" || sub === "end") {
      return { kind: sub === "start" ? "ignore-start" : "ignore-end", names: parseScope(subRest.join(" ")) };
    }
    return { kind: "ignore", names: parseScope(tail) };
  }
  if (head === "end") return { kind: "end", name: tail };
  return { kind: "start", name: after };
}

// First source index after a marker comment that begins real content, skipping
// whitespace and any *intervening* comment lines (e.g. a human note that sits
// between the marker and the code it points at).
function firstTokenAfter(comment, root, commentTypes, source) {
  let i = comment.endIndex;
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) return null;
    let n = root.descendantForIndex(i, i);
    while (n && !commentTypes.includes(n.type)) n = n.parent;
    if (n && commentTypes.includes(n.type) && n.endIndex > i) {
      i = n.endIndex; // step over the intervening comment and keep looking
      continue;
    }
    return i;
  }
}

// The source span a marker comment applies to — the "maximal" unit before any
// truncation by a following marker. Resolves the construct that begins right
// after the comment WITHOUT relying on `nextNamedSibling`, which breaks when a
// marker lands among a Java declaration's folded-in annotation `modifiers`
// (a marker that is the last child of `modifiers` has no next named sibling).
//
// Normalizes two grammar quirks so the snippet matches what a real
// pretty-printer would emit:
//   * JS/TS method decorators are separate siblings — extend across the
//     decorator run to include the declaration they decorate
//   * a trailing `;` after a field/declaration sits outside the node — swallow it
function resolveUnit(comment, cfg, source, root) {
  const pos = firstTokenAfter(comment, root, cfg.comments, source);
  if (pos == null) return null;

  // Innermost *named* node covering the first real token...
  let node = root.descendantForIndex(pos, pos);
  while (node && !node.isNamed) node = node.parent;
  if (!node) return null;

  // ...then climb to the largest construct that begins at the same index. A
  // declaration and its leading `modifiers` share a start index, so this lifts
  // an annotation/`modifiers` up to the declaration it belongs to (e.g. a
  // marker on `public class` whose comment was parsed into `modifiers`).
  while (node.parent && node.parent !== root && node.parent.startIndex === node.startIndex) {
    node = node.parent;
  }

  const startNode = node;
  let endNode = node;

  // JS/TS decorator run: @a @b class X -> include the decorated declaration.
  if (cfg.decorators.includes(node.type)) {
    let m = node;
    while (m && cfg.decorators.includes(m.type)) {
      endNode = m;
      m = m.nextNamedSibling;
    }
    if (m) endNode = m;
  }

  // Swallow a trailing `;` that the grammar leaves outside the node.
  let endIndex = endNode.endIndex;
  let e = endIndex;
  while (e < source.length && /\s/.test(source[e])) e++;
  if (source[e] === ";") endIndex = e + 1;

  return { segStart: pos, maxEnd: endIndex, type: startNode.type, node: startNode };
}

// Start index of the first block/body nested inside `node` that opens after
// `after`. Markers beyond this point belong to *members* of the construct
// (e.g. method markers inside a class body) and must not truncate a snippet
// that covers the whole construct.
const BODY_RE = /(^block$|^statement_block$|body$|declaration_list$)/;
function firstBlockStart(node, after) {
  let best = Infinity;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n !== node && BODY_RE.test(n.type) && n.startIndex > after) {
      best = Math.min(best, n.startIndex);
      continue; // don't descend into a body we've already accounted for
    }
    for (let i = 0; i < n.namedChildCount; i++) stack.push(n.namedChild(i));
  }
  return best;
}

// Expand a [start, end) byte range to cover whole lines, so removing it leaves
// no dangling blank line (the moral equivalent of jscodeshift's node removal).
function expandToFullLines(source, start, end) {
  let s = start;
  while (s > 0 && source[s - 1] !== "\n") s--;
  let e = end;
  while (e < source.length && source[e] !== "\n") e++;
  if (e < source.length) e++; // include the trailing newline
  return [s, e];
}

// Kept for backward-compatible export; `classifyMarker` is the source of truth.
function parseSnippetName(commentText) {
  return classifyMarker(commentText).name ?? "";
}

// Drop any whole line that is itself an extract-code marker directive. A marker
// is a tool instruction, not documentation — it must never surface in a
// rendered snippet, including when a container snippet encloses a member's
// marker (e.g. a class snippet that wraps its method markers).
const MARKER_LINE_RE = new RegExp(String.raw`^[ \t]*(?:\/\/|\/\*)[ \t]*${MARKER}\b.*(?:\r?\n|$)`, "gm");
function stripMarkerLines(text) {
  return text.replace(MARKER_LINE_RE, "");
}

// Index in a stack of unclosed `ignore start` markers that an `ignore end`
// closes: the nearest one with an identical scope list, else the nearest one at
// all (-1 when the stack is empty).
function scopeKey(names) {
  return names ? [...names].sort().join(",") : "";
}
function matchOpenIgnore(open, names) {
  if (names) {
    const key = scopeKey(names);
    for (let i = open.length - 1; i >= 0; i--) {
      if (scopeKey(open[i].names) === key) return i;
    }
  }
  return open.length - 1;
}

// ---------------------------------------------------------------------------
// Extraction (pure: operates on a source string, no filesystem)
// ---------------------------------------------------------------------------
function extractFromSource(source, ext, snippets, basename) {
  const entry = getParser(ext);
  if (!entry) return snippets; // not a language we know — skip silently

  const { parser, cfg } = entry;
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const comments = collectComments(root, cfg.comments);
  const markers = comments.map((c) => ({ comment: c, ...classifyMarker(c.text) }))
    .filter((m) => isMarker(m.comment))
    .sort((a, b) => a.comment.startIndex - b.comment.startIndex); // block ignores pair in source order

  // Positions of every *start* marker, used to truncate a snippet where the
  // next one begins. Terminators and ignores are not partition boundaries.
  const markerStarts = markers
    .filter((m) => m.kind === "start" && m.name)
    .map((m) => m.comment.startIndex)
    .sort((a, b) => a - b);

  // Every start marker per name, in source order. A name used more than once is
  // an *additive* snippet: each marker contributes a segment, concatenated in
  // source order. Whole-file mode is suppressed for those — an author who
  // composed segments by hand is asking for those pieces, not the entire file
  // (which is exactly what a leading `#include`/`import` segment would trigger).
  const startsByName = new Map();
  for (const m of markers) {
    if (m.kind !== "start" || !m.name) continue;
    const list = startsByName.get(m.name) ?? [];
    list.push(m.comment.startIndex);
    startsByName.set(m.name, list);
  }

  // Explicit snippet terminators: name -> sorted positions of `extract-code end <name>`.
  const endByName = new Map();
  for (const m of markers) {
    if (m.kind !== "end" || !m.name) continue;
    const list = endByName.get(m.name) ?? [];
    list.push(m.comment.startIndex);
    endByName.set(m.name, list.sort((a, b) => a - b));
  }

  // Pass 1: gather ignore ranges (line-expanded) so node-mode snippets can splice
  // them out. `names` scopes an ignore to specific snippets (null = every snippet).
  //
  // Two forms feed the same list: the node form (`ignore` + the unit that
  // follows) and the block form (`ignore start` ... `ignore end`), which brackets
  // a run of loose lines the AST wouldn't bundle — the ignore-side counterpart of
  // the `extract-code end <name>` terminator.
  const ignoreRanges = [];
  const openIgnores = []; // stack of unclosed `ignore start` markers
  for (const m of markers) {
    if (m.kind === "ignore") {
      const unit = resolveUnit(m.comment, cfg, source, root);
      if (!unit) continue;
      const [s, e] = expandToFullLines(source, m.comment.startIndex, unit.maxEnd);
      ignoreRanges.push({ s, e, names: m.names });
      continue;
    }
    if (m.kind === "ignore-start") {
      openIgnores.push(m);
      continue;
    }
    if (m.kind === "ignore-end") {
      // Pair with the nearest unclosed start carrying the same scope list; a
      // scope-less `ignore end` (or one that matches nothing) closes the nearest
      // unclosed start, so nesting behaves like brackets.
      const idx = matchOpenIgnore(openIgnores, m.names);
      if (idx < 0) {
        console.warn(`warning: ${basename}: \`${MARKER} ignore end\` with no open \`ignore start\` — skipped`);
        continue;
      }
      const [start] = openIgnores.splice(idx, 1);
      const [s, e] = expandToFullLines(source, start.comment.startIndex, m.comment.endIndex);
      ignoreRanges.push({ s, e, names: start.names });
    }
  }
  // An unterminated block ignore runs to end of file: hiding too much is visible
  // to the author, whereas leaking what they meant to hide is not.
  for (const start of openIgnores) {
    console.warn(`warning: ${basename}: unterminated \`${MARKER} ignore start\` — ignoring to end of file`);
    const [s, e] = expandToFullLines(source, start.comment.startIndex, source.length);
    ignoreRanges.push({ s, e, names: start.names, open: true });
  }

  // Pass 2: emit named snippets. Segments accumulate per key so a reused name
  // concatenates instead of the last marker winning.
  const segments = new Map();
  const addSegment = (key, text) => {
    const parts = segments.get(key) ?? [];
    parts.push(text);
    segments.set(key, parts);
  };

  for (const m of markers) {
    if (m.kind !== "start") continue;

    const name = m.name;
    if (!name) continue;
    const key = `${name}@${basename}`;

    const unit = resolveUnit(m.comment, cfg, source, root);
    if (!unit) continue;

    // Where this name's next segment begins — a terminator past that point
    // belongs to that segment, not this one, so an additive name's segments each
    // bind to their own `extract-code end <name>` (or to none).
    const starts = startsByName.get(name) ?? [];
    const nextSegment = starts.find((p) => p > m.comment.startIndex) ?? Infinity;

    // An explicit terminator (`extract-code end <name>`) after this marker bounds
    // the snippet directly — for grouping loose statements the AST can't. The
    // earliest matching terminator past the start wins.
    const ends = (endByName.get(name) ?? []).filter((p) => p > unit.segStart && p < nextSegment);
    const terminator = ends.length ? Math.min(...ends) : null;

    // Whole-file mode: marker leads an import -> emit the full source. Off for
    // additive names, whose segments are the point.
    if (terminator == null && starts.length === 1 && cfg.wholeFile.includes(unit.type)) {
      snippets[key] = stripMarkerLines(source).trimEnd() + "\n";
      continue;
    }

    let endIndex;
    if (terminator != null) {
      endIndex = terminator;
    } else {
      // A snippet runs from its target to the maximal unit end, UNLESS a later
      // marker begins first (and before any nested body) — then it stops there,
      // so sibling markers partition a shared construct instead of overlapping.
      const bodyStart = firstBlockStart(unit.node, unit.segStart);
      const boundary = Math.min(unit.maxEnd, bodyStart);
      endIndex = unit.maxEnd;
      for (const start of markerStarts) {
        if (start > unit.segStart && start < boundary) {
          endIndex = start;
          break;
        }
      }
    }

    // Slice the unit's span, then splice out any nested ignores that apply to
    // this snippet (scoped ignores only strip from their named targets).
    let text = source.slice(unit.segStart, endIndex);
    const inner = ignoreRanges
      // A closed ignore must sit wholly inside the snippet; an `open` one (an
      // unterminated `ignore start`) runs past the end, so it clips to it.
      .filter(({ s, e, open, names }) => s >= unit.segStart && (open || e <= endIndex) && (names == null || names.has(name)))
      .map(({ s, e }) => ({ s, e: Math.min(e, endIndex) }))
      .sort((a, b) => b.s - a.s); // descending so earlier splices don't shift later offsets
    for (const { s, e } of inner) {
      text = text.slice(0, s - unit.segStart) + text.slice(e - unit.segStart);
    }

    text = stripMarkerLines(text);

    // Re-indent to column 0, matching jscodeshift's toSource() output: the first
    // line already starts at the node, but continuation lines keep their in-source
    // indentation, so strip the node's base column from each subsequent line.
    let baseCol = 0;
    while (unit.segStart - baseCol > 0 && source[unit.segStart - baseCol - 1] !== "\n") baseCol++;
    if (baseCol > 0) {
      text = text
        .split("\n")
        .map((line, i) => (i === 0 ? line : line.replace(new RegExp(`^[ \\t]{0,${baseCol}}`), "")))
        .join("\n");
    }

    addSegment(key, text.trimEnd());
  }

  // Join an additive snippet's segments with a blank line: they come from
  // discontiguous regions of the file, and the gap reads as that discontinuity.
  for (const [key, parts] of segments) {
    snippets[key] = parts.filter((t) => t.trim()).join("\n\n");
  }

  return snippets;
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------
function extractFromFile(filePath, snippets) {
  const ext = path.extname(filePath);
  if (!LANGUAGES[ext]) return snippets; // not a language we know — skip silently
  const source = fs.readFileSync(filePath, "utf8");
  return extractFromSource(source, ext, snippets, path.basename(filePath));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { snippetFile, reset, paths } = parseArgs(process.argv.slice(2));

  if (!snippetFile) {
    console.error("error: --snippetFile=<path> is required");
    process.exit(1);
  }
  if (paths.length === 0) {
    console.error("error: at least one <dir-or-file> is required");
    process.exit(1);
  }

  let snippets = {};
  if (!reset) {
    try {
      snippets = JSON.parse(fs.readFileSync(snippetFile, "utf8") || "{}");
    } catch {
      snippets = {};
    }
  }

  let scanned = 0;
  for (const root of paths) {
    if (!fs.existsSync(root)) {
      console.warn(`warning: path does not exist, skipping: ${root}`);
      continue;
    }
    for (const file of walk(root)) {
      if (!LANGUAGES[path.extname(file)]) continue;
      try {
        extractFromFile(file, snippets);
        scanned++;
      } catch (e) {
        console.warn(`warning: failed to process ${file}: ${e.message}`);
      }
    }
  }

  fs.mkdirSync(path.dirname(snippetFile), { recursive: true });
  fs.writeFileSync(snippetFile, JSON.stringify(snippets, null, 2) + "\n");
  console.log(`extracted ${Object.keys(snippets).length} snippet(s) from ${scanned} file(s) -> ${snippetFile}`);
}

// Run as a CLI only when executed directly, so tests can import the internals.
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}

export { extractFromSource, extractFromFile, parseSnippetName, LANGUAGES };
