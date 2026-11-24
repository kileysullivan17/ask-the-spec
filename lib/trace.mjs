// Langfuse tracing for one question, sent through Langfuse's public ingestion
// API with plain fetch, so there is no SDK to keep in step with.
//
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set: every method
// is then a no-op, and tests and local runs send nothing. Tracing never
// changes an answer or fails a request: send errors are logged and dropped.
//
// What a trace holds: the question, each pipeline step with its timing
// (embed, retrieve, answer, citation check), the answer model's token usage,
// the outcome, and why a question was refused. No IP address or other visitor
// detail is recorded.

import { randomUUID } from "node:crypto";

const BASE = (process.env.LANGFUSE_BASE_URL || "https://us.cloud.langfuse.com").replace(/\/$/, "");
const PUBLIC = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET = process.env.LANGFUSE_SECRET_KEY;
export const TRACING = Boolean(PUBLIC && SECRET);

// On Vercel, waitUntil lets the trace send after the response has gone out,
// so tracing adds no visible latency. Elsewhere the send is awaited.
let waitUntil;
try {
  ({ waitUntil } = await import("@vercel/functions"));
} catch {}

const now = () => new Date().toISOString();

const noop = {
  id: null,
  async step(name, fn) {
    return fn({ set() {} });
  },
  generation() {},
  event() {},
  finish() {},
};

// source: "web", "mcp" or "eval", so dashboards can leave evaluation runs out.
export function startTrace({ question, source }) {
  if (!TRACING) return noop;
  const traceId = randomUUID();
  const events = [];
  const push = (type, body) => events.push({ id: randomUUID(), timestamp: now(), type, body: { ...body, traceId } });

  return {
    id: traceId,

    // Times fn as a span. fn gets { set(fields) } to attach output or metadata.
    async step(name, fn, input) {
      const startTime = now();
      const extra = {};
      try {
        return await fn({ set: (f) => Object.assign(extra, f) });
      } catch (err) {
        extra.level = "ERROR";
        extra.statusMessage = String(err.message).slice(0, 300);
        throw err;
      } finally {
        push("span-create", { id: randomUUID(), name, startTime, endTime: now(), input, ...extra });
      }
    },

    // One model call, with its token usage. Langfuse derives cost from the
    // model name and its price table.
    generation({ name, model, startTime, input, output, usage, metadata }) {
      push("generation-create", {
        id: randomUUID(),
        name,
        model,
        startTime,
        endTime: now(),
        input,
        output,
        usageDetails: usage,
        metadata,
      });
    },

    // A point-in-time note, such as a guardrail firing.
    event(name, metadata) {
      push("event-create", { id: randomUUID(), name, startTime: now(), metadata });
    },

    finish({ output, tags = [], metadata }) {
      events.unshift({
        id: randomUUID(),
        timestamp: now(),
        type: "trace-create",
        body: { id: traceId, name: "ask", input: { question }, output, tags: [source, ...tags], metadata: { source, ...metadata } },
      });
      const send = fetch(`${BASE}/api/public/ingestion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${PUBLIC}:${SECRET}`).toString("base64")}`,
        },
        body: JSON.stringify({ batch: events }),
      })
        .then(async (res) => {
          const text = await res.text();
          if (!res.ok) return console.error(`Langfuse ${res.status}: ${text.slice(0, 300)}`);
          // Langfuse answers 207 with a list of any events it rejected.
          let errors = [];
          try {
            errors = JSON.parse(text).errors || [];
          } catch {}
          if (errors.length) console.error(`Langfuse rejected ${errors.length} event(s): ${JSON.stringify(errors).slice(0, 300)}`);
        })
        .catch((err) => console.error(`Langfuse send failed: ${err.message}`));
      // Await the returned value: it is the send itself only when waitUntil is missing.
      if (waitUntil) {
        waitUntil(send);
        return undefined;
      }
      return send;
    },
  };
}
