"""Apply files from inbox/*.json to data/tracks.json, then delete them. Files are written by the site:
  add:    {"url": "...", "title": "optional", "thread": "thread id or empty for a new thread", "ts": 123}
  edit:   {"action": "edit", "thread": "thread id", "id": "track id", "title": "...", "url": "...", "ts": 123}
  delete: {"action": "delete", "thread": "thread id", "id": "track id", "ts": 123}
Every applied change is also appended to data/changes.jsonl (with the time it was made), so a
rebuild from the Facebook export (scripts/build_from_group.py) can replay it.
Everything is in git history, so any change can be undone."""
import json, os, glob, re, time, datetime, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
TRACKS = os.path.join(ROOT, "data", "tracks.json")
CHANGES = os.path.join(ROOT, "data", "changes.jsonl")

from build_url import parse  # noqa: E402


def stamp(ts):
    """Time of the change, kept in the data but not shown on the site."""
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm_tag(t):
    """Tags are stored in lowercase with single spaces."""
    import re
    return re.sub(r"\s+", " ", str(t)).strip().lower()[:40]


def set_tags(tr, tags, ts):
    """tags: full list after the change. Keeps the time a tag was first added (orders the tag's playlist)."""
    old = tr.get("tags") or {}
    new = {}
    for t in tags or []:
        t = norm_tag(t)
        if t and t not in new:
            new[t] = old.get(t, ts)
    if new:
        tr["tags"] = new
    else:
        tr.pop("tags", None)


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
    if item.get("tags"):
        set_tags(tr, item["tags"], ts)
    if (item.get("notes") or "").strip():
        tr["notes"] = item["notes"].strip()[:4000]
    th = by_id.get(item.get("thread") or "")
    if th:
        th["tracks"].append(tr)
    else:
        tr["main"] = True
        th = {"id": f"p{ts}", "date": tr["date"], "ts": ts, "kind": "thread", "tracks": [tr]}
        data["threads"].append(th)
        by_id[th["id"]] = th
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
        # a new link: the old link's problems no longer apply (the next link check tags it again if needed)
        if isinstance(item.get("tags"), list):
            item["tags"] = [g for g in item["tags"] if g not in ("broken link", "plays on youtube only")]
        for g in ("broken link", "plays on youtube only"):
            (tr.get("tags") or {}).pop(g, None)
    if "title" in item:
        title = (item["title"] or "").strip()[:200]
        if title:
            tr["title"] = title
        else:
            tr.pop("title", None)  # empty title: fall back to the fetched one
    ts = int(item.get("ts") or time.time())
    if "tags" in item:
        set_tags(tr, item["tags"], ts)
    if "release" in item:  # the suggested releases as corrected by hand ([] removes them all)
        rel = [str(x).strip()[:200] for x in (item["release"] or []) if str(x).strip()][:8]
        tr["release"] = rel
    if "genres" in item:  # the suggested genres as corrected by hand ([] = none)
        tr["genres"] = [re.sub(r"\s+", " ", str(g)).strip().lower()[:60] for g in (item["genres"] or []) if str(g).strip()][:12]
    for k in ("artist", "country"):  # set by hand ("" = none)
        if k in item:
            tr[k] = str(item[k] or "").strip()[:120]
    if "year" in item:  # the year as set by hand (0: no year)
        try:
            y = int(item["year"] or 0)
        except (TypeError, ValueError):
            y = None
        if y == 0 or (y and 1900 <= y <= 2100):
            tr["year"] = y
    if "notes" in item:
        notes = (item["notes"] or "").strip()[:4000]
        if notes:
            tr["notes"] = notes
        else:
            tr.pop("notes", None)
    if item.get("date") and i == 0:
        set_thread_date(th, tr, item["date"], ts, item.get("pos"))
    tr["edited"] = stamp(ts)
    return "edited"


def set_thread_date(th, tr, date, ts, pos=None):
    """Option A: the main post's date (YYYY-MM-DD) decides where the thread sits in the feed,
    until a newer track is added to it. The original posting time stays in tr["ts"]."""
    try:
        d = datetime.datetime.strptime(date, "%Y-%m-%d").replace(hour=12, tzinfo=datetime.timezone.utc)
    except ValueError:
        return
    if date == tr.get("date") and not pos:  # back to the original date: undo
        tr.pop("shown_date", None)
        th.pop("pos_ts", None)
        th.pop("pos_set", None)
        return
    if date == tr.get("date"):
        tr.pop("shown_date", None)
    else:
        tr["shown_date"] = date
    # pos: an exact place chosen with the arrows on the site (between two neighbouring threads)
    th["pos_ts"] = int(pos) if isinstance(pos, (int, float)) and pos > 0 else int(d.timestamp())
    th["pos_set"] = ts


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


