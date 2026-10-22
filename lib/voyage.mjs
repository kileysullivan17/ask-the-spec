// Voyage AI embeddings. The key comes from the VOYAGE_API_KEY environment
// variable and never reaches the browser.

export const EMBED_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function embed(texts, inputType, { retries = 3 } = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: inputType }),
    });
    if (res.status !== 429 || attempt >= retries) break;
    await sleep(Number(res.headers.get("retry-after") || 20) * 1000);
  }
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
