// Builds the promptfoo test cases from eval/questions.json, the same 30
// questions the original runner (scripts/eval.mjs) uses, so both tools score
// one question set.
//
// Metrics, one per assertion:
//   retrieval     an expected excerpt is in the top 5 retrieved
//   citation      the answer cites an expected excerpt
//   refusal       a must-refuse question is refused (or, for withheld values,
//                 says the value is withheld)
//   faithfulness  a grader model, not the answer model, checks that every
//                 claim in the answer is supported by the excerpts it cites
//
// Pass or fail for the build is decided by gate.mjs against thresholds.json,
// not by promptfoo's own exit code.

import { readFileSync } from "node:fs";
import { faithfulness } from "./rubric.mjs";

const questions = JSON.parse(readFileSync(new URL("../questions.json", import.meta.url)));

export default function generateTests() {
  return questions.map((item) => {
    // expect is passed as a JSON string: promptfoo expands an array var into one
    // test per element, which would split a multi-excerpt question into several.
    const vars = { id: item.id, question: item.q, expect: JSON.stringify(item.expect || []), refuse: item.refuse || "" };
    const assert = [];
    if (item.expect) {
      assert.push({
        type: "javascript",
        metric: "retrieval",
        value: `const r = JSON.parse(output);
return JSON.parse(context.vars.expect).some((e) => r.retrieved.includes(e));`,
      });
      assert.push({
        type: "javascript",
        metric: "citation",
        value: `const r = JSON.parse(output);
return r.status === "answered" && JSON.parse(context.vars.expect).some((e) => r.cited.some((c) => c.id === e));`,
      });
      assert.push(faithfulness);
    } else {
      assert.push({
        type: "javascript",
        metric: "refusal",
        value: `const r = JSON.parse(output);
const saysWithheld = /withheld|proprietary|redact/i.test(r.answer || "");
return r.status === "not_covered" || (context.vars.refuse === "withheld" && saysWithheld);`,
      });
      // A withheld-value question may be answered with "that value is withheld";
      // make sure such an answer did not slip a value in.
      if (item.refuse === "withheld") assert.push(faithfulness);
    }
    return { description: `${item.id} ${item.q}`, vars, assert };
  });
}
