// Container entrypoint. The embedding index is built from data/chunks.json
// with the Voyage key, which the container already needs to answer
// questions. Building it at start rather than in the image keeps the key out
// of the image and its build logs. Skipped when an index is already present
// (for example one mounted in, or built by an earlier start on the same disk).

import { existsSync } from "node:fs";

if (!existsSync(new URL("../data/index.json", import.meta.url))) {
  if (!process.env.VOYAGE_API_KEY) {
    console.error("No data/index.json and no VOYAGE_API_KEY to build one.");
    process.exit(1);
  }
  await import("../scripts/build-index.mjs");
}
await import("./index.mjs");
