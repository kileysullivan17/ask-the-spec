# Ask the Spec

A small RAG app over the Anomaly Upload Validator's five published, redacted specification documents. Every answer cites the section it came from, and it refuses when the documents don't say or when the answer is withheld.

## Pipeline

1. `scripts/chunk.py corpus data/chunks.json` splits the five pages into citable chunks (one per test case, requirement, field, user story or section).
2. `scripts/scan.py <sanitized_dir> data/chunks.json` checks every chunk against the withheld vocabulary. Run it on the Mac that holds the pre-redaction archive; any hit fails. `data/chunks.json` is committed only after it passes.
3. `npm run build` (the Vercel build step) embeds the chunks with Voyage into `data/index.json`.
4. `api/ask.js` answers questions: hybrid keyword and embedding retrieval, a low-score refusal, Claude with an answer-only-from-excerpts prompt, a citation check and a banned-name check.

## MCP server

`https://ask.kileysullivan.com/mcp` serves the same spec to MCP clients such as Claude, over Streamable HTTP. It is stateless (one server per request, no sessions) and needs no sign-in, because the documents are already public. Code: `api/mcp.js` (HTTP, CORS, rate limit) and `lib/mcp-server.mjs` (the tools).

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_documents` | The five documents, excerpt counts and sections | Free |
| `get_section` | One excerpt in full, by chunk id (`prd-016`) or spec id (`TC-38`, `FR-02.3`, `v2.5`) | Free |
| `search_spec` | Hybrid retrieval only: top excerpts with ids and URLs, or a refusal on a low score | One Voyage query embedding |
| `ask_spec` | The full pipeline behind `/api/ask`: a cited answer or a refusal | Voyage plus one Claude call |

To connect it in Claude, add a custom connector with the URL above. `npm test` runs the MCP tests over real HTTP with stubbed embeddings and answers, so it needs no API keys.

## Environment variables (Vercel)

- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`
- `ANSWER_MODEL` (optional, default `claude-haiku-5-5`)
- `MIN_DENSE` (optional refusal threshold, default `0.3`, tuned by the evaluation)