def activity(t):
    """When the newest track was added to a thread (a post or comment on Facebook, or a track added
    on the site). Edits, tags and moves don't count."""
    if t.get("pos_ts"):  # a date set by hand; only tracks added after that lift the thread again
        return max([t["pos_ts"]] + [x["ts"] for x in t["tracks"] if x["ts"] > t.get("pos_set", 0)])
    return max([t["ts"]] + [x["ts"] for x in t["tracks"]])


def sort_threads(data):
    """The thread with the latest activity first."""
    data["threads"].sort(key=lambda t: -activity(t))


def apply_tag(data, item):
    """{"action": "tag", "ids": [track ids], "add": [tags], "remove": [tags]} -> tag many tracks at once."""
    ts = int(item.get("ts") or time.time())
    want, n = set(item.get("ids") or []), 0
    for th in data["threads"]:
        for tr in th["tracks"]:
            if tr["id"] in want:
                cur = [t for t in (tr.get("tags") or {}) if t not in {norm_tag(x) for x in item.get("remove") or []}]
                set_tags(tr, cur + list(item.get("add") or []), ts)
                n += 1
    return "tagged" if n else "tag: no tracks found"


def apply_recheck(data, item):
    """Result of the weekly link check: mark links dead / working again, and tag the tracks."""
    meta_path = os.path.join(ROOT, "data", "meta.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    for url, v in (item.get("meta_set") or {}).items():
        meta.setdefault(url, {}).update(v)
    for url in item.get("meta_clear") or []:
        m = meta.get(url)
        if m:
            m.pop("dead", None)
            m.pop("status", None)
    json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    for t in item.get("tag") or []:
        if t.get("ids"):
            apply_tag(data, {"ids": t["ids"], "add": t.get("add") or [], "remove": t.get("remove") or [], "ts": item.get("ts")})
    return "rechecked"


def apply_move(data, by_id, item):
    """{"action": "move", "id": track id, "to": thread id} -> move a track into another thread."""
    th, i = find(data, item.get("thread"), item.get("id"))
    dest = by_id.get(item.get("to") or "")
    if th is None or dest is None:
        return "move: track or thread not found"
    tr = th["tracks"].pop(i)
    tr.pop("main", None)
    dest["tracks"].append(tr)  # the newest reply of its new thread, like "Add a track here"
    for t in (th, dest):
        for k, x in enumerate(t["tracks"]):
            x.pop("main", None)
            if k == 0:
                x["main"] = True
    if not th["tracks"]:
        data["threads"].remove(th)
        by_id.pop(th["id"], None)
    return "moved"


def apply_split(data, by_id, item):
    """{"action": "split", "thread": id, "groups": [[track ids], ...]} -> break an over-long thread into the threads
    the tracks probably came from. Each group becomes its own thread, dated by its first track."""
    th = by_id.get(item.get("thread") or "")
    if th is None:
        return "split: thread not found"
    by_tr = {t["id"]: t for t in th["tracks"]}
    made = 0
    for ids in item.get("groups") or []:
        trs = sorted([by_tr.pop(i) for i in ids if i in by_tr], key=lambda x: x["ts"])
        if not trs:
            continue
        for k, x in enumerate(trs):
            x.pop("main", None)
            if k == 0:
                x["main"] = True
        nt = {"id": "x" + trs[0]["id"], "date": trs[0]["date"], "ts": trs[0]["ts"], "kind": "thread", "tracks": trs}
        data["threads"].append(nt)
        by_id[nt["id"]] = nt
        made += 1
    left = [t for t in th["tracks"] if t["id"] in by_tr]  # tracks not in any group stay where they were
    if left:
        th["tracks"] = left
        for k, x in enumerate(left):
            x.pop("main", None)
            if k == 0:
                x["main"] = True
    else:
        data["threads"].remove(th)
        by_id.pop(th["id"], None)
    return "split" if made else "split: nothing to do"


def fix_main(th):
    for k, x in enumerate(th["tracks"]):
        x.pop("main", None)
        if k == 0:
            x["main"] = True


def apply_reorder(data, item):
    """{"action": "reorder", "thread": id, "id": track id, "to": new index} -> move a track up or down in its
    thread (index 0 makes it the main post)."""
    th, i = find(data, item.get("thread"), item.get("id"))
    if th is None:
        return "reorder: track not found"
    to = max(0, min(len(th["tracks"]) - 1, int(item.get("to", i))))
    tr = th["tracks"].pop(i)
    th["tracks"].insert(to, tr)
    fix_main(th)
    return "reordered"


def apply_promote(data, by_id, item):
    """{"action": "promote", "thread": id, "id": track id, "to": "top" | "original" | "main" | "isolate"} -> the track leaves its thread
    and becomes a thread of its own: at the top of the feed (dated by the promote) or at its own posting time."""
    th, i = find(data, item.get("thread"), item.get("id"))
    if item.get("to") == "isolate":  # the main post leaves its thread and becomes a thread of its own, just above it;
        if th is None or i != 0 or len(th["tracks"]) < 2:  # the first reply becomes the thread's main post
            return "promote: not a main post with replies"
        tr = th["tracks"].pop(0)
        fix_main(th)
        nid = "x" + tr["id"]
        if nid in by_id:
            nid = "xi" + tr["id"]
        above = (th.get("pos_ts") or th.get("ts") or tr["ts"]) + 1
        nt = {"id": nid, "kind": "thread", "tracks": [tr], "date": tr["date"], "ts": tr["ts"], "pos_ts": above, "pos_set": int(item.get("ts") or time.time())}
        tr["main"] = True
        data["threads"].append(nt)
        by_id[nid] = nt
        return "promoted"
    if th is None or i == 0:
        return "promote: track not found (or it is already a main post)"
    if item.get("to") == "main":  # the new main post of its thread; the old one becomes the first reply
        th["tracks"].insert(0, th["tracks"].pop(i))
        fix_main(th)
        return "promoted"
    tr = th["tracks"].pop(i)
    tr["main"] = True
    ts = int(item.get("ts") or time.time())
    nt = {"id": "x" + tr["id"], "kind": "thread", "tracks": [tr], "date": tr["date"], "ts": tr["ts"]}
    if item.get("to") == "top":
        day = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")
        tr["shown_date"] = day
        nt["pos_ts"] = ts
        nt["pos_set"] = ts
    data["threads"].append(nt)
    by_id[nt["id"]] = nt
    return "promoted"


def apply_regroup(data, by_id, item):
    """{"action": "regroup", "threads": [thread ids], "groups": [[track ids], ...]} -> take all tracks out of the
    listed threads and put them together again as the given groups (each group one thread, dated by its first
    track). Tracks not in any group get a thread of their own."""
    pool = {}
    for tid in item.get("threads") or []:
        th = by_id.pop(tid, None)
        if th is None:
            continue
        data["threads"].remove(th)
        for tr in th["tracks"]:
            pool[tr["id"]] = tr
    if not pool:
        return "regroup: threads not found"
    groups = [[pool.pop(i) for i in ids if i in pool] for ids in item.get("groups") or []]
    groups += [[tr] for tr in pool.values()]
    for trs in groups:
        if not trs:
            continue
        trs.sort(key=lambda x: x["ts"])
        for k, x in enumerate(trs):
            x.pop("main", None)
            if k == 0:
                x["main"] = True
        nt = {"id": "x" + trs[0]["id"], "date": trs[0]["date"], "ts": trs[0]["ts"], "kind": "thread", "tracks": trs}
        data["threads"].append(nt)
        by_id[nt["id"]] = nt
    return "regrouped"


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
        elif action == "split":
            res = apply_split(data, by_id, item)
        elif action == "regroup":
            res = apply_regroup(data, by_id, item)
        elif action == "promote":
            res = apply_promote(data, by_id, item)
        elif action == "reorder":
            res = apply_reorder(data, item)
        elif action == "tag":
            res = apply_tag(data, item)
        elif action == "recheck":
            res = apply_recheck(data, item)
        else:
            res = apply_add(data, by_id, item)
        print(os.path.basename(f), res)
        if res in ("added", "edited", "deleted", "moved", "tagged", "rechecked", "split", "regrouped", "promoted", "reordered"):
            item.setdefault("ts", int(time.time()))
            with open(CHANGES, "a", encoding="utf-8") as log:
                log.write(json.dumps(item, ensure_ascii=False) + "\n")
        os.remove(f)
    sort_threads(data)
    data["generated"] = datetime.date.today().isoformat()
    json.dump(data, open(TRACKS, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
