// promptfoo provider for Ask the Spec.
// Calls a deployed /api/ask (the live site, or a Vercel preview in CI) exactly
// as a visitor would, then attaches the text of each cited excerpt from
// data/chunks.json so the grader can check the answer against what it cites.
// Base URL: ASK_BASE_URL, else the live site.

import { readFileSync } from "node:fs";

const chunks = new Map(
  JSON.parse(readFileSync(new URL("../../data/chunks.json", import.meta.url))).map((c) => [c.id, c])
);

export default class AskTheSpec {
  constructor() {
    this.base = (process.env.ASK_BASE_URL || "https://ask.kileysullivan.com").replace(/\/$/, "");
  }

  id() {
    return `ask-the-spec:${this.base}`;
  }

  async callApi(question) {
    const headers = { "content-type": "application/json" };
    // Vercel previews sit behind Deployment Protection; this header lets CI through.
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    }
    let res;
    try {
      res = await fetch(`${this.base}/api/ask?debug=1`, {
        method: "POST",
        headers,
        body: JSON.stringify({ question }),
      });
    } catch (err) {
      return { error: `Request failed: ${err.message}` };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.status) return { error: `HTTP ${res.status} ${data.error || ""}`.trim() };

    const cited = (data.citations || []).map((c) => ({
      n: c.n,
      id: c.id,
      label: `${c.doc}, ${c.label}`,
      text: chunks.get(c.id)?.text ?? "",
    }));
    return {
      output: JSON.stringify({
        status: data.status,
        answer: data.answer,
        cited,
        retrieved: data.debug?.retrieved || [],
        bestDense: data.debug?.bestDense,
      }),
    };
  }
}
