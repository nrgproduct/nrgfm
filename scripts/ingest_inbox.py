"""Merge new tracks from inbox/*.json into data/tracks.json, then delete the inbox files.
An inbox file is created by the site's "Add track" button via GitHub's web editor:
{"url": "...", "title": "optional", "thread": "existing thread id or empty for a new thread"}"""
import json, os, glob, time, datetime, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
TRACKS = os.path.join(ROOT, "data", "tracks.json")

from build_url import parse  # noqa: E402

def main():
    files = sorted(glob.glob(os.path.join(ROOT, "inbox", "*.json")))
    if not files:
        print("inbox empty"); return
    data = json.load(open(TRACKS, encoding="utf-8"))
    by_id = {t["id"]: t for t in data["threads"]}
    added = 0
    for f in files:
        try:
            item = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print("bad file", f, e); continue
        t = parse(item.get("url", "").strip())
        if not t:
            print("not a music link", f); os.remove(f); continue
        ts = int(item.get("ts") or time.time())
        tr = {"id": f"t{ts}_0", "date": datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d"), "ts": ts, **t}
        if item.get("title"): tr["title"] = item["title"].strip()[:200]
        th = by_id.get(item.get("thread") or "")
        if th:
            th["tracks"].append(tr)
        else:
            tr["main"] = True
            th = {"id": f"p{ts}", "date": tr["date"], "ts": ts, "kind": "thread", "tracks": [tr]}
            data["threads"].append(th); by_id[th["id"]] = th
        th["last"] = ts
        added += 1
        os.remove(f)
    data["threads"].sort(key=lambda t: -t.get("last", t["ts"]))
    data["generated"] = datetime.date.today().isoformat()
    json.dump(data, open(TRACKS, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("added", added)

if __name__ == "__main__":
    main()
