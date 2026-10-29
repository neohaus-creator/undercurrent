"""Build a public index of kdramahistory.com explainers (metadata only, no article bodies).

Reads the private Astro content folder and writes data/explainers.json with
title, drama, era, tags, related slugs, cover and canonical URL.
"""
import json
import pathlib
import re
import sys

SRC = pathlib.Path(r"C:/WithNero/PodoContent/site/src/content/blog")
OUT = pathlib.Path(__file__).resolve().parents[1] / "data" / "explainers.json"
SITE = "https://kdramahistory.com"


def frontmatter(text):
    m = re.match(r"^---\r?\n(.*?)\r?\n---", text, flags=re.S)
    return m.group(1) if m else ""


def scalar(fm, key):
    m = re.search(rf"^{key}:\s*(.+)$", fm, flags=re.M)
    if not m:
        return None
    v = m.group(1).strip()
    if v[:1] in "\"'" and v[-1:] == v[:1]:
        v = v[1:-1]
    return v


def listval(fm, key):
    m = re.search(rf"^{key}:\s*\[(.*)\]\s*$", fm, flags=re.M)
    if not m:
        return []
    return [x.strip().strip("\"'") for x in re.findall(r"\"[^\"]*\"|'[^']*'|[^,]+", m.group(1)) if x.strip()]


def main():
    rows = []
    for p in sorted(SRC.glob("*.md")):
        fm = frontmatter(p.read_text(encoding="utf-8"))
        if scalar(fm, "draft") == "true":
            continue
        slug = p.stem
        drama = scalar(fm, "drama") or ""
        # English title = text before the first " (" ; companion pieces name the anchor show inside the text
        anchor = re.search(r"anchored on ([^(]+?) \(", drama) or re.search(r"Companion to ([^(]+?) \(", drama)
        show = (anchor.group(1) if anchor else drama.split(" (")[0]).strip() or None
        rows.append({
            "show": show,
            "slug": slug,
            "title": scalar(fm, "title"),
            "description": scalar(fm, "description"),
            "drama": scalar(fm, "drama"),
            "era": scalar(fm, "era"),
            "tags": listval(fm, "tags"),
            "related": listval(fm, "related"),
            "cover": (SITE + scalar(fm, "cover")) if scalar(fm, "cover") else None,
            "url": f"{SITE}/blog/{slug}/",
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    js = OUT.parents[1] / "functions" / "_data" / "explainers.js"
    js.parent.mkdir(parents=True, exist_ok=True)
    js.write_text("export default " + json.dumps(rows, ensure_ascii=False) + ";\n", encoding="utf-8")
    show_map = js.parent / "show_map.js"
    if not show_map.exists():  # filled by tools/map_shows.py once the Qloo key arrives
        show_map.write_text("export default {};\n", encoding="utf-8")
    with_drama = sum(1 for r in rows if r["drama"])
    print(f"{len(rows)} explainers, {with_drama} with drama field -> {OUT}")


if __name__ == "__main__":
    sys.exit(main())
