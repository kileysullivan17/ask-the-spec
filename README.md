# Ask the Spec

A small RAG app over the Anomaly Upload Validator's five published, redacted specification documents. Every answer cites the section it came from, and it refuses when the documents don't say or when the answer is withheld.

## Pipeline

1. `scripts/chunk.py corpus data/chunks.json` splits the five pages into citable chunks (one per test case, requirement, field, user story or section).
2. `scripts/scan.py <sanitized_dir> data/chunks.json` checks every chunk against the withheld vocabulary. Run it on the Mac that holds the pre-redaction archive; any hit fails. `data/chunks.json` is committed only after it passes.
3. `npm run build` (the Vercel build step) embeds the chunks with Voyage into `data/index.json`.
4. `api/ask.js` answers questions: hybrid keyword and embedding retrieval, a low-score refusal, Claude with an answer-only-from-excerpts prompt, a citation check and a banned-name check.

## Environment variables (Vercel)

- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`
- `ANSWER_MODEL` (optional, default `claude-haiku-5-5`)
- `MIN_DENSE` (optional refusal threshold, default `0.3`, tuned by the evaluation)
