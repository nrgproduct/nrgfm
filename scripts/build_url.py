"""Shared URL parsing: turn a link into {platform, url, yt/vimeo id}."""
import re
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

MUSIC = ("youtube", "youtu.be", "soundcloud", "bandcamp", "vimeo", "mixcloud", "spotify")

def clean_url(u):
    u = u.rstrip(").,]>\"'")
    p = urlparse(u)
    q = {k: v for k, v in parse_qs(p.query).items() if not k.startswith(("fbclid", "utm_", "feature", "si"))}
    return urlunparse((p.scheme or "https", p.netloc, p.path, "", urlencode(q, doseq=True), ""))

def parse(u):
    u = clean_url(u); h = urlparse(u).netloc.lower().replace("www.", "").replace("m.", "", 1)
    if "youtu.be" in h:
        vid = urlparse(u).path.strip("/").split("/")[0]; return {"platform": "youtube", "yt": vid, "url": f"https://www.youtube.com/watch?v={vid}"}
    if "youtube" in h:
        q = parse_qs(urlparse(u).query); vid = (q.get("v") or [None])[0]
        if not vid:
            m = re.search(r"/(?:shorts|embed|v)/([\w-]{6,})", u); vid = m.group(1) if m else None
        if vid: return {"platform": "youtube", "yt": vid, "url": f"https://www.youtube.com/watch?v={vid}"}
        return {"platform": "youtube", "url": u}
    if "vimeo" in h:
        m = re.search(r"vimeo\.com/(\d+)", u); return {"platform": "vimeo", "vimeo": m.group(1) if m else None, "url": u}
    for k in ("soundcloud", "bandcamp", "mixcloud", "spotify"):
        if k in h: return {"platform": k, "url": u}
    return None

