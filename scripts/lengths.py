"""Length of every track, in seconds, for the length slider on a tag's page.
Results go to data/lengths.json, keyed by the track's link: {url: seconds} (null = looked, no length found).
  Youtube     the official YouTube Data API (repository secret YT_API_KEY), 50 videos per request
  Soundcloud  the track page ("full_duration")
  Bandcamp    the track page (the length in its track data)
  Vimeo       Vimeo's oEmbed ("duration")
  Mixcloud    Mixcloud's API ("audio_length")
Links already in the file are skipped, so after the first run only new tracks are looked up.
Usage: YT_API_KEY=... python3 scripts/lengths.py"""
import json, os, re, sys, time, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "lengths.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; nrgfm track lengths)"}


def get(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def iso_seconds(iso):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s or None


def youtube(ids, key):
    """{video id: seconds} for the ids of every request that went through (a video not in the answer: None)"""
    out = {}
    for i in range(0, len(ids), 50):
        q = urllib.parse.urlencode({"part": "contentDetails", "id": ",".join(ids[i:i + 50]), "key": key, "maxResults": 50})
        try:
            items = json.loads(get("https://www.googleapis.com/youtube/v3/videos?" + q)).get("items", [])
        except Exception as e:  # noqa: BLE001
            print("youtube lookup failed:", type(e).__name__, getattr(e, "code", ""))
            return out
        out.update({v: None for v in ids[i:i + 50]})
        for it in items:
            out[it["id"]] = iso_seconds(it.get("contentDetails", {}).get("duration"))
    return out


def other(url, platform):
    try:
        if platform == "soundcloud":
            page = get(url)
            m = re.search(r'"full_duration":(\d+)', page) or re.search(r'"duration":(\d+)', page)
            return round(int(m.group(1)) / 1000) if m else None
        if platform == "bandcamp":
            page = get(url)
            m = re.search(r'&quot;duration&quot;:([\d.]+)', page) or re.search(r'"duration":([\d.]+)', page)
            return round(float(m.group(1))) or None if m else None
        if platform == "vimeo":
            d = json.loads(get("https://vimeo.com/api/oembed.json?url=" + urllib.parse.quote(url, safe="")))
            return int(d["duration"]) or None if d.get("duration") else None
        if platform == "mixcloud":
            path = urllib.parse.urlparse(url).path
            d = json.loads(get("https://api.mixcloud.com" + path))
            return int(d["audio_length"]) or None if d.get("audio_length") else None
    except Exception as e:  # noqa: BLE001
        print("no length:", url, type(e).__name__)
    return None


def main():
    tracks = json.load(open(os.path.join(ROOT, "data", "tracks.json"), encoding="utf-8"))
    lengths = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}
    key = os.environ.get("YT_API_KEY")
    todo = {}
    for t in tracks["threads"]:
        for x in t["tracks"]:
            u = x.get("url")
            if u and u not in lengths and u not in todo and x.get("platform") not in (None, "none"):
                todo[u] = x
    print("to look up", len(todo))
    yt = {u: x["yt"] for u, x in todo.items() if x.get("yt")}
    if yt and key:
        got = youtube(sorted(set(yt.values())), key)
        for u, v in yt.items():
            if v in got:
                lengths[u] = got[v]  # (a video that's gone: null)
    elif yt:
        print("No YT_API_KEY secret set: Youtube links skipped.")
    for u, x in todo.items():
        if x.get("yt"):
            continue
        lengths[u] = other(u, x.get("platform"))
        time.sleep(0.5)
    json.dump(lengths, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("with a length", sum(1 for v in lengths.values() if v), "of", len(lengths))


if __name__ == "__main__":
    main()
