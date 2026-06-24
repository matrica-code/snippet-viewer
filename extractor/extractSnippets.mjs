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
// Marker conventions (identical to the original):
//   // extract-code <name>        -> export the node that follows this comment
//   // extract-code ignore        -> strip the following node from any snippet it lives in
//
// Behaviors preserved from the jscodeshift version:
//   * snippet keys are `<name>@<basename>` so the same name in two files is safe
//   * if the marked node is an import (whole-file trigger), the ENTIRE file is emitted
//   * the existing snippet file is merged into, not overwritten
//   * whole-file snippets do NOT honor `ignore` (only node-mode snippets do) — faithful
//     to the original, where ignore removal only affected AST-serialized nodes.

import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Language registry. Grammars are loaded lazily so a project that never touches
// Java doesn't need tree-sitter-java installed, and vice versa.
// ---------------------------------------------------------------------------
const LANGUAGES = {
  ".ts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"] },
  ".tsx": { load: () => require("tree-sitter-typescript").tsx, comments: ["comment"], wholeFile: ["import_statement"] },
  ".mts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"] },
  ".cts": { load: () => require("tree-sitter-typescript").typescript, comments: ["comment"], wholeFile: ["import_statement"] },
  ".js": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"] },
  ".jsx": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"] },
  ".mjs": { load: () => require("tree-sitter-javascript"), comments: ["comment"], wholeFile: ["import_statement"] },
  ".java": { load: () => require("tree-sitter-java"), comments: ["line_comment", "block_comment"], wholeFile: ["import_declaration"] },
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

// The source span a marker comment applies to. Returns the next named,
// non-comment sibling, but normalizes two grammar quirks so the snippet matches
// what a real pretty-printer (recast/toSource) would emit:
//   * method decorators are *separate* siblings — extend the span across the
//     decorator run to include the declaration it decorates
//   * a trailing `;` after a field/declaration sits outside the node — swallow it
function unitFor(comment, commentTypes, source) {
  let n = comment.nextNamedSibling;
  while (n && commentTypes.includes(n.type)) n = n.nextNamedSibling;
  if (!n) return null;

  const startNode = n;
  let endNode = n;
  if (n.type === "decorator") {
    let m = n;
    while (m && m.type === "decorator") {
      endNode = m;
      m = m.nextNamedSibling;
    }
    if (m) endNode = m; // the decorated declaration itself
  }

  let endIndex = endNode.endIndex;
  let e = endIndex;
  while (e < source.length && /\s/.test(source[e])) e++;
  if (source[e] === ";") endIndex = e + 1;

  return {
    startIndex: startNode.startIndex,
    endIndex,
    startPosition: startNode.startPosition,
    type: n.type,
  };
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

function parseSnippetName(commentText) {
  // commentText includes the comment delimiters, e.g. "// extract-code timer"
  // or "/* extract-code Foo */". Strip delimiters, take what follows the marker.
  const after = commentText.split("extract-code ")[1] ?? "";
  return after
    .replace(/\*\/\s*$/, "") // trailing block-comment close
    .replace(/\r?\n[\s\S]*$/, "") // anything past the first line
    .trim();
}

// ---------------------------------------------------------------------------
// Per-file extraction
// ---------------------------------------------------------------------------
function extractFromFile(filePath, snippets) {
  const ext = path.extname(filePath);
  const entry = getParser(ext);
  if (!entry) return; // not a language we know — skip silently

  const { parser, cfg } = entry;
  const source = fs.readFileSync(filePath, "utf8");
  const tree = parser.parse(source);
  const basename = path.basename(filePath);

  const comments = collectComments(tree.rootNode, cfg.comments);

  // Pass 1: gather ignore ranges (line-expanded) so node-mode snippets can splice them out.
  const ignoreRanges = [];
  for (const comment of comments) {
    if (!comment.text.includes("extract-code ignore")) continue;
    const unit = unitFor(comment, cfg.comments, source);
    if (!unit) continue;
    ignoreRanges.push(expandToFullLines(source, comment.startIndex, unit.endIndex));
  }

  // Pass 2: emit named snippets.
  for (const comment of comments) {
    if (!comment.text.includes("extract-code")) continue;
    if (comment.text.includes("extract-code ignore")) continue;

    const name = parseSnippetName(comment.text);
    if (!name) continue;
    const key = `${name}@${basename}`;

    const unit = unitFor(comment, cfg.comments, source);
    if (!unit) continue;

    // Whole-file mode: marker leads an import -> emit the full source.
    if (cfg.wholeFile.includes(unit.type)) {
      snippets[key] = source.replace(/^\s*\/\/ extract-code.*\r?\n/, "");
      continue;
    }

    // Node mode: slice the unit's exact span, then splice out any nested ignores.
    let text = source.slice(unit.startIndex, unit.endIndex);
    const inner = ignoreRanges
      .filter(([s, e]) => s >= unit.startIndex && e <= unit.endIndex)
      .sort((a, b) => b[0] - a[0]); // descending so earlier splices don't shift later offsets
    for (const [s, e] of inner) {
      const rs = s - unit.startIndex;
      const re = e - unit.startIndex;
      text = text.slice(0, rs) + text.slice(re);
    }

    // Re-indent to column 0, matching jscodeshift's toSource() output: the first
    // line already starts at the node, but continuation lines keep their in-source
    // indentation, so strip the node's base column from each subsequent line.
    const baseCol = unit.startPosition.column;
    if (baseCol > 0) {
      text = text
        .split("\n")
        .map((line, i) => (i === 0 ? line : line.replace(new RegExp(`^[ \\t]{0,${baseCol}}`), "")))
        .join("\n");
    }

    snippets[key] = text.replace(/^\/\/ extract-code.*\r?\n/, "").trimEnd();
  }
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
  if (reset) {
    snippets = {};
  } else {
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

main();
