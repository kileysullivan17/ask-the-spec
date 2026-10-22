"""Split the five published Anomaly Upload Validator spec pages into retrieval chunks.

One chunk per citable unit:
  * a table row whose first cell is an ID (TC-12, FR-02.3, NFR-04, EP-03, a field name in the
    data dictionary's Field Reference) becomes its own chunk, cited by that ID;
  * a user story (a paragraph starting "US-nn") and everything under it becomes one chunk;
  * any other h2 section becomes one chunk, split on block boundaries if it runs long.

Redaction markers such as [withheld] are kept verbatim so retrieval can find them.

Usage: python3 scripts/chunk.py <corpus_dir> <out_json>
"""

import json
import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup, Tag

SITE = "https://kileysullivan.com/artifacts"
DOCS = {
    "prd": "PRD",
    "user-stories": "User stories",
    "data-dictionary": "Data dictionary",
    "test-cases": "Test cases",
    "release-notes": "Release notes",
}
ROW_ID = re.compile(r"^(TC-\d+|FR-\d+(\.\d+)?|NFR-\d+|EP-\d+)$")
STORY = re.compile(r"^(US-\d+)\b")
MAX_CHARS = 2400


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def slug(text: str) -> str:
    """GitHub-style heading slug, used once the renderer gives h2 headings ids."""
    s = re.sub(r"[^\w\s-]", "", text.lower())
    return re.sub(r"\s+", "-", s.strip())


def table_rows(table: Tag):
    rows = table.find_all("tr")
    if not rows:
        return [], []
    header = [clean(c.get_text(" ")) for c in rows[0].find_all(["th", "td"])]
    body = [[clean(c.get_text(" ")) for c in r.find_all(["th", "td"])] for r in rows[1:]]
    return header, body


def row_text(header, cells):
    return "; ".join(f"{h}: {v}" for h, v in zip(header, cells) if v)


def table_anchor(node: Tag):
    cap = node.find(id=re.compile(r"-cap$"))
    return cap.get("id") if cap else None


def is_field_reference(section: str, header) -> bool:
    return section == "Field Reference" and header[:1] == ["Field Name"]


def chunk_doc(path: Path):
    key = path.stem
    title = DOCS[key]
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "html.parser")
    doc = soup.select_one(".doc")
    chunks = []

    section, section_anchor, buf, story = None, None, [], None

    def flush():
        nonlocal buf
        text = clean(" ".join(buf))
        buf = []
        if not text or section is None:
            return
        label = story or section
        parts, cur = [], ""
        for sentence in re.split(r"(?<=[.;:])\s+", text):
            if len(cur) + len(sentence) > MAX_CHARS and cur:
                parts.append(cur)
                cur = ""
            cur = f"{cur} {sentence}".strip()
        parts.append(cur)
        for i, part in enumerate(parts):
            chunks.append({
                "doc": title,
                "section": section,
                "label": label if len(parts) == 1 else f"{label} (part {i + 1})",
                "anchor": section_anchor,
                "text": part,
            })

    for node in doc.find_all(recursive=False):
        if node.name == "h2":
            flush()
            story = None
            section = clean(node.get_text(" "))
            section_anchor = slug(section)
            continue
        if section is None:
            continue
        text = clean(node.get_text(" "))
        m = STORY.match(text) if node.name == "p" else None
        if m:
            flush()
            story = text
            buf.append(text)
            continue
        table = node.find("table") if node.name != "table" else node
        if table is not None and story is None:
            header, body = table_rows(table)
            ids = [r for r in body if r and (ROW_ID.match(r[0]) or is_field_reference(section, header))]
            if ids and len(ids) == len(body):
                anchor = table_anchor(node) or section_anchor
                for cells in body:
                    label = cells[0] if ROW_ID.match(cells[0]) else f"Field: {cells[0]}"
                    chunks.append({
                        "doc": title,
                        "section": section,
                        "label": label,
                        "anchor": anchor,
                        "text": row_text(header, cells),
                    })
                continue
            buf.append(" ".join(row_text(header, c) for c in body) if body else text)
            continue
        buf.append(text)
    flush()

    for i, c in enumerate(chunks):
        c["id"] = f"{key}-{i:03d}"
        c["url"] = f"{SITE}/{key}" + (f"#{c['anchor']}" if c["anchor"] else "")
    return chunks


def main():
    corpus, out = Path(sys.argv[1]), Path(sys.argv[2])
    all_chunks = []
    for key in DOCS:
        all_chunks.extend(chunk_doc(corpus / f"{key}.html"))
    out.write_text(json.dumps(all_chunks, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{len(all_chunks)} chunks written to {out}")


if __name__ == "__main__":
    main()
