"""Match every drama in our explainer library to its Qloo entity ID.

Usage: QLOO_API_KEY=... py -3.12 tools/map_shows.py
Writes data/show_map.json (show -> entity_id or null) and functions/_data/show_map.js.
Prints every match so a human can check the pairing.
"""
import json
import os
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
KEY = os.environ["QLOO_API_KEY"]
BASE = "https://hackathon.api.qloo.com"


def search(query, types):
    q = urllib.parse.urlencode({"query": query, "types": types, "take": 5})
    req = urllib.request.Request(f"{BASE}/search?{q}", headers={"X-Api-Key": KEY})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("results", [])


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    rows = json.loads((ROOT / "data" / "explainers.json").read_text(encoding="utf-8"))
    shows = sorted({r["show"] for r in rows if r["show"]})
    out = {}
    for s in shows:
        hit = None
        for t in ("urn:entity:tv_show", "urn:entity:movie"):
            res = search(s, t)
            if res:
                hit = res[0]
                break
            time.sleep(0.2)
        out[s] = hit.get("entity_id") if hit else None
        print(f"{'OK ' if hit else '-- '}{s}  ->  {hit.get('name') if hit else None}  {hit.get('entity_id') if hit else ''}")
    (ROOT / "data" / "show_map.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (ROOT / "functions" / "_data" / "show_map.js").write_text("export default " + json.dumps(out, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"{sum(1 for v in out.values() if v)}/{len(out)} matched")


if __name__ == "__main__":
    main()
