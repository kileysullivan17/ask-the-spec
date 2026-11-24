// Tracing is off without Langfuse keys: every call is a no-op and the
// pipeline behaves exactly as before. (The on path is exercised against a
// stand-in Langfuse server before release; it needs keys set at import time.)
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.LANGFUSE_PUBLIC_KEY;
delete process.env.LANGFUSE_SECRET_KEY;
const { startTrace, TRACING } = await import("../lib/trace.mjs");

test("tracing is off without keys", () => {
  assert.equal(TRACING, false);
});

test("an off trace passes values through and sends nothing", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("{}");
  };
  try {
    const t = startTrace({ question: "q", source: "web" });
    const v = await t.step("retrieve", async (span) => {
      span.set({ output: [1] });
      return 42;
    });
    assert.equal(v, 42);
    t.generation({ name: "answer" });
    t.event("refused", { reason: "low_score" });
    await t.finish({ output: {} });
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an off trace still rethrows step errors", async () => {
  const t = startTrace({ question: "q", source: "web" });
  await assert.rejects(t.step("embed", async () => { throw new Error("boom"); }), /boom/);
});
