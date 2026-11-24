# Eval gate (promptfoo)

A second evaluation of Ask the Spec, built with promptfoo instead of the tooling that built the product, and wired into CI so a regression fails the deploy's check.

It uses the same 30 questions as `scripts/eval.mjs` (`eval/questions.json`) and calls a deployed `/api/ask` the way a visitor does, so it tests the real retrieval, threshold, model call and citation check together.

## What it scores

| Metric | Check | Graded by |
| --- | --- | --- |
| retrieval | An expected excerpt is in the top 5 retrieved | Code |
| citation | The answer cites an expected excerpt | Code |
| refusal | A must-refuse question is refused, or says a withheld value is withheld | Code |
| faithfulness | Every claim in the answer is supported by the excerpts it cites | Claude Sonnet, a different and larger model than the Haiku model that writes the answers |
| canary | The grader passes three known-good answers and fails three known-bad ones | Claude Sonnet |

Faithfulness is the check the original runner could not make: it saved answers for hand grading. The grader reads each answer next to the full text of the excerpts it cites, looked up from `data/chunks.json`.

## Grading the grader

A model-graded score is only worth something if the grader catches bad answers. `canaries.mjs` holds six hand-written answers built on real excerpts. Three are faithful. Three each break faithfulness in one known way: a wrong version number, an invented metric, and a withheld value filled in with a made-up one. The gate requires all six to be judged correctly before it trusts the faithfulness scores. A grader that passes everything fails the canaries.

## Thresholds

`thresholds.json` sets the minimum passing count per metric. Refusals and canaries allow no misses, since a missed refusal is a leak or an invented answer. The others allow one miss each, because answers vary between runs and the answer model can't be made fully repeatable. Promptfoo's own exit code is turned off (`PROMPTFOO_PASS_RATE_THRESHOLD=0`); `gate.mjs` decides, prints a table and every miss, and writes the same report to the GitHub job summary.

## Results

First run, 2026-11-23, against the live site ([run](https://github.com/kileysullivan17/ask-the-spec/actions/runs/45345251852)):

| Metric | Passed | Minimum |
| --- | --- | --- |
| canary | 6 of 6 | 6 |
| refusal | 5 of 5 | 5 |
| retrieval | 25 of 25 | 24 |
| citation | 25 of 25 | 24 |
| faithfulness | 27 of 27 | 26 |

The grader rejected all three broken canaries in the same run, so the faithfulness score is not a grader that passes everything.

## Running it

```
ANTHROPIC_API_KEY=... npm run eval:gate                                   # live site
ANTHROPIC_API_KEY=... ASK_BASE_URL=https://<preview-url> npm run eval:gate  # a preview
```

`npm run eval:canaries` and `npm run eval:pf` run the two halves alone. `npx promptfoo@0.126.0 view` opens the results in promptfoo's viewer.

## In CI

`.github/workflows/eval-gate.yml` runs on every successful Vercel deployment, using the `vercel.deployment.success` event Vercel sends to GitHub, against that deployment's URL. It then posts an "Eval gate" status on the deployed commit, so the result shows on the pull request. GitHub only delivers that event to workflows on the default branch, so the gate starts firing once this file is on `main`. It can also be run by hand against any URL from the Actions tab. It needs:

- `ANTHROPIC_API_KEY` as a repository secret, for the grader.
- `VERCEL_AUTOMATION_BYPASS_SECRET`, only if preview deployments are protected (Vercel, Settings, Deployment Protection, Protection Bypass for Automation).
- `BANNED_NAMES` set for the Preview environment in Vercel. Without it the app fails closed and refuses everything, and the gate fails on citation.

To block merges on it, make "Eval gate" a required status check on `main`. If runs never start, check that repository dispatch events are on in the Vercel project's Git settings.

One full run is 30 questions to the app plus 33 grader calls.
