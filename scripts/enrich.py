"""Look up extra information for each track (runs on GitHub Actions, in batches).

Writes two files, keyed by link:
  data/extra.json         {"g": [suggested genres], "y": suggested year, "by": uploader, "up": upload date,
                           "src": where the suggestion came from, "chk": when it was looked up}
  data/descriptions.json  {"<link>": "<full description of the video>"}   (loaded by the site only on request)

Sources
  MusicBrainz  free, no key, at most one request per second; gives the first release date and tags
  Discogs      needs DISCOGS_TOKEN (repository secret); gives genres, styles and years
  YouTube      needs YT_API_KEY; gives channel, upload date and description
  Vimeo        oEmbed: uploader, upload date and description
  SoundCloud   oEmbed: uploader and description

Suggestions only come from titles that clearly say "Artist - Title"; anything else is skipped rather
than guessed. Usage: python3 scripts/enrich.py [max_tracks] [max_minutes]"""
import html, json, os, re, sys, time, urllib.parse, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 100000
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 100
UA = "nrgfm/1.0 ( https://github.com/nrgproduct/nrgfm )"
DISCOGS = os.environ.get("DISCOGS_TOKEN", "").strip()
YTKEY = os.environ.get("YT_API_KEY", "").strip()
START = time.time()

SEP = re.compile(r"\s+[-–—]\s+|\s*[-–—]\s+|\s+[-–—]\s*")
NOISE = re.compile(r"\s*[\(\[](official|lyric|lyrics|audio|video|hd|hq|4k|remaster|remastered|full album|visuali[sz]er|explicit|clip|music video|mv|pv)[^\)\]]*[\)\]]", re.I)


