"""Redaction scan for Ask the Spec.

Builds the withheld vocabulary as every markdown table cell that appears in the
pre-redaction documents but in none of the current sanitized documents, then
checks the given text sources against it. Prints counts and locations only,
never the withheld values themselves. Run it on the Mac that holds the archive;
the vocabulary is never written anywhere.

Known limit: cells that read as prose (ending in a period, containing ". ", or
over 60 characters) are left out, because the sanitized markdown rewords some
expected-result sentences that the published DOCX keeps. Those are not
taxonomy values.

Usage: python3 scan.py <sanitized_dir> <text_or_html_or_json> [...]
Exit 1 on any hit.
"""
import html, json, re, sys
from pathlib import Path


def cells(md):
    out = set()
    for line in md.splitlines():
        if line.strip().startswith("|"):
            for c in line.strip().strip("|").split("|"):
                c = re.sub(r"[*`_]", "", c).strip()
                if c and not re.fullmatch(r"[-: ]+", c):
                    out.add(c)
    return out


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def is_sentence(v):
    return v.rstrip().endswith(".") or ". " in v or len(v) > 60


root = Path(sys.argv[1])
before = set().union(*(cells(p.read_text()) for p in (root / "archive/pre-redaction-2026-09-14").glob("*.md")))
after_text = norm(" ".join(p.read_text() for p in root.glob("*_sanitised.md")))
vocab = {v for v in before
         if norm(v) not in after_text and len(v) >= 2 and not v.isdigit() and not is_sentence(v)}
print(f"withheld vocabulary: {len(vocab)} values")


def text_of(p):
    t = Path(p).read_text()
    if p.endswith(".json"):
        return [(c.get("id", "?"), c.get("text", "")) for c in json.loads(t)]
    if p.endswith(".html"):
        t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
        t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    return [(p, t)]


hits = 0
for src in sys.argv[2:]:
    for loc, t in text_of(src):
        nt = norm(t)
        for v in vocab:
            nv = norm(v)
            found = re.search(r"\b" + re.escape(nv) + r"\b", nt) if len(nv) <= 3 else nv in nt
            if found:
                hits += 1
                print(f"HIT in {Path(str(loc)).name}: withheld value of length {len(v)} (first char {v[0]!r})")
print(f"{hits} hits")
sys.exit(1 if hits else 0)
