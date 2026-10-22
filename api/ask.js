// POST /api/ask  { "question": "..." }  ->  { status, answer, citations }
// Best-effort per-visitor rate limit; the real backstop is the monthly spend
// limit set in the Anthropic and Voyage consoles.

import { ask, MAX_QUESTION } from "../lib/answer.mjs";

const WINDOW_MS = 60 * 60 * 1000;
const PER_WINDOW = 40;
const seen = new Map();

function limited(ip) {
  const now = Date.now();
  const recent = (seen.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  seen.set(ip, recent);
  return recent.length > PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) {
    return res.status(429).json({ error: "That's a lot of questions in an hour. Try again later." });
  }
  const question = typeof req.body === "object" ? req.body?.question : undefined;
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Ask a question." });
  }
  if (question.length > MAX_QUESTION) {
    return res.status(400).json({ error: `Keep it under ${MAX_QUESTION} characters.` });
  }
  try {
    const { status, answer, citations, debug } = await ask(question);
    res.setHeader("cache-control", "no-store");
    // ?debug=1 adds chunk ids and scores for the evaluation runner. No secrets in it.
    const withDebug = String(req.query?.debug || "") === "1";
    return res.status(200).json(withDebug ? { status, answer, citations, debug } : { status, answer, citations });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: "Something went wrong answering that. Try again in a minute." });
  }
}
