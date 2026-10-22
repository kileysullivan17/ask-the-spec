// Runs eval/questions.json against the live site and scores it.
//   node scripts/eval.mjs [base_url]
// Retrieval hit: an expected chunk is among the 5 retrieved.
// Citation hit: an expected chunk is cited in the answer.
// Refusal: a "refuse" question must come back not_covered, or (for "withheld")
// say the values are withheld.
// Answers are saved for hand grading; nothing here judges whether they are right.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.argv[2] || "https://ask.kileysullivan.com";
const questions = JSON.parse(readFileSync(new URL("../eval/questions.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

for (const item of questions) {
  const res = await fetch(`${BASE}/api/ask?debug=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: item.q }),
  });
  const data = await res.json();
  const retrieved = data.debug?.retrieved || [];
  const cited = (data.citations || []).map((c) => c.id);
  const row = { id: item.id, q: item.q, status: data.status, answer: data.answer, cited, retrieved, bestDense: data.debug?.bestDense };
  if (item.expect) {
    row.retrievalHit = item.expect.some((e) => retrieved.includes(e));
    row.citationHit = item.expect.some((e) => cited.includes(e));
  } else {
    const saysWithheld = /withheld|proprietary|redact/i.test(data.answer || "");
    row.refusalOk = data.status === "not_covered" || (item.refuse === "withheld" && saysWithheld);
  }
  results.push(row);
  const mark = item.expect ? `${row.retrievalHit ? "R" : "-"}${row.citationHit ? "C" : "-"}` : row.refusalOk ? "ok" : "FAIL";
  console.log(`${item.id} ${mark.padEnd(4)} ${data.status.padEnd(12)} ${item.q}`);
  await sleep(1500);
}

const answerable = results.filter((r) => "retrievalHit" in r);
const refusals = results.filter((r) => "refusalOk" in r);
const pct = (n, d) => `${n} of ${d} (${Math.round((100 * n) / d)}%)`;
const summary = {
  run: new Date().toISOString(),
  base: BASE,
  retrieval: pct(answerable.filter((r) => r.retrievalHit).length, answerable.length),
  citation: pct(answerable.filter((r) => r.citationHit).length, answerable.length),
  refusals: pct(refusals.filter((r) => r.refusalOk).length, refusals.length),
};
console.log("\nRight section retrieved:", summary.retrieval);
console.log("Right section cited:    ", summary.citation);
console.log("Correct refusals:       ", summary.refusals);

mkdirSync(new URL("../eval/results/", import.meta.url), { recursive: true });
const file = new URL(`../eval/results/run-${summary.run.slice(0, 19).replace(/:/g, "")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ summary, results }, null, 1));
console.log("\nSaved:", file.pathname);
