#!/usr/bin/env node
// Local test harness for the snippet extractor: a web page where you paste
// annotated source and immediately see the snippets the extractor would
// produce. Runs the real extractFromSource(), and renders each result through
// the real <snippet-viewer> component, so the preview is exactly what CI emits
// and exactly what docs readers see.
//
// Usage:
//   npm run harness            # -> http://localhost:8787
//   node harness.mjs --port=9000

import fs from "fs";
import http from "http";
import path from "path";
import url from "url";
import { extractFromSource, LANGUAGES } from "./extractSnippets.mjs";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? Number(portArg.slice("--port=".length)) : 8787;

// Latest extraction result. The page requests it as /v/<n>/snippets.json,
// bumping <n> per extraction to bust the viewer component's URL-keyed cache.
let latest = {};

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && pathname === "/") {
    return send(res, 200, fs.readFileSync(path.join(here, "harness.html")), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/snippet-viewer.js") {
    return send(res, 200, fs.readFileSync(path.join(here, "..", "snippet-viewer.js")), "text/javascript; charset=utf-8");
  }
  if (req.method === "GET" && (pathname === "/snippets.json" || /^\/v\/\d+\/snippets\.json$/.test(pathname))) {
    return send(res, 200, JSON.stringify(latest, null, 2), "application/json");
  }
  if (req.method === "GET" && pathname === "/extensions") {
    return send(res, 200, JSON.stringify(Object.keys(LANGUAGES)), "application/json");
  }
  if (req.method === "POST" && pathname === "/extract") {
    try {
      const { source = "", filename = "" } = JSON.parse((await readBody(req)) || "{}");
      const ext = path.extname(filename);
      if (!LANGUAGES[ext]) {
        return send(
          res,
          400,
          JSON.stringify({ error: `unsupported extension "${ext}" — known: ${Object.keys(LANGUAGES).join(" ")}` }),
          "application/json"
        );
      }
      latest = extractFromSource(source, ext, {}, path.basename(filename));
      return send(res, 200, JSON.stringify({ snippets: latest }), "application/json");
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
  }
  send(res, 404, "not found", "text/plain");
});

server.listen(PORT, () => {
  console.log(`snippet harness -> http://localhost:${PORT}`);
});
