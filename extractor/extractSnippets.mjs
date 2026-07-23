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

// Classify a marker comment's directive from the text after `extract-code`:
//   extract-code <name>          -> { kind: "start", name }
//   extract-code end <name>      -> { kind: "end", name }        (snippet terminator)
//   extract-code ignore          -> { kind: "ignore", names: null }   (global)
//   extract-code ignore a, b     -> { kind: "ignore", names: Set{a,b} } (scoped)
function classifyMarker(commentText) {
  const after = (commentText.split(MARKER)[1] ?? "")
    .replace(/\*\/\s*$/, "") // trailing block-comment close
    .replace(/\r?\n[\s\S]*$/, "") // anything past the first line
    .trim();
  const [head, ...rest] = after.split(/\s+/);
  const tail = rest.join(" ").trim();
  if (head === "ignore") {
    const names = tail.split(",").map((s) => s.trim()).filter(Boolean);
    return { kind: "ignore", names: names.length ? new Set(names) : null };
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
    .filter((m) => isMarker(m.comment));

  // Positions of every *start* marker, used to truncate a snippet where the
  // next one begins. Terminators and ignores are not partition boundaries.
  const markerStarts = markers
    .filter((m) => m.kind === "start" && m.name)
    .map((m) => m.comment.startIndex)
    .sort((a, b) => a - b);

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
  const ignoreRanges = [];
  for (const m of markers) {
    if (m.kind !== "ignore") continue;
    const unit = resolveUnit(m.comment, cfg, source, root);
    if (!unit) continue;
    const [s, e] = expandToFullLines(source, m.comment.startIndex, unit.maxEnd);
    ignoreRanges.push({ s, e, names: m.names });
  }

  // Pass 2: emit named snippets.
  for (const m of markers) {
    if (m.kind !== "start") continue;

    const name = m.name;
    if (!name) continue;
    const key = `${name}@${basename}`;

    const unit = resolveUnit(m.comment, cfg, source, root);
    if (!unit) continue;

    // An explicit terminator (`extract-code end <name>`) after this marker bounds
    // the snippet directly — for grouping loose statements the AST can't. The
    // earliest matching terminator past the start wins.
    const ends = (endByName.get(name) ?? []).filter((p) => p > unit.segStart);
    const terminator = ends.length ? Math.min(...ends) : null;

    // Whole-file mode: marker leads an import -> emit the full source.
    if (terminator == null && cfg.wholeFile.includes(unit.type)) {
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
      .filter(({ s, e, names }) => s >= unit.segStart && e <= endIndex && (names == null || names.has(name)))
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

    snippets[key] = text.trimEnd();
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
