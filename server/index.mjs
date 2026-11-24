// Runs Ask the Spec as an ordinary Node server, so the same app ships as a
// container to any host, not only Vercel. It serves the same handlers
// Vercel runs (api/ask.js, api/mcp.js) and the same static page (public/),
// through a thin adapter that adds the few request and response helpers
// Vercel provides (req.body, req.query, res.status, res.json).
//
// GET /health reports whether the index is loaded and tracing is on, for the
// host's health checks and the CI smoke test. No secrets in it.
//
//   PORT=8080 node server/index.mjs

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import askHandler from "../api/ask.js";
import mcpHandler from "../api/mcp.js";
import { load, ANSWER_MODEL } from "../lib/answer.mjs";
import { TRACING } from "../lib/trace.mjs";

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = new URL("../public/", import.meta.url).pathname;
const MAX_BODY = 64 * 1024;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function adapt(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

async function readBody(req) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    parts.push(chunk);
  }
  const text = Buffer.concat(parts).toString("utf8");
  if (!text) return undefined;
  if (!String(req.headers["content-type"] || "").includes("application/json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

async function serveStatic(path, res) {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return res.status(404).end("Not found");
  try {
    const data = await readFile(file);
    res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.status(404).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  adapt(res);
  const url = new URL(req.url, "http://localhost");
  req.query = Object.fromEntries(url.searchParams);
  try {
    if (url.pathname === "/health") {
      const { index } = load();
      return res.status(200).json({ ok: true, chunks: index.chunks.length, answerModel: ANSWER_MODEL, tracing: TRACING });
    }
    if (url.pathname === "/api/ask" || url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      if (req.method === "POST") req.body = await readBody(req);
      return url.pathname === "/api/ask" ? askHandler(req, res) : mcpHandler(req, res);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end("Method not allowed");
    return serveStatic(url.pathname, res);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : "Internal error." });
    if (!err.status) console.error(err);
  }
});

// Load the index before taking traffic, so a missing or broken index fails
// the container at start instead of on the first question.
const { index } = load();
server.listen(PORT, () => console.log(`Ask the Spec on :${PORT}, ${index.chunks.length} excerpts loaded`));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
