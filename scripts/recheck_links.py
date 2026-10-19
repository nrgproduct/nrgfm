"""Weekly check: look up every YouTube / SoundCloud / Vimeo / Mixcloud link again and notice
links that broke (or came back) since they were added.

Nothing is changed directly. The result is written as one file in inbox/, which the normal
update (scripts/ingest_inbox.py) applies:
  - new dead links get dead/status in data/meta.json and the tag "broken link"
  - links whose owner switched off playing on other sites get the tag "plays on youtube only"
  - links that work again lose those marks
Bandcamp is skipped (its pages block automated visits; the Wayback route handles it).
Usage: python3 scripts/recheck_links.py"""
import json, os, sys, time, concurrent.futures as cf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import fetch_meta  # noqa: E402

CHECK = ("youtube", "soundcloud", "vimeo", "mixcloud")


def main():
    tracks = json.load(open(os.path.join(ROOT, "data", "tracks.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(ROOT, "data", "meta.json"), encoding="utf-8"))
    by_url = {}
    for th in tracks["threads"]:
        for t in th["tracks"]:
            if t["platform"] in CHECK:
                by_url.setdefault(t["url"], (t, []))[1].append(t["id"])
    print("checking", len(by_url), "links")

    def check(url):
        t = by_url[url][0]
        for attempt in range(2):
            try:
                return url, fetch_meta.lookup(t)
            except Exception as e:  # noqa: BLE001  network hiccup: try once more, then skip
                err = e
                time.sleep(2)
        return url, {"error": str(err)[:80]}

    results = {}
    with cf.ThreadPoolExecutor(4) as ex:
        for n, (url, r) in enumerate(ex.map(check, by_url), 1):
            results[url] = r
            if n % 500 == 0:
                print(n, "checked")

    set_meta, clear_meta = {}, []
    tag_broken, tag_yt_only, untag = [], [], []
    errors = 0
    for url, r in results.items():
        ids, old = by_url[url][1], meta.get(url, {})
        if "error" in r:
            errors += 1
            continue
        was_dead, now_dead = bool(old.get("dead")), bool(r.get("dead"))
        if now_dead and (not was_dead or old.get("status") != r.get("status")):
            set_meta[url] = {"dead": True, "status": r.get("status")}
            (tag_yt_only if r.get("status") == 401 else tag_broken).extend(ids)
        elif was_dead and not now_dead:
            clear_meta.append(url)
            untag.extend(ids)
    print(f"newly broken {len(tag_broken)}, plays on YouTube only {len(tag_yt_only)}, working again {len(untag)}, errors {errors}")
    if not (set_meta or clear_meta):
        return
    ts = int(time.time())
    item = {"action": "recheck", "ts": ts, "meta_set": set_meta, "meta_clear": clear_meta,
            "tag": [{"ids": tag_broken, "add": ["broken link"]}, {"ids": tag_yt_only, "add": ["plays on youtube only"]},
                    {"ids": untag, "remove": ["broken link", "plays on youtube only"]}]}
    path = os.path.join(ROOT, "inbox", f"{ts}000-recheck.json")
    json.dump(item, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("wrote", os.path.basename(path))


if __name__ == "__main__":
    main()
