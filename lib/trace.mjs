// Langfuse tracing for one question, sent as OpenTelemetry spans (OTLP over
// HTTP with JSON) to Langfuse's OTEL endpoint. No SDK: the payload is built
// here with the attribute names Langfuse maps
// (langfuse.com/integrations/native/opentelemetry).
//
// Langfuse's older batch ingestion API was shut down for traces on
// 2026-11-16 and answers 410; this file was first written against it.
//
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set: every method
// is then a no-op, and tests and local runs send nothing. Tracing never
// changes an answer or fails a request: send errors are logged and dropped.
//
// What a trace holds: the question, each pipeline step with its timing
// (embed, retrieve, answer), the model calls' token usage, the outcome, and
// why a question was refused. No IP address or other visitor detail.

import { randomBytes } from "node:crypto";

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

const hex = (bytes) => randomBytes(bytes).toString("hex");
const nanos = (ms) => `${BigInt(Math.round(ms)) * 1000000n}`;

// OTLP JSON attribute values. Objects are sent as JSON strings, as Langfuse
// expects for input, output and usage.
function value(v) {
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (v && typeof v === "object") return { stringValue: JSON.stringify(v) };
  return { stringValue: String(v) };
}
function attributes(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: value(v) }));
}
// Metadata goes in one attribute per key under the given prefix.
function prefixed(prefix, obj = {}) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${prefix}.${k}`, v]));
}

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
  const traceId = hex(16);
  const rootId = hex(8);
  const start = Date.now();
  const spans = [];

  const child = ({ name, startMs, endMs = Date.now(), attrs, error }) =>
    spans.push({
      traceId,
      spanId: hex(8),
      parentSpanId: rootId,
      name,
      kind: 1,
      startTimeUnixNano: nanos(startMs),
      endTimeUnixNano: nanos(endMs),
      attributes: attributes(attrs),
      status: error ? { code: 2, message: error } : { code: 1 },
    });

  return {
    id: traceId,

    // Times fn as a span. fn gets { set({ output, metadata }) }.
    async step(name, fn, input) {
      const startMs = Date.now();
      const extra = {};
      let error;
      try {
        return await fn({ set: (f) => Object.assign(extra, f) });
      } catch (err) {
        error = String(err.message).slice(0, 300);
        throw err;
      } finally {
        child({
          name,
          startMs,
          error,
          attrs: {
            "langfuse.observation.type": "span",
            "langfuse.observation.input": input,
            "langfuse.observation.output": extra.output,
            ...(error ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": error } : {}),
            ...prefixed("langfuse.observation.metadata", extra.metadata),
          },
        });
      }
    },

    // One model call with its token usage. Langfuse derives cost from the
    // model name and its price table.
    generation({ name, model, startTime, input, output, usage, metadata }) {
      child({
        name,
        startMs: startTime ? Date.parse(startTime) : Date.now(),
        attrs: {
          "langfuse.observation.type": "generation",
          "langfuse.observation.model.name": model,
          "langfuse.observation.input": input,
          "langfuse.observation.output": output,
          "langfuse.observation.usage_details": usage,
          ...prefixed("langfuse.observation.metadata", metadata),
        },
      });
    },

    // A point-in-time note, such as a guardrail firing.
    event(name, metadata) {
      const t = Date.now();
      child({
        name,
        startMs: t,
        endMs: t,
        attrs: { "langfuse.observation.type": "event", ...prefixed("langfuse.observation.metadata", metadata) },
      });
    },

    finish({ output, tags = [], metadata }) {
      const error = output?.error;
      spans.unshift({
        traceId,
        spanId: rootId,
        name: "ask",
        kind: 2,
        startTimeUnixNano: nanos(start),
        endTimeUnixNano: nanos(Date.now()),
        attributes: attributes({
          "langfuse.trace.name": "ask",
          "langfuse.trace.tags": [source, ...tags],
          "langfuse.observation.type": "span",
          "langfuse.observation.input": { question },
          "langfuse.observation.output": output,
          ...(error ? { "langfuse.observation.level": "ERROR", "langfuse.observation.status_message": error } : {}),
          ...prefixed("langfuse.trace.metadata", { source, ...metadata }),
        }),
        status: error ? { code: 2, message: error } : { code: 1 },
      });
      const body = {
        resourceSpans: [
          {
            resource: { attributes: attributes({ "service.name": "ask-the-spec" }) },
            scopeSpans: [{ scope: { name: "ask-the-spec" }, spans }],
          },
        ],
      };
      const send = fetch(`${BASE}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-langfuse-ingestion-version": "4",
          authorization: `Basic ${Buffer.from(`${PUBLIC}:${SECRET}`).toString("base64")}`,
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          if (!res.ok) return console.error(`Langfuse ${res.status}: ${text.slice(0, 300)}`);
          // OTLP reports spans it dropped in partialSuccess.
          let partial;
          try {
            partial = JSON.parse(text).partialSuccess;
          } catch {}
          if (partial?.rejectedSpans && Number(partial.rejectedSpans) > 0) {
            console.error(`Langfuse rejected ${partial.rejectedSpans} span(s): ${partial.errorMessage || ""}`.slice(0, 300));
          }
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
