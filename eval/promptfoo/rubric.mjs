// The faithfulness check, shared by the main run (tests.mjs) and the grader
// canaries (canaries.mjs), so the canaries test exactly the rubric the gate uses.

// The grader is deliberately a different, larger model than the one that
// writes the answers (Haiku), so the product is not grading itself.
export const GRADER = process.env.PF_GRADER || "anthropic:messages:claude-sonnet-5-5";

// Turns the provider's JSON output into the text the grader reads.
const toGraderText = `
const r = JSON.parse(output);
if (r.status !== "answered") return "ANSWER:\\nNOT_COVERED (the tool refused)";
const ex = r.cited.map((c) => "[" + c.n + "] " + c.label + "\\n" + c.text).join("\\n\\n");
return "ANSWER:\\n" + r.answer + "\\n\\nCITED EXCERPTS:\\n" + ex;
`;

export const faithfulness = {
  type: "llm-rubric",
  metric: "faithfulness",
  provider: GRADER,
  transform: toGraderText,
  value: `You are checking an answer from a question-answering tool over product specification documents. The text has an ANSWER and the CITED EXCERPTS it relies on. Bracketed numbers in the ANSWER refer to the excerpts.

Pass only if every factual claim in the ANSWER is directly supported by the CITED EXCERPTS, including every number, version, field name and ID. Fail if the ANSWER states anything the excerpts do not support, attributes a claim to the wrong excerpt, or fills in a value the excerpts show as withheld or redacted.

If the ANSWER is NOT_COVERED, pass: a refusal makes no claims.

Judge support only. Do not judge style or length.`,
};
