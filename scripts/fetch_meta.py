"""Look up title, artist/channel, thumbnail and embed info for every track URL
that is not yet in data/meta.json. Runs on GitHub Actions (which has internet access).
Results are cached in data/meta.json, keyed by URL, so each link is fetched once.
Usage: python3 scripts/fetch_meta.py [max_new]"""
import json, os, re, sys, time, html, urllib.request, urllib.parse, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_url import parse  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACKS = os.path.join(ROOT, "data", "tracks.json")
META = os.path.join(ROOT, "data", "meta.json")
MAX_NEW = int(sys.argv[1]) if len(sys.argv) > 1 else 6000
UA = "Mozilla/5.0 (nrgfm archive; title lookup)"

def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")

def oembed(endpoint, url):
    try:
        st, body = get(endpoint + urllib.parse.quote(url, safe=""))
        return json.loads(body)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404, 410): return {"dead": True, "status": e.code}
        raise

def og(url):
    try:
        st, body = get(url)
    except urllib.error.HTTPError as e:
        if e.code in (404, 410): return {"dead": True, "status": e.code}
        raise
    def m(prop):
        x = re.search(r'<meta[^>]+(?:property|name)="%s"[^>]+content="([^"]*)"' % re.escape(prop), body)
        return html.unescape(x.group(1)) if x else None
    out = {"title": m("og:title"), "thumbnail_url": m("og:image"), "author_name": m("og:site_name")}
    if (out["title"] or "").strip().lower() in BAD_TITLES or "client challenge" in body[:3000].lower():
        return {"blocked": True}  # bot protection page; scripts/wayback_titles.py tries the archive instead
    vid = m("og:video") or m("og:video:secure_url") or ""
    a = re.search(r"(album|track)=(\d+)", vid)
    if a: out["bandcamp_embed"] = f"{a.group(1)}={a.group(2)}"
    if not out["title"]:
        t = re.search(r"<title>(.*?)</title>", body, re.S)
        out["title"] = html.unescape(t.group(1).strip()) if t else None
    return out

def lookup(t):
    p, u = t["platform"], t["url"]
    if p == "youtube":
        return oembed("https://www.youtube.com/oembed?format=json&url=", u)
    if p == "soundcloud":
        r = oembed("https://soundcloud.com/oembed?format=json&url=", u)
        src = re.search(r'src="([^"]+)"', r.get("html", "") or "")
        if src: r["sc_src"] = html.unescape(src.group(1))
        return r
    if p == "vimeo":
        return oembed("https://vimeo.com/api/oembed.json?url=", u)
    if p == "mixcloud":
        return oembed("https://www.mixcloud.com/oembed/?format=json&url=", u)
    if p in ("bandcamp", "spotify"):
        return og(u)
    return {}

BAD_TITLES = {"client challenge", "just a moment...", "attention required!", ""}
KEEP = ("blocked", "title", "author_name", "thumbnail_url", "sc_src", "bandcamp_embed", "dead", "status")

def main():
    tracks = json.load(open(TRACKS, encoding="utf-8"))
    meta = json.load(open(META, encoding="utf-8")) if os.path.exists(META) else {}
    todo = []
    for th in tracks["threads"]:
        for t in th["tracks"]:
            if t["url"] not in meta and t["url"] not in [x["url"] for x in todo[-50:]]:
                todo.append(t)
            a = parse(t["alt"]) if t.get("alt") else None  # the alternative link is looked up too
            if a and a["url"] not in meta and a["url"] not in [x["url"] for x in todo[-50:]]:
                todo.append(a)
    seen, n, errors = set(), 0, 0
    for t in todo:
        if t["url"] in seen or t["url"] in meta: continue
        seen.add(t["url"])
        if n >= MAX_NEW: break
        try:
            r = lookup(t)
            meta[t["url"]] = {k: r[k] for k in KEEP if r.get(k) not in (None, "")}
        except Exception as e:
            errors += 1
            print("skip", t["url"], type(e).__name__, e)
            if errors > 50: break
        n += 1
        if n % 100 == 0:
            print(n, "done"); json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        time.sleep(0.25)
    json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    dead = sum(1 for v in meta.values() if v.get("dead"))
    print(f"looked up {n}, total cached {len(meta)}, dead {dead}, errors {errors}")

if __name__ == "__main__":
    main()
