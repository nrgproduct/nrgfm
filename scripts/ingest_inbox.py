"""Apply files from inbox/*.json to data/tracks.json, then delete them. Files are written by the site:
  add:    {"url": "...", "title": "optional", "thread": "thread id or empty for a new thread", "ts": 123}
  edit:   {"action": "edit", "thread": "thread id", "id": "track id", "title": "...", "url": "...", "ts": 123}
  delete: {"action": "delete", "thread": "thread id", "id": "track id", "ts": 123}
Every applied change is also appended to data/changes.jsonl (with the time it was made), so a
rebuild from the Facebook export (scripts/build_from_group.py) can replay it.
Everything is in git history, so any change can be undone."""
import json, os, glob, time, datetime, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
TRACKS = os.path.join(ROOT, "data", "tracks.json")
CHANGES = os.path.join(ROOT, "data", "changes.jsonl")

from build_url import parse  # noqa: E402


def stamp(ts):
    """Time of the change, kept in the data but not shown on the site."""
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")


def find(data, thread_id, track_id):
    for th in data["threads"]:
        if th["id"] == thread_id:
            for i, tr in enumerate(th["tracks"]):
                if tr["id"] == track_id:
                    return th, i
    # thread id may be stale (e.g. track moved); fall back to searching all threads
    for th in data["threads"]:
        for i, tr in enumerate(th["tracks"]):
            if tr["id"] == track_id:
                return th, i
    return None, None


def apply_add(data, by_id, item):
    t = parse(item.get("url", "").strip())
    if not t:
        return "not a music link"
    ts = int(item.get("ts") or time.time())
    tr = {"id": f"t{ts}_0", "date": day(ts), "ts": ts, "added": stamp(ts), **t}
    if item.get("title"):
        tr["title"] = item["title"].strip()[:200]
    th = by_id.get(item.get("thread") or "")
    if th:
        th["tracks"].append(tr)
    else:
        tr["main"] = True
        th = {"id": f"p{ts}", "date": tr["date"], "ts": ts, "kind": "thread", "tracks": [tr]}
        data["threads"].append(th)
        by_id[th["id"]] = th
    th["last"] = ts
    return "added"


def apply_edit(data, item):
    th, i = find(data, item.get("thread"), item.get("id"))
    if th is None:
        return "edit: track not found"
    tr = th["tracks"][i]
    if "url" in item and item["url"].strip() and item["url"].strip() != tr["url"]:
        t = parse(item["url"].strip())
        if not t:
            return "edit: not a music link"
        for k in ("platform", "url", "yt", "vimeo"):
            tr.pop(k, None)
        tr.update(t)
    if "title" in item:
        title = (item["title"] or "").strip()[:200]
        if title:
            tr["title"] = title
        else:
            tr.pop("title", None)  # empty title: fall back to the fetched one
    tr["edited"] = stamp(int(item.get("ts") or time.time()))
    return "edited"


def apply_delete(data, by_id, item):
    th, i = find(data, item.get("thread"), item.get("id"))
    if th is None:
        return "delete: track not found"
    th["tracks"].pop(i)
    if not th["tracks"]:
        data["threads"].remove(th)
        by_id.pop(th["id"], None)
    else:
        for k, tr in enumerate(th["tracks"]):
            if k == 0:
                tr["main"] = True
            else:
                tr.pop("main", None)
    return "deleted"


def sort_threads(data):
    """Pinned collections first, then newest activity first."""
    data["threads"].sort(key=lambda t: (0, 0) if t.get("pinned") else (1, -t.get("last", t["ts"])))


def apply_move(data, by_id, item):
    """{"action": "move", "id": track id, "to": thread id} -> move a track into another thread."""
    th, i = find(data, item.get("thread"), item.get("id"))
    dest = by_id.get(item.get("to") or "")
    if th is None or dest is None:
        return "move: track or thread not found"
    tr = th["tracks"].pop(i)
    tr.pop("main", None)
    dest["tracks"].append(tr)
    dest["tracks"].sort(key=lambda x: x["ts"])
    for t in (th, dest):
        for k, x in enumerate(t["tracks"]):
            x.pop("main", None)
            if k == 0:
                x["main"] = True
    if not th["tracks"]:
        data["threads"].remove(th)
        by_id.pop(th["id"], None)
    return "moved"


def main():
    files = sorted(glob.glob(os.path.join(ROOT, "inbox", "*.json")))
    if not files:
        print("inbox empty")
        return
    data = json.load(open(TRACKS, encoding="utf-8"))
    by_id = {t["id"]: t for t in data["threads"]}
    for f in files:
        try:
            item = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print("bad file", f, e)
            continue
        action = item.get("action", "add")
        if action == "edit":
            res = apply_edit(data, item)
        elif action == "delete":
            res = apply_delete(data, by_id, item)
        elif action == "move":
            res = apply_move(data, by_id, item)
        else:
            res = apply_add(data, by_id, item)
        print(os.path.basename(f), res)
        if res in ("added", "edited", "deleted", "moved"):
            item.setdefault("ts", int(time.time()))
            with open(CHANGES, "a", encoding="utf-8") as log:
                log.write(json.dumps(item, ensure_ascii=False) + "\n")
        os.remove(f)
    sort_threads(data)
    data["generated"] = datetime.date.today().isoformat()
    json.dump(data, open(TRACKS, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
