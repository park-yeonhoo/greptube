"""Write data/items.json ({vid: item_id}) for every READY item in the store.

Items added with metadata carry item_metadata.vid. The bulk chunks were added
without it, so those match on title: the asset title is the YouTube title, which is
what videos.json holds too.
"""
import json
import os
import re
import sys
import unicodedata
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = os.environ.get("TL_API_BASE", "https://api.twelvelabs.io/v1.3")
KS = os.environ.get("KS_ID", "ks_01a19fdb-0da5-7733-ad51-71c85f488a45")
KEY = os.environ["TL_API_KEY"]


def norm(t: str) -> str:
    return re.sub(r"[^a-z0-9]", "", unicodedata.normalize("NFKD", t).lower())


def items():
    page = 1
    while True:
        req = urllib.request.Request(f"{API}/knowledge-stores/{KS}/items?page={page}&page_limit=50", headers={"x-api-key": KEY})
        d = json.load(urllib.request.urlopen(req, timeout=60))
        yield from d["data"]
        if page >= (d.get("page_info") or {}).get("total_page", 1):
            return
        page += 1


videos = json.loads((ROOT / "data/videos.json").read_text())
by_title = {norm(v["title"]): v["vid"] for v in videos}
out, status, unmatched = {}, Counter(), []
for it in items():
    status[it["status"]] += 1
    vid = (it.get("item_metadata") or {}).get("vid") or by_title.get(norm(it.get("title") or ""))
    if not vid:
        unmatched.append(it.get("title"))
        continue
    if it["status"] == "ready":
        out[vid] = it["_id"]

tmp = ROOT / "data/items.json.tmp"
tmp.write_text(json.dumps(out))
tmp.replace(ROOT / "data/items.json")
print(json.dumps({"status": status, "ready_mapped": len(out), "unmatched": unmatched[:10]}), file=sys.stderr)
