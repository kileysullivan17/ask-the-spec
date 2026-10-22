// Hybrid retrieval over the prebuilt index: BM25 keyword scores plus embedding
// cosine similarity, merged by reciprocal rank, with exact-ID boosts so a
// question naming TC-38 or v1.2 lands on that chunk.

const STOP = new Set(
  "a an and are as at be by can do does for from how i if in is it of on or the this to was what when where which who why will with".split(" ")
);

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9.\-]*/g) || [])
    .map((t) => t.replace(/[.\-]+$/, ""))
    .filter((t) => t && !STOP.has(t));
}

const ID_PATTERN = /\b(TC-\d+|FR-\d+(?:\.\d+)?|NFR-\d+|EP-\d+|US-\d+|v\d+\.\d+(?:\.\d+)?)\b/gi;

export function idsIn(question) {
  return [...new Set((question.match(ID_PATTERN) || []).map((s) => s.toUpperCase().replace(/^V/, "v")))];
}

export function buildBm25(chunks) {
  const docs = chunks.map((c) => tokenize(`${c.doc} ${c.section} ${c.label} ${c.text}`));
  const df = new Map();
  docs.forEach((toks) => new Set(toks).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  return { docs, df, avg, n: docs.length };
}

export function bm25Scores(bm, question, k1 = 1.2, b = 0.75) {
  const q = tokenize(question);
  return bm.docs.map((toks) => {
    const tf = new Map();
    toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (bm.n - bm.df.get(t) + 0.5) / (bm.df.get(t) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / bm.avg)));
    }
    return s;
  });
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function ranks(scores) {
  const order = scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]);
  const r = new Array(scores.length);
  order.forEach(([, i], pos) => (r[i] = pos + 1));
  return r;
}

// Returns { hits: [{chunk, dense, keyword, idMatch}], bestDense, idMatched }
export function retrieve(index, bm, question, queryVector, k = 5) {
  const chunks = index.chunks;
  const dense = chunks.map((c) => cosine(queryVector, c.vector));
  const keyword = bm25Scores(bm, question);
  const ids = idsIn(question);
  const idMatch = chunks.map((c) =>
    ids.some((id) => c.label.toUpperCase().startsWith(id.toUpperCase()) || c.section.toUpperCase().startsWith(id.toUpperCase()))
  );
  const rd = ranks(dense);
  const rk = ranks(keyword);
  const fused = chunks.map((_, i) => 1 / (60 + rd[i]) + 1 / (60 + rk[i]) + (idMatch[i] ? 1 : 0));
  const top = fused
    .map((s, i) => [s, i])
    .sort((x, y) => y[0] - x[0])
    .slice(0, k)
    .map(([, i]) => ({ chunk: chunks[i], dense: dense[i], keyword: keyword[i], idMatch: idMatch[i] }));
  return {
    hits: top,
    bestDense: Math.max(...dense),
    idMatched: idMatch.some(Boolean),
  };
}
