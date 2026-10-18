"""Read length, category and age restriction of YouTube videos from their watch pages.
Runs on GitHub Actions. Results go to data/ytinfo.json, keyed by video id:
  {"len": seconds, "cat": "Music", "age": true/false, "status": "OK"|..., "title": ..., "author": ...}
Ids that are already in the file are skipped.
Usage: python3 scripts/yt_details.py [max]"""
import json, os, re, sys, time, urllib.request, concurrent.futures as cf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "ytinfo.json")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
HEAD = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.8",
    "Cookie": "CONSENT=YES+cb; SOCS=CAI",
}


def player_response(page):
    m = re.search(r"ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|</script>)", page, re.S)
    return json.loads(m.group(1)) if m else None


def look(vid):
    req = urllib.request.Request(f"https://www.youtube.com/watch?v={vid}&hl=en&gl=US&has_verified=1", headers=HEAD)
    with urllib.request.urlopen(req, timeout=25) as r:
        page = r.read().decode("utf-8", "replace")
    pr = player_response(page)
    if not pr:
        return {"err": "no player data"}
    ps = pr.get("playabilityStatus") or {}
    vd = pr.get("videoDetails") or {}
    mf = (pr.get("microformat") or {}).get("playerMicroformatRenderer") or {}
    reason = ps.get("reason") or ""
    out = {
        "status": ps.get("status"),
        "len": int(vd.get("lengthSeconds") or mf.get("lengthSeconds") or 0) or None,
        "cat": mf.get("category"),
        "age": ("age" in reason.lower()) or (mf.get("isFamilySafe") is False),
        "title": vd.get("title") or (mf.get("title") or {}).get("simpleText"),
        "author": vd.get("author") or mf.get("ownerChannelName"),
    }
    if reason:
        out["reason"] = reason[:160]
    if "not a bot" in reason.lower() or "sign in to confirm" in reason.lower() and not out["age"]:
        out = {"err": "bot check"}
    return out


def main():
    tracks = json.load(open(os.path.join(ROOT, "data", "tracks.json"), encoding="utf-8"))
    info = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}
    ids = []
    for t in tracks["threads"]:
        for x in t["tracks"]:
            v = x.get("yt")
            if v and v not in ids and (v not in info or "err" in info[v]):
                ids.append(v)
    ids = ids[:MAX]
    print("to look up", len(ids))
    errs = 0
    with cf.ThreadPoolExecutor(4) as ex:
        futs = {ex.submit(look, v): v for v in ids}
        for n, f in enumerate(cf.as_completed(futs), 1):
            v = futs[f]
            try:
                info[v] = f.result()
            except Exception as e:  # noqa: BLE001
                info[v] = {"err": str(e)[:80]}
            if "err" in info[v]:
                errs += 1
            if n % 200 == 0:
                print(n, "done,", errs, "errors")
                json.dump(info, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(info, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    from collections import Counter
    print("errors", errs, Counter(i.get("err") or i.get("status") for i in info.values()).most_common(8))
    print(Counter(i.get("cat") for i in info.values()).most_common(15))


if __name__ == "__main__":
    main()
