// Decides pass or fail for a promptfoo run against thresholds.json.
//   node eval/promptfoo/gate.mjs <canaries.json> <main.json>
// Prints a per-metric table (also to the GitHub job summary when run in
// Actions), lists every miss with the question and the answer, and exits 1 if
// any metric is below its minimum or any question errored.

import { readFileSync, appendFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node eval/promptfoo/gate.mjs <promptfoo-output.json> [more.json]");
  process.exit(2);
}
const thresholds = JSON.parse(readFileSync(new URL("./thresholds.json", import.meta.url)));
const rows = files.flatMap((f) => JSON.parse(readFileSync(f)).results.results);

const tally = {};
const misses = [];
const errors = [];
for (const r of rows) {
  const id = r.vars?.id;
  // A provider error means the question never got an answer: no metric was scored.
  if (r.error && !r.gradingResult?.componentResults?.length) {
    errors.push({ id, q: r.vars?.question, error: r.error });
    continue;
  }
  for (const c of r.gradingResult?.componentResults || []) {
    const m = c.assertion?.metric;
    if (!m) continue;
    tally[m] ??= { pass: 0, scored: 0 };
    tally[m].scored++;
    if (c.pass) tally[m].pass++;
    else {
      let answer = "";
      try {
        answer = JSON.parse(r.response?.output || r.vars?.canned || "{}").answer || "";
      } catch {}
      misses.push({ id, metric: m, q: r.vars?.question ?? r.testCase?.description, answer, reason: c.reason });
    }
  }
}

const lines = [];
let failed = false;
lines.push("| Metric | Passed | Minimum | Result |", "| --- | --- | --- | --- |");
for (const [m, t] of Object.entries(thresholds)) {
  if (m.startsWith("_") || m === "maxErrors") continue;
  const got = tally[m]?.pass ?? 0;
  const ok = got >= t.min;
  if (!ok) failed = true;
  lines.push(`| ${m} | ${got} of ${t.of} | ${t.min} | ${ok ? "pass" : "FAIL"} |`);
}
if (errors.length > (thresholds.maxErrors ?? 0)) failed = true;

const report = [
  `## Eval gate: ${failed ? "FAILED" : "passed"}`,
  "",
  ...lines,
  "",
  errors.length ? `**${errors.length} question(s) errored and were not scored:**` : "",
  ...errors.map((e) => `- ${e.id}: ${e.error}`),
  misses.length ? "**Misses:**" : "",
  ...misses.map((x) => `- ${x.id} (${x.metric}): ${x.q}\n  - Answer: ${x.answer || "(none)"}\n  - Why: ${(x.reason || "").split("\n")[0]}`),
]
  .filter((l) => l !== "")
  .join("\n");

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + "\n");
process.exit(failed ? 1 : 0);
