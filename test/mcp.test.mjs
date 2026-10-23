// Tests the MCP endpoint end to end over real HTTP, with an MCP client from
// the SDK. No API keys needed: embeddings are a deterministic stand-in and
// ask() is stubbed. The excerpts are the real data/chunks.json.
//   npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildBm25, tokenize } from "../lib/retrieve.mjs";
import { makeHandler } from "../api/mcp.js";
import { findChunk } from "../lib/mcp-server.mjs";

const DIM = 128;
function fakeVector(textIn) {
  // One extra slot (index DIM) that no excerpt uses, so a query can be made
  // to match nothing at all.
  const v = new Array(DIM + 1).fill(0);
  for (const t of tokenize(textIn)) {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  v[0] += 0.01; // never an all-zero vector
  return v;
}

const chunks = JSON.parse(readFileSync(new URL("../data/chunks.json", import.meta.url)));
const index = {
  chunks: chunks.map((c) => ({ ...c, vector: fakeVector(`${c.doc} ${c.section} ${c.label} ${c.text}`) })),
};
const bm = buildBm25(index.chunks);
let askCalls = 0;

const deps = {
  load: () => ({ index, bm }),
  embed: async (texts) =>
    texts.map((t) => (/zzqx/.test(t) ? [...new Array(DIM).fill(0), 1] : fakeVector(t))),
  ask: async (q) => {
    askCalls += 1;
    if (/poem/i.test(q)) return { status: "not_covered", answer: "NOT COVERED STUB", citations: [] };
    const c = index.chunks.find((x) => x.label === "TC-38");
    return {
      status: "answered",
      answer: "TC-38 checks a stubbed behavior [1].",
      citations: [{ n: 1, id: c.id, doc: c.doc, label: c.label, url: c.url }],
    };
  },
  minDense: 0.3,
  notCovered: "NOT COVERED STUB",
};

// Mimics the bits of Vercel's Node runtime the handler relies on:
// a parsed JSON body and res.status().json().
const handler = makeHandler(deps);
const server = http.createServer(async (req, res) => {
  res.status = (s) => ((res.statusCode = s), res);
  res.json = (o) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  let raw = "";
  for await (const part of req) raw += part;
  req.body = raw ? JSON.parse(raw) : undefined;
  await handler(req, res);
});

let url;
let client;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
});
after(async () => {
  await client.close();
  server.close();
});

const textOf = (r) => r.content.map((c) => c.text).join("\n");

test("lists the four tools, all read-only", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_spec", "get_section", "list_documents", "search_spec"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
});

test("server sends instructions that forbid naming companies", () => {
  assert.match(client.getInstructions() || "", /do not name any company/i);
});

test("list_documents covers all five documents and every excerpt", async () => {
  const out = textOf(await client.callTool({ name: "list_documents", arguments: {} }));
  for (const d of ["PRD", "User stories", "Test cases", "Data dictionary", "Release notes"]) assert.match(out, new RegExp(d));
  assert.match(out, new RegExp(`^${chunks.length} excerpts across 5 documents`));
});

test("get_section finds an excerpt by spec id and by chunk id", async () => {
  const bySpec = textOf(await client.callTool({ name: "get_section", arguments: { ref: "TC-38" } }));
  assert.match(bySpec, /Test cases, TC-38 \(id: test-cases-039\)/);
  const byChunk = textOf(await client.callTool({ name: "get_section", arguments: { ref: "prd-016" } }));
  assert.match(byChunk, /\(id: prd-016\)/);
  assert.match(byChunk, /https:\/\/kileysullivan\.com\/artifacts\/prd#/);
});

test("get_section reports a miss as a tool error, not a crash", async () => {
  const r = await client.callTool({ name: "get_section", arguments: { ref: "nothing-here" } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /No excerpt matches/);
});

test("search_spec lands an id question on that excerpt first", async () => {
  const out = textOf(await client.callTool({ name: "search_spec", arguments: { query: "What did TC-38 test?", limit: 3 } }));
  assert.match(out, /^\[1\] Test cases, TC-38 \(id: test-cases-039\)/);
  assert.equal((out.match(/^\[\d\] /gm) || []).length, 3);
});

test("search_spec refuses when nothing matches well", async () => {
  const out = textOf(await client.callTool({ name: "search_spec", arguments: { query: "zzqx vvbk wpfj" } }));
  assert.match(out, /Nothing in the published spec matches that well/);
});

test("search_spec rejects input outside the schema", async () => {
  const r = await client.callTool({ name: "search_spec", arguments: { query: "x".repeat(400) } });
  assert.equal(r.isError, true);
});

test("ask_spec returns the answer with linked sources, and passes refusals through", async () => {
  const ok = textOf(await client.callTool({ name: "ask_spec", arguments: { question: "What did TC-38 test?" } }));
  assert.match(ok, /\[1\]\.\n\nSources:\n\[1\] Test cases, TC-38 \(id: test-cases-039\): https:/);
  const no = textOf(await client.callTool({ name: "ask_spec", arguments: { question: "Write a poem" } }));
  assert.equal(no, "NOT COVERED STUB");
  assert.equal(askCalls, 2);
});

test("GET is refused with 405 (stateless server)", async () => {
  const r = await fetch(url, { headers: { accept: "text/event-stream" } });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

test("findChunk prefers an exact label over prefix matches", () => {
  const hits = findChunk(index.chunks, "v2.5");
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((c) => c.label.toUpperCase().startsWith("V2.5") || c.section.toUpperCase().startsWith("V2.5")));
});
