"""Build data/tracks.json from the split Facebook export (sorted_export/burmese_group).
Only posts/comments with music links are kept; only the first line of text is kept as a title.
Usage: python3 scripts/build_data.py <burmese_group_dir> data/tracks.json"""
import json, sys, re, bisect, datetime
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_url import parse, MUSIC  # noqa: E402

SRC, OUT = sys.argv[1], sys.argv[2]
posts = json.load(open(f"{SRC}/posts.json", encoding="utf-8"))
comments = json.load(open(f"{SRC}/comments.json", encoding="utf-8"))

def tracks_of(rec):
    out, seen = [], set()
    for u in rec.get("urls", []):
        t = parse(u)
        if t and t["url"] not in seen and any(k in t["url"] for k in MUSIC):
            seen.add(t["url"]); out.append(t)
    return out

def title_of(rec):
    h = rec.get("headline")
    if not h: return None
    h = re.sub(r"\s+", " ", h).strip(" -–—:")
    return h[:200] or None

def mk(rec, i, t, n):
    d = {"id": f"t{rec['timestamp']}_{i}", "date": rec["date"][:10], "ts": rec["timestamp"], **t}
    title = title_of(rec)
    if title and n == 1: d["title"] = title
    return d

threads = []
music_posts = [p for p in posts if tracks_of(p)]
for p in music_posts:
    ts = tracks_of(p)
    threads.append({"id": p["id"], "date": p["date"][:10], "ts": p["timestamp"], "kind": "thread",
                    "tracks": [mk(p, i, t, len(ts)) for i, t in enumerate(ts)]})
threads.sort(key=lambda t: t["ts"])
tts = [t["ts"] for t in threads]

loose = []
for c in comments:
    ts = tracks_of(c)
    if not ts: continue
    if c.get("on") == "his own post":
        i = bisect.bisect_right(tts, c["timestamp"]) - 1
        if i >= 0:
            for k, t in enumerate(ts):
                tr = mk(c, k, t, len(ts))
                if c["timestamp"] - tts[i] > 7 * 86400: tr["late"] = True
                threads[i]["tracks"].append(tr)
            continue
    loose.append((c, ts))

# comments on friends' posts: group into sessions (gap < 6h), no names
loose.sort(key=lambda x: x[0]["timestamp"])
sessions = []
for c, ts in loose:
    if not sessions or c["timestamp"] - sessions[-1]["last"] > 6 * 3600:
        sessions.append({"id": f"s{c['timestamp']}", "date": c["date"][:10], "ts": c["timestamp"], "kind": "replies", "tracks": [], "last": 0})
    s = sessions[-1]; s["last"] = c["timestamp"]
    s["tracks"] += [mk(c, k, t, len(ts)) for k, t in enumerate(ts)]
for s in sessions: s.pop("last")

allt = sorted(threads + sessions, key=lambda t: -t["ts"])
for t in allt:
    t["tracks"].sort(key=lambda x: x["ts"])
    t["tracks"][0]["main"] = True
data = {"generated": datetime.date.today().isoformat(), "threads": allt}
json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
n = sum(len(t["tracks"]) for t in allt)
from collections import Counter
print(f"threads {len(threads)}  reply-sessions {len(sessions)}  tracks {n}")
print(Counter(x["platform"] for t in allt for x in t["tracks"]))
print("titled", sum(1 for t in allt for x in t["tracks"] if x.get("title")), " late", sum(1 for t in allt for x in t["tracks"] if x.get("late")))
