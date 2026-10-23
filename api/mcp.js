// POST /mcp (rewritten to /api/mcp): the Ask the Spec MCP server over
// Streamable HTTP. Stateless: every request builds a fresh server and
// transport, so it fits a serverless function and needs no session store.
// No sign-in, because the spec it serves is already public on
// kileysullivan.com. Same best-effort per-visitor rate limit idea as
// /api/ask; the real backstop is still the monthly spend limits.

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../lib/mcp-server.mjs";
import { ask, load, MIN_DENSE, NOT_COVERED } from "../lib/answer.mjs";
import { embed } from "../lib/voyage.mjs";

const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 60;
const seen = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (seen.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  seen.set(ip, recent);
  return recent.length > PER_WINDOW;
}

function rpcError(res, status, code, message) {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

// Browser-based MCP clients (the MCP Inspector, for one) need CORS. Nothing
// here uses cookies or credentials, so an open origin is safe.
function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id"
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
}

export function makeHandler(deps = { load, embed, ask, minDense: MIN_DENSE, notCovered: NOT_COVERED }) {
  return async function handler(req, res) {
    cors(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
      res.setHeader("allow", "POST, OPTIONS");
      return rpcError(res, 405, -32000, "Method not allowed. This MCP server is stateless; send POST.");
    }
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    if (limited(ip)) return rpcError(res, 429, -32000, "Too many requests this hour. Try again later.");

    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error.");
    }
  };
}

export default makeHandler();