def get_json(url, headers=None, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def clean(s):
    s = html.unescape(s or "")
    s = re.sub(r"[\u200b-\u200f\u202a-\u202e\ufeff]", "", s)
    s = re.sub(r"^\s*(premiere|exclusive|free download|free dl)\s*[:|]\s*", "", s, flags=re.I)
    s = NOISE.sub("", s)
    s = re.sub(r"\s*\((19|20)\d\d\)\s*$", "", s)
    return re.sub(r"\s+", " ", s).strip(" -–—\"'")


def artist_title(tr, meta):
    """("Artist", "Title") from the shown title, or None when it isn't clear."""
    m = meta.get(tr["url"], {})
    title = tr.get("title") or m.get("title") or m.get("wb_title") or ""
    title = html.unescape(title)
    channel = m.get("author_name") or ""
    if " · " in title:  # YouTube "Title · Artist"
        parts = [p.strip() for p in title.split(" · ")]
        if len(parts) >= 2:
            return clean(parts[1]), clean(parts[0])
    parts = SEP.split(title, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return clean(parts[0]), clean(parts[1])
    if channel.endswith(" - Topic") and title:
        return channel[:-8].strip(), clean(title)
    return None


def year_of(s):
    m = re.match(r"(\d{4})", s or "")
    return int(m.group(1)) if m else None


def musicbrainz(artist, title):
    r = musicbrainz_once(artist, title)
    bare = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", title).strip()
    if r is None and bare and bare != title:  # "Track (Some Mix)" -> try "Track"
        r = musicbrainz_once(artist, bare)
    return r


def musicbrainz_once(artist, title):
    title, artist = title.replace('"', ''), artist.replace('"', '')
    q = f'recording:"{title}" AND artist:"{artist}"'
    url = "https://musicbrainz.org/ws/2/recording/?" + urllib.parse.urlencode({"query": q, "fmt": "json", "limit": 8})
    time.sleep(1.1)  # MusicBrainz asks for at most one request per second
    d = get_json(url)
    good = [r for r in d.get("recordings", []) if int(r.get("score", 0)) >= 90]
    if not good:
        return None
    years = [y for y in (year_of(r.get("first-release-date")) for r in good) if y]
    tags = {}
    for r in good:
        for t in r.get("tags", []) or []:
            tags[t["name"].lower()] = tags.get(t["name"].lower(), 0) + int(t.get("count", 1))
    return {"y": min(years) if years else None, "g": [t for t, _ in sorted(tags.items(), key=lambda x: -x[1])][:6]}


def discogs(artist, title):
    if not DISCOGS:
        return None
    title = re.sub(r"\s*[\(\[][^\)\]]*[\)\]]", "", title).strip() or title  # mix names confuse the search
    url = "https://api.discogs.com/database/search?" + urllib.parse.urlencode({"artist": artist, "track": title, "type": "release", "per_page": 15})
    time.sleep(1.1)  # 60 requests per minute with a token
    d = get_json(url, {"Authorization": f"Discogs token={DISCOGS}"})
    res = d.get("results", [])
    if not res:
        return None
    years = [int(r["year"]) for r in res if str(r.get("year", "")).isdigit() and int(r["year"]) > 1900]
    count = {}
    for r in res:
        for g in (r.get("style") or []) + (r.get("genre") or []):
            count[g.lower()] = count.get(g.lower(), 0) + 1
    return {"y": min(years) if years else None, "g": [g for g, _ in sorted(count.items(), key=lambda x: -x[1])][:6]}


def oembed_details(tr):
    """Uploader / upload date / description from Vimeo and SoundCloud."""
    p, u = tr["platform"], tr["url"]
    try:
        if p == "vimeo":
            d = get_json("https://vimeo.com/api/oembed.json?url=" + urllib.parse.quote(u, safe=""))
            return {"by": d.get("author_name"), "up": (d.get("upload_date") or "")[:10] or None}, d.get("description")
        if p == "soundcloud":
            d = get_json("https://soundcloud.com/oembed?format=json&url=" + urllib.parse.quote(u, safe=""))
            return {"by": d.get("author_name")}, d.get("description")
    except Exception:  # noqa: BLE001
        pass
    return {}, None


def youtube_details(ids):
    """{video id: ({by, up}, description)} for up to 50 ids at a time (needs YT_API_KEY)."""
    out = {}
    if not YTKEY or not ids:
        return out
    for i in range(0, len(ids), 50):
        q = urllib.parse.urlencode({"part": "snippet", "id": ",".join(ids[i:i + 50]), "key": YTKEY, "maxResults": 50})
        try:
            d = get_json("https://www.googleapis.com/youtube/v3/videos?" + q)
        except Exception as e:  # noqa: BLE001
            print("youtube lookup failed:", e)
            return out
        for it in d.get("items", []):
            sn = it.get("snippet", {})
            out[it["id"]] = ({"by": sn.get("channelTitle"), "up": (sn.get("publishedAt") or "")[:10] or None}, sn.get("description"))
    return out


def main():
    tracks = json.load(open(os.path.join(DATA, "tracks.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    extra_p, desc_p = os.path.join(DATA, "extra.json"), os.path.join(DATA, "descriptions.json")
    extra = json.load(open(extra_p, encoding="utf-8")) if os.path.exists(extra_p) else {}
    desc = json.load(open(desc_p, encoding="utf-8")) if os.path.exists(desc_p) else {}
    todo, seen = [], set()
    for th in tracks["threads"]:
        for tr in th["tracks"]:
            u = tr["url"]
            if u in seen:
                continue
            seen.add(u)
            e = extra.get(u, {})
            if "chk" not in e or (YTKEY and tr["platform"] == "youtube" and "ytchk" not in e):
                todo.append(tr)
    todo = todo[:MAX]
    print("to look up", len(todo), "| discogs", "on" if DISCOGS else "off", "| youtube", "on" if YTKEY else "off")

    # YouTube details in bulk first (cheap: 50 per request)
    ytd = youtube_details([t["yt"] for t in todo if t.get("yt") and not meta.get(t["url"], {}).get("dead")])
    stats = {"parsed": 0, "mb": 0, "dg": 0, "year": 0, "genres": 0}
    done = 0
    for tr in todo:
        if time.time() - START > MINUTES * 60:
            print("time is up for this run")
            break
        u = tr["url"]
        e = extra.get(u, {})
        if "chk" not in e:
            at = artist_title(tr, meta) if not meta.get(u, {}).get("dead") or tr.get("title") or meta.get(u, {}).get("wb_title") else None
            if at:
                stats["parsed"] += 1
                mb = dg = None
                try:
                    mb = musicbrainz(*at)
                except Exception as x:  # noqa: BLE001
                    print("musicbrainz", type(x).__name__, x)
                try:
                    dg = discogs(*at)
                except Exception as x:  # noqa: BLE001
                    print("discogs", type(x).__name__, x)
                years = [r["y"] for r in (mb, dg) if r and r.get("y")]
                genres = []
                for r in (dg, mb):
                    for g in (r or {}).get("g", []):
                        if g not in genres:
                            genres.append(g)
                if mb:
                    stats["mb"] += 1
                if dg:
                    stats["dg"] += 1
                if years:
                    e["y"] = min(years)
                    stats["year"] += 1
                if genres:
                    e["g"] = genres[:8]
                    stats["genres"] += 1
                e["src"] = "+".join(s for s, r in (("musicbrainz", mb), ("discogs", dg)) if r) or None
                if not e["src"]:
                    e.pop("src")
            d_info, d_text = oembed_details(tr)
            e.update({k: v for k, v in d_info.items() if v})
            if d_text:
                desc[u] = d_text
            e["chk"] = int(time.time())
        if tr.get("yt") and tr["yt"] in ytd:
            info, text = ytd[tr["yt"]]
            e.update({k: v for k, v in info.items() if v})
            if text:
                desc[u] = text
        if YTKEY and tr["platform"] == "youtube":
            e["ytchk"] = int(time.time())
        extra[u] = e
        done += 1
        if done % 100 == 0:
            print(done, "done", stats)
            json.dump(extra, open(extra_p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(extra, open(extra_p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump(desc, open(desc_p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("looked up", done, stats)


if __name__ == "__main__":
    main()
