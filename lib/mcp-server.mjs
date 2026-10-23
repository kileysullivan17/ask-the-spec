// The MCP server behind /mcp. It exposes the same published spec that
// /api/ask answers from, as four tools an assistant like Claude can call:
//
//   list_documents  what the five documents are and how they are split up
//   search_spec     hybrid retrieval only: the top excerpts, no generated answer
//   get_section     one excerpt, by chunk id (prd-016) or spec id (TC-38, FR-02.3, v2.5)
//   ask_spec        the full Ask the Spec pipeline: a cited answer or a refusal
//
// Only search_spec and ask_spec cost money (a Voyage query embedding, plus a
// Claude call for ask_spec). list_documents and get_section read the prebuilt
// index and call nothing. Every excerpt returned already passed scripts/scan.py.
//
// Dependencies are passed in so the tests can run without API keys.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { retrieve, idsIn } from "./retrieve.mjs";

export const SERVER_NAME = "ask-the-spec";
export const SERVER_VERSION = "1.0.0";
const MAX_TEXT = 1500;

const INSTRUCTIONS = `This server answers questions about the published specification of the Anomaly Upload Validator, an internal data-preparation tool: a PRD, user stories, test cases, a data dictionary and release notes. Use search_spec or ask_spec to find things, get_section to read one excerpt in full, and list_documents for an overview. Cite the excerpt URL when you use what a tool returns. Some values are withheld because the conversion tables are proprietary; never guess them. The documents do not name any company, client or vendor, and neither should you.`;

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function clip(s) {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} [excerpt shortened; call get_section for the rest]` : s;
}

function formatChunk(c, { full = false } = {}) {
  return `${c.doc}, ${c.label} (id: ${c.id})\nSection: ${c.section}\nURL: ${c.url}\n\n${full ? c.text : clip(c.text)}`;
}

// Finds a chunk by its chunk id, or by a spec id like TC-38 or v2.5.
export function findChunk(chunks, ref) {
  const want = String(ref || "").trim();
  if (!want) return [];
  const exact = chunks.find((c) => c.id.toLowerCase() === want.toLowerCase());
  if (exact) return [exact];
  const ids = idsIn(want);
  if (!ids.length) return [];
  const id = ids[0].toUpperCase();
  // Prefer an exact label ("TC-38"), then any label or section that starts with the id.
  const byLabel = chunks.filter((c) => c.label.toUpperCase() === id);
  if (byLabel.length) return byLabel;
  return chunks.filter(
    (c) => c.label.toUpperCase().startsWith(id) || c.section.toUpperCase().startsWith(id)
  );
}

export function buildServer({ load, embed, ask, minDense, notCovered }) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List the spec documents",
      description:
        "Lists the five published specification documents, how many citable excerpts each has, and the sections in each. Free: calls no outside service.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const { index } = load();
      const docs = new Map();
      for (const c of index.chunks) {
        if (!docs.has(c.doc)) docs.set(c.doc, { count: 0, sections: new Set(), url: c.url.split("#")[0] });
        const d = docs.get(c.doc);
        d.count += 1;
        d.sections.add(c.section);
      }
      const lines = [...docs.entries()].map(
        ([name, d]) =>
          `${name}: ${d.count} excerpts, ${d.url}\n  Sections: ${[...d.sections].join("; ")}`
      );
      return text(`${index.chunks.length} excerpts across ${docs.size} documents.\n\n${lines.join("\n\n")}`);
    }
  );

  server.registerTool(
    "get_section",
    {
      title: "Read one excerpt",
      description:
        "Returns the full text of one excerpt. Accepts a chunk id from search results (for example prd-016) or a spec id (for example TC-38, FR-02.3, US-03 or v2.5). Free: calls no outside service.",
      inputSchema: {
        ref: z.string().min(1).max(60).describe("A chunk id like prd-016, or a spec id like TC-38, FR-02.3, US-03 or v2.5"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ref }) => {
      const { index } = load();
      const found = findChunk(index.chunks, ref);
      if (!found.length) {
        return {
          ...text(`No excerpt matches "${ref}". Use search_spec to find the right id.`),
          isError: true,
        };
      }
      const shown = found.slice(0, 3);
      const more = found.length > shown.length ? `\n\n${found.length - shown.length} more excerpts also match.` : "";
      return text(shown.map((c) => formatChunk(c, { full: true })).join("\n\n---\n\n") + more);
    }
  );

  server.registerTool(
    "search_spec",
    {
      title: "Search the spec",
      description:
        "Hybrid keyword and embedding search over the spec. Returns the best-matching excerpts with their ids and URLs, but no generated answer, so you can read and reason over the source yourself. Says so when nothing matches well.",
      inputSchema: {
        query: z.string().min(3).max(300).describe("What to look for, in plain language or by id"),
        limit: z.number().int().min(1).max(8).optional().describe("How many excerpts to return (default 5)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const { index, bm } = load();
      const [qv] = await embed([query], "query");
      const r = retrieve(index, bm, query, qv, limit || 5);
      if (r.bestDense < minDense && !r.idMatched) {
        return text(`Nothing in the published spec matches that well. ${notCovered}`);
      }
      const body = r.hits
        .map((h, i) => `[${i + 1}] ${formatChunk(h.chunk)}`)
        .join("\n\n---\n\n");
      return text(body);
    }
  );

  server.registerTool(
    "ask_spec",
    {
      title: "Ask the spec",
      description:
        "Runs the full Ask the Spec pipeline: retrieves excerpts, writes a short answer only from them, and checks every citation. Returns the answer with its sources, or says the spec does not cover the question. Prefer search_spec if you want the raw excerpts.",
      inputSchema: {
        question: z.string().min(3).max(300).describe("A question about the spec"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ question }) => {
      const { status, answer, citations } = await ask(question);
      if (status !== "answered") return text(answer);
      const sources = citations.map((c) => `[${c.n}] ${c.doc}, ${c.label} (id: ${c.id}): ${c.url}`).join("\n");
      return text(`${answer}\n\nSources:\n${sources}`);
    }
  );

  return server;
}
