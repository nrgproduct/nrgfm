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

BAD_TITLES = {"client challenge", "just a moment...", "attention required!"}

def needs_bandcamp(u, v):
    t = (v.get("title") or "").strip().lower()
    return "bandcamp.com" in u and (v.get("blocked") or not t or t in BAD_TITLES) and not v.get("wb_checked")

def main():
    meta = json.load(open(META, encoding="utf-8"))
    bandcamp = [u for u, v in meta.items() if needs_bandcamp(u, v)]
    todo = bandcamp + [u for u, v in meta.items() if v.get("dead") and not v.get("title") and not v.get("wb_checked") and u not in bandcamp]
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
                if title and title.strip().lower() in BAD_TITLES: title = None
                if title and "bandcamp.com" in u and not rec.get("dead"):
                    # live Bandcamp page: use the archived copy for title, artist, artwork and the embed id
                    m = re.match(r"(.+?),\s+by\s+(.+)$", title)
                    rec["title"] = m.group(1) if m else title
                    rec["author_name"] = m.group(2) if m else (meta_tag(body, "og:site_name") or "")
                    img = meta_tag(body, "og:image")
                    if img: rec["thumbnail_url"] = img
                    vid = meta_tag(body, "og:video") or meta_tag(body, "og:video:secure_url") or ""
                    a = re.search(r"(album|track)=(\d+)", vid) or re.search(r'data-tralbum="[^"]*?&quot;id&quot;:(\d+)', body)
                    if a and a.lastindex == 2: rec["bandcamp_embed"] = f"{a.group(1)}={a.group(2)}"
                    rec.pop("blocked", None); found += 1
                elif title:
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
    left = sum(1 for u, v in meta.items() if (v.get("dead") and not v.get("title") and not v.get("wb_checked")) or needs_bandcamp(u, v))
    print(f"checked {n}, recovered {found} titles, {left} left")

if __name__ == "__main__":
    main()
