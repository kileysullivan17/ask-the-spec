# Ask the Spec

Ask a question about a real product spec and get a cited answer, or an honest "the documents don't say." Live at [ask.kileysullivan.com](https://ask.kileysullivan.com), and available as an MCP server at `https://ask.kileysullivan.com/mcp`.

It answers from the five published, redacted specification documents for the Anomaly Upload Validator, an internal data-preparation tool I built: the PRD, user stories, data dictionary, test cases and release notes.

## Problem

[CONFIRM] A spec spread across five documents is hard to query. The answer to "why did this field stop blocking uploads?" can live in a release note, a requirement and a test case at once. Readers either search each document by hand or ask the person who wrote it.

## User

[CONFIRM] Anyone reading the Validator's spec: the people who use the tool, and reviewers who want to see how it was specified without reading all five documents.

## Solution

A retrieval-augmented answer engine with four guardrails:

- **Every claim is cited.** Answers link to the exact excerpt (a requirement, test case, field, user story or release). A citation check rejects numbers the model wasn't given.
- **It refuses instead of guessing.** A low retrieval score returns "not covered" before the model is called. Values withheld for proprietary reasons are named as withheld, never filled in.
- **It won't say who is behind the tool.** Questions about who built it, which company, its clients, vendors or manufacturers are refused in code before any model is called (`lib/guardrail.mjs`). Added after the eval gate caught the model answering around one such question while naming no one. The rules are narrow on purpose, and a test runs every answerable eval question through them so real questions about client datasets or company names in headers still get answered.
- **It can't leak names.** A redaction scan runs before any chunk is committed, and a banned-name check runs on every answer.

The same pipeline is exposed as an MCP server, so Claude and other MCP clients can query the spec as a tool.

## PM decisions

| Decision | Why |
| --- | --- |
| Hybrid retrieval (BM25 keywords plus Voyage embeddings, merged by reciprocal rank) with exact-ID boosts | Spec questions name IDs like `TC-38` or `v2.5`. Embeddings alone blur those; keywords alone miss paraphrased questions. |
| Refuse below a similarity threshold, before calling the model | A wrong answer with a citation is worse than no answer. The threshold was set by the evaluation (0.4 lowered to 0.3), not by feel. |
| Claude Haiku as the answer model | Answers are two to four sentences grounded in retrieved excerpts. The smaller model keeps cost and latency down, and the model is swappable by environment variable. |
| Redaction scan against the pre-redaction archive, run locally | The withheld vocabulary is never written anywhere, so the scan has to run where the originals live. Any hit fails the build. |
| Monthly spend limits ($20 Anthropic, $5 Voyage) plus a per-visitor hourly rate limit | The demo is public and needs no sign-in, so cost is capped at the provider, not trusted to the app. |
| Stateless MCP server with no sign-in | The documents are already public; sessions and auth would add failure points with nothing to protect. |
| Trim answers to the last full sentence and raise the token cap | Early answers cut off mid-sentence, which reads as broken even when the content is right. |

## Evaluation

39 questions in `eval/questions.json`: 29 answerable, each with the excerpt(s) that should answer it, and 10 that must be refused (a withheld value, a request for the full conversion table, six ways of asking who is behind the tool, a prompt injection, and an invented metric). Questions Q26 to Q29 and R06 to R10 were added with the identity guardrail.

`npm run eval` runs them against the live site and scores three things:

| Metric | Result |
| --- | --- |
| Right section retrieved (in the top 5) | [EVAL RESULT] |
| Right section cited in the answer | [EVAL RESULT] |
| Correct refusals | [EVAL RESULT] |

Answers are saved for hand grading; the runner scores retrieval, citation and refusal, not correctness of wording.

A second evaluation in promptfoo adds a model-graded faithfulness check, a set of grader canaries, and a CI gate that runs on every deployment. See [eval/promptfoo/README.md](eval/promptfoo/README.md).

What the evaluation changed: the refusal threshold (0.4 to 0.3), accepting grouped citations like `[1][3]`, and reporting errors instead of crashing mid-run.

## Outcomes

[CONFIRM] What you've seen since launch: who has used it, questions asked, anything a reviewer or interviewer said.

## What I'd do differently

[YOUR WORDS] Two or three honest lessons.

## How it works

1. `scripts/chunk.py corpus data/chunks.json` splits the five pages into citable chunks (one per test case, requirement, field, user story or section).
2. `scripts/scan.py <sanitized_dir> data/chunks.json` checks every chunk against the withheld vocabulary. Any hit fails. `data/chunks.json` is committed only after it passes.
3. `npm run build` (the Vercel build step) embeds the chunks with Voyage into `data/index.json`.
4. `api/ask.js` answers questions: hybrid retrieval, the low-score refusal, Claude with an answer-only-from-excerpts prompt, the citation check and the banned-name check.

### Tracing

Every question is traced in Langfuse (`lib/trace.mjs`): the embedding call, retrieval with each excerpt's score against the refusal threshold, the answer model's call with its token usage, the citation check, and why a question was refused when it was. Traces are tagged `web`, `mcp` or `eval` by where the question came from, so evaluation runs can be left out of the numbers. Tracing is off unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, sends after the response so it adds no latency, and never changes or fails an answer. No IP address or other visitor detail is recorded.

### Running it anywhere: the container

The same app runs outside Vercel as a container (`Dockerfile`, `server/`). `server/index.mjs` serves the Vercel handlers and the page through a thin adapter, adds `GET /health`, and loads the index before taking traffic. `server/start.mjs` builds the embedding index at start from `data/chunks.json`, so no key is baked into the image.

```
docker build -t ask-the-spec .
docker run -p 8080:8080 -e VOYAGE_API_KEY=... -e ANTHROPIC_API_KEY=... -e BANNED_NAMES=... ask-the-spec
```

`.github/workflows/container.yml` builds the image on every push and pull request, starts it, and checks health, the page, a guardrail refusal and the MCP tool list, none of which need a key. On `main` it publishes the image to GitHub Container Registry.

### MCP server

`https://ask.kileysullivan.com/mcp` serves the same spec over Streamable HTTP. It is stateless (one server per request, no sessions) and needs no sign-in. Code: `api/mcp.js` (HTTP, CORS, rate limit) and `lib/mcp-server.mjs` (the tools).

| Tool | What it does | Cost |
| --- | --- | --- |
| `list_documents` | The five documents, excerpt counts and sections | Free |
| `get_section` | One excerpt in full, by chunk id (`prd-016`) or spec id (`TC-38`, `FR-02.3`, `v2.5`) | Free |
| `search_spec` | Hybrid retrieval only: top excerpts with ids and URLs, or a refusal on a low score | One Voyage query embedding |
| `ask_spec` | The full pipeline behind `/api/ask`: a cited answer or a refusal | Voyage plus one Claude call |

To connect it in Claude, add a custom connector with the URL above. `npm test` runs the MCP tests over real HTTP with stubbed embeddings and answers, so it needs no API keys.

### Environment variables (Vercel)

- `ANTHROPIC_API_KEY`
- `VOYAGE_API_KEY`
- `BANNED_NAMES` (pipe-separated names the answer check rejects)
- `ANSWER_MODEL` (optional, default `claude-haiku-5-5`)
- `MIN_DENSE` (optional refusal threshold, default `0.3`, tuned by the evaluation)

Built by [Kiley Sullivan](https://kileysullivan.com).
