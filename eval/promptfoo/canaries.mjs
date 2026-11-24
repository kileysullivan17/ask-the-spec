// Grader canaries: checks the grader before trusting it.
// Six hand-written answers built on real excerpts from data/chunks.json. Three
// are faithful and must pass the faithfulness rubric; three each break it in
// one known way (wrong version, invented metric, a withheld value filled in)
// and must fail it. If the grader lets a broken answer through, the
// faithfulness scores in the main run mean nothing, so the gate stops there.
//
// The invented values below are plainly synthetic and appear in no document.

import { readFileSync } from "node:fs";
import { faithfulness } from "./rubric.mjs";

const chunks = new Map(
  JSON.parse(readFileSync(new URL("../../data/chunks.json", import.meta.url))).map((c) => [c.id, c])
);
const answered = (answer, ids) =>
  JSON.stringify({
    status: "answered",
    answer,
    cited: ids.map((id, i) => {
      const c = chunks.get(id);
      if (!c) throw new Error(`Canary cites a missing chunk: ${id}`);
      return { n: i + 1, id, label: `${c.doc}, ${c.label}`, text: c.text };
    }),
  });

const cases = [
  {
    id: "C1",
    good: true,
    note: "faithful",
    output: answered(
      "Serial Number was demoted from Required to Conditional in v1.2, because real exports showed it is not consistently available, so an empty value no longer raises a flag [1].",
      ["release-notes-005"]
    ),
  },
  {
    id: "C2",
    good: false,
    note: "wrong version",
    output: answered(
      "Serial Number was demoted from Required to Conditional in v2.4, because real exports showed it is not consistently available, so an empty value no longer raises a flag [1].",
      ["release-notes-005"]
    ),
  },
  {
    id: "C3",
    good: false,
    note: "invented metric",
    output: answered(
      "Serial Number was made optional in v1.2 because it is not consistently available in real exports, which cut rejected uploads by 40 percent [1].",
      ["release-notes-005"]
    ),
  },
  {
    id: "C4",
    good: true,
    note: "faithful",
    output: answered(
      "ISBLANK was replaced with LEN in v2.1 because ISBLANK returns FALSE for empty-string cells, which left a trailing dash on the derived value when Subtype was empty [1].",
      ["release-notes-008"]
    ),
  },
  {
    id: "C5",
    good: true,
    note: "faithful, names the withheld value as withheld",
    output: answered(
      "The Platform A value for a Type with a Subtype is withheld in the published documents; the test case shows it only as a withheld marker [1].",
      ["test-cases-037"]
    ),
  },
  {
    id: "C6",
    good: false,
    note: "fills in a withheld value",
    output: answered(
      "When both Type and Subtype are populated, Platform A receives the value Category Q-9 [1].",
      ["test-cases-037"]
    ),
  },
];

export default function generateTests() {
  return cases.map((c) => ({
    description: `${c.id} ${c.good ? "should pass" : "should fail"}: ${c.note}`,
    vars: { id: c.id, canned: c.output },
    assert: [{ ...faithfulness, type: c.good ? "llm-rubric" : "not-llm-rubric", metric: "canary" }],
  }));
}
