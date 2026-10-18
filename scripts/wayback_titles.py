"""For links that are dead (deleted/private), try to recover the original title from the
Internet Archive's Wayback Machine. Results go into data/meta.json as wb_title / wb_author / wb_url.
Each link is checked once (wb_checked). Runs in GitHub Actions in batches to stay polite.
Usage: python3 scripts/wayback_titles.py [max_per_run]"""
import json, os, re, sys, time, html, urllib.request, urllib.parse, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META = os.path.join(ROOT, "data", "meta.json")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 300
UA = "Mozilla/5.0 (nrgfm archive; recovering titles of dead links)"

def get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

def lookup_targets(url):
    m = re.search(r"[?&]v=([\w-]{6,})", url)
    if m:
        vid = m.group(1)
        return [f"youtube.com/watch?v={vid}", f"youtu.be/{vid}"]
    return [re.sub(r"^https?://(www\.)?", "", url)]

def closest(target):
    q = urllib.parse.quote(target, safe="")
    d = json.loads(get(f"https://archive.org/wayback/available?url={q}"))
    snap = (d.get("archived_snapshots") or {}).get("closest") or {}
    if snap.get("available") and str(snap.get("status", "200")).startswith(("2", "3")):
        return snap["timestamp"], snap["url"]
    return None

def meta_tag(body, name):
    x = re.search(r'<meta[^>]+(?:property|name|itemprop)="%s"[^>]+content="([^"]*)"' % re.escape(name), body)
    return html.unescape(x.group(1)).strip() if x else None

def extract(body):
    title = meta_tag(body, "og:title") or meta_tag(body, "title")
    if not title:
        t = re.search(r"<title[^>]*>(.*?)</title>", body, re.S | re.I)
        title = html.unescape(re.sub(r"\s+", " ", t.group(1))).strip() if t else None
    if title:
        title = re.sub(r"\s*[-–|]\s*YouTube\s*$", "", title).strip()
        if title.lower() in ("youtube", "", "404 not found", "soundcloud", "page not found"): title = None
    author = None
    a = re.search(r'<link itemprop="name" content="([^"]+)"', body) or re.search(r'"ownerChannelName":"([^"]+)"', body) \
        or re.search(r'class="yt-user-name[^"]*"[^>]*>([^<]+)<', body)
    if a: author = html.unescape(a.group(1)).strip()
    return title, author

def main():
    meta = json.load(open(META, encoding="utf-8"))
    todo = [u for u, v in meta.items() if v.get("dead") and not v.get("title") and not v.get("wb_checked")]
    print(f"{len(todo)} dead links not yet checked; doing up to {MAX}")
    found = n = 0
    for u in todo[:MAX]:
        rec = meta[u]
        try:
            hit = None
            for target in lookup_targets(u):
                hit = closest(target)
                time.sleep(1.5)
                if hit: break
            if hit:
                ts, snap_url = hit
                body = get(f"https://web.archive.org/web/{ts}id_/{snap_url.split('/', 5)[-1]}")
                title, author = extract(body)
                if title:
                    rec["wb_title"] = title; rec["wb_url"] = snap_url; found += 1
                    if author: rec["wb_author"] = author
                time.sleep(1.5)
            rec["wb_checked"] = True
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("rate limited, stopping for now"); break
            rec["wb_checked"] = True
        except Exception as e:
            print("retry later:", u, type(e).__name__, e)
        n += 1
        if n % 25 == 0:
            print(n, "checked,", found, "titles found")
            json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(meta, open(META, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    left = sum(1 for v in meta.values() if v.get("dead") and not v.get("title") and not v.get("wb_checked"))
    print(f"checked {n}, recovered {found} titles, {left} left")

if __name__ == "__main__":
    main()
