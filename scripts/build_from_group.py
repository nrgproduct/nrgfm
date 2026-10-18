"""Build data/tracks.json from the full group export (posts with their comments).

The export is the group truth: it is only read, never changed, and it is not stored in this
repository (it holds other people's names and comments). Run it on a copy:

    python3 scripts/build_from_group.py <export.json> data/tracks.json

Rules
- A post by Rasmus with a music link is a thread. Its first music link is the main track; further
  links in the post, and every music link in the comments under it, follow in posting order.
- "Anders posts": every music link Anders shared in his own posts and in comments under his own
  posts (and under posts without music), so they can be looked through.
- "Unsorted": music links whose place is unclear: Rasmus's comments under posts without a
  music link, comments under Anders' or other people's posts, and posts by other people.
- data/not_in_export.json: links from the older Facebook download that are missing from this
  export; they go into "Unsorted".
- Posts without any music link (and their non-music comments) are left out.
- Afterwards data/changes.jsonl (everything added, edited or deleted on the site) is replayed,
  so those changes survive a rebuild.
"""
import json, os, re, sys, datetime
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_url import parse, MUSIC  # noqa: E402
import ingest_inbox  # noqa: E402

RASMUS = "1207737035"
URL_RE = re.compile(r"https?://\S+|(?:www\.|m\.)?(?:youtube\.com|youtu\.be|soundcloud\.com|vimeo\.com|mixcloud\.com|[\w-]+\.bandcamp\.com)/\S+")


def iso_day(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")


def ts_of(rec):
    t = (rec.get("extra") or {}).get("created_time")
    if t:
        return int(t)
    return int(datetime.datetime.fromisoformat(rec["posted_at"].replace("Z", "+00:00")).timestamp())


def music(rec):
    urls = list(rec.get("links") or []) + URL_RE.findall(rec.get("text") or "")
    shared = (rec.get("extra") or {}).get("shared_link")
    if shared:
        urls.append(shared)
    out, seen = [], set()
    for u in urls:
        if not u.startswith("http"):
            u = "https://" + u
        u = re.sub(r"[?&]utm_[^#]*$", "", u)  # SoundCloud share tracking
        t = parse(u.rstrip(".,)"))
        if t and t["url"] not in seen and any(k in t["url"] for k in MUSIC):
            seen.add(t["url"])
            out.append(t)
    return out


def norm(u):
    """Same link written differently (http/https, www, tracking codes) counts as one."""
    u = re.sub(r"^https?://(www\.|m\.)?", "", u)
    return re.sub(r"[?&]utm_[^#]*$", "", u).rstrip("/")


def title_of(rec):
    """First line of the text that isn't a link."""
    for line in (rec.get("text") or "").splitlines():
        line = re.sub(r"\s+", " ", URL_RE.sub("", line)).strip(" -–—:|")
        if line:
            return line[:200]
    return None


def rec_id(rec):
    m = re.search(r"comment_id=(\d+)", rec.get("url") or "")
    return ("c" + m.group(1)) if m else ("p" + rec["entity_id"])


def tracks_of(rec):
    ts, found = ts_of(rec), music(rec)
    title = title_of(rec) if len(found) == 1 else None
    out = []
    for k, t in enumerate(found):
        tr = {"id": f"t{rec_id(rec)[1:]}_{k}", "date": iso_day(ts), "ts": ts, **t}
        if title:
            tr["title"] = title
        out.append(tr)
    return out


def who(rec):
    if rec.get("author_id") == RASMUS:
        return "rasmus"
    if (rec.get("author_name") or "").startswith("Anders"):
        return "anders"
    return "other"


def comments(post):
    c = post.get("comments")
    return c if isinstance(c, list) else []


def build(posts):
    threads, anders, unsorted = [], [], []
    for p in posts:
        pw, pt = who(p), tracks_of(p)
        if pw == "rasmus" and pt:
            th = {"id": "p" + p["entity_id"], "date": pt[0]["date"], "ts": pt[0]["ts"], "kind": "thread", "tracks": list(pt)}
            for c in comments(p):
                th["tracks"] += tracks_of(c)
            threads.append(th)
            continue
        # posts that are not Rasmus's music posts
        (anders if pw == "anders" else unsorted).extend(pt)
        for c in comments(p):
            ct = tracks_of(c)
            if not ct:
                continue
            (anders if who(c) == "anders" else unsorted).extend(ct)
    out = threads
    for th in out:
        th["tracks"].sort(key=lambda x: x["ts"])
    collections = []
    for cid, name, tr in (("anders", "Anders posts", anders), ("unsorted", "Unsorted", unsorted)):
        tr.sort(key=lambda x: x["ts"])
        if tr:
            collections.append({"id": cid, "name": name, "date": tr[0]["date"], "ts": tr[-1]["ts"], "kind": "collection", "pinned": True, "tracks": tr})
    extra = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "not_in_export.json")
    if os.path.exists(extra):
        have = {norm(x["url"]) for th in out + collections for x in th["tracks"]}
        unsorted_t = next((c for c in collections if c["id"] == "unsorted"), None)
        add = [x for x in json.load(open(extra, encoding="utf-8")) if norm(x["url"]) not in have]
        if add and unsorted_t:
            unsorted_t["tracks"] = sorted(unsorted_t["tracks"] + add, key=lambda x: x["ts"])
    allt = collections + out
    for th in allt:
        for k, tr in enumerate(th["tracks"]):
            tr.pop("main", None)
            if k == 0:
                tr["main"] = True
    return allt


def replay(data, path):
    """Apply every change made on the site since the build."""
    if not os.path.exists(path):
        return 0
    by_id = {t["id"]: t for t in data["threads"]}
    n = 0
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        action = item.get("action", "add")
        if action == "edit":
            res = ingest_inbox.apply_edit(data, item)
        elif action == "delete":
            res = ingest_inbox.apply_delete(data, by_id, item)
        else:
            res = ingest_inbox.apply_add(data, by_id, item)
        n += 1
        if res not in ("added", "edited", "deleted"):
            print("change not applied:", res, item)
    return n


def main():
    src, out = sys.argv[1], sys.argv[2]
    export = json.load(open(src, encoding="utf-8"))
    data = {"generated": datetime.date.today().isoformat(), "threads": build(export["posts"])}
    changes = replay(data, os.path.join(os.path.dirname(os.path.abspath(out)), "changes.jsonl"))
    ingest_inbox.sort_threads(data)
    json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    T = data["threads"]
    print("threads", sum(1 for t in T if t["kind"] == "thread"), "tracks", sum(len(t["tracks"]) for t in T),
          "site changes replayed", changes)
    for t in T:
        if t["kind"] == "collection":
            print(t["name"], len(t["tracks"]))
    print(Counter(x["platform"] for t in T for x in t["tracks"]))


if __name__ == "__main__":
    main()
