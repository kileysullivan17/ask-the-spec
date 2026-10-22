// Embeds data/chunks.json into data/index.json. Runs as the Vercel build step,
// so the Voyage key lives only in Vercel's environment variables.
// chunks.json is committed only after scripts/scan.py passes on the Mac that
// holds the pre-redaction archive.

import { readFileSync, writeFileSync } from "node:fs";
import { embed, EMBED_MODEL } from "../lib/voyage.mjs";

const chunks = JSON.parse(readFileSync(new URL("../data/chunks.json", import.meta.url)));
const BATCH = 64;
const out = [];

for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vectors = await embed(
    batch.map((c) => `${c.doc}, ${c.section}, ${c.label}\n${c.text}`),
    "document"
  );
  batch.forEach((c, j) => out.push({ ...c, vector: vectors[j] }));
  console.log(`embedded ${Math.min(i + BATCH, chunks.length)} of ${chunks.length}`);
}

writeFileSync(
  new URL("../data/index.json", import.meta.url),
  JSON.stringify({ model: EMBED_MODEL, built: new Date().toISOString(), chunks: out })
);
console.log(`index written: ${out.length} chunks, model ${EMBED_MODEL}`);
