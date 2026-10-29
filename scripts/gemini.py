"""Gemini decides the suggested release, year and genres for each track (runs on GitHub Actions, in batches).

For tracks where MusicBrainz, Discogs or the YouTube/Vimeo/SoundCloud description found something, Gemini
weighs those findings (they are often wrong matches: a cover, a remix, another song with the same name) and
picks the original release, its year and the genres. For tracks where nothing was found, Gemini looks the
track up itself with Google Search.

Writes data/ai.json, keyed by link (everything in it comes from Gemini; the site doesn't say so anywhere):
  {"rl": "release", "y": 1984, "g": ["genre", ...], "md": ["mood word", ...], "how": "sources" | "search", "conf": "high|medium|low",
   "m": model, "in": fingerprint of what it was given (a track is asked again when that changes)}
(entries with "how": "research" were looked up by hand by Claude with web research; they are kept and never asked again)
and data/gemini-status.json (whether it ran, how many, or why it stopped).

The site uses these in place of the other sources' suggestions; a release you set by hand still wins.
Needs the repository secret GEMINI_API_KEY. Usage: python3 scripts/gemini.py [max_tracks] [max_minutes]"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 400
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 50
KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "").strip()
API = "https://generativelanguage.googleapis.com/v1beta/"
VERSION = 3  # 3: no limit on genres and mood words; 2: also mood words, from the title, description and YouTube comments (everything is asked again once)
PER_CALL = {"bandcamp": 8, "sources": 50, "search": 10}  # tracks per request
PAUSE = 7  # seconds between requests (the free tier allows only a few per minute)
START = time.time()


def call(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "x-goog-api-key": KEY})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def why(e):
    """Google's reason for a failed request (the key itself is never printed)."""
    try:
        return f"HTTP {e.code} " + json.load(e).get("error", {}).get("message", "")[:900]
    except Exception:  # noqa: BLE001
        return f"HTTP {getattr(e, 'code', '')}"


def pick_models():
    """The stable Flash models this key can use, newest first (or GEMINI_MODEL if set). When the newest one is
    overloaded, the next one is used."""
    if MODEL:
        return [MODEL]
    names = []
    page = ""
    while True:
        d = call("models?pageSize=200" + (f"&pageToken={page}" if page else ""))
        for m in d.get("models", []):
            n = m["name"].split("/")[-1]
            if "generateContent" in m.get("supportedGenerationMethods", []) and re.fullmatch(r"gemini-\d+(\.\d+)?-flash", n):
                names.append(n)
        page = d.get("nextPageToken")
        if not page:
            break
    if not names:
        raise SystemExit("no Gemini Flash model available for this key")
    return sorted(set(names), key=lambda n: -float(re.search(r"\d+(\.\d+)?", n).group()))


def title_of(tr, meta):
    m = meta.get(tr["url"], {})
    return tr.get("title") or m.get("title") or m.get("wb_title") or ""


def facts(tr, meta, extra, desc):
    """What Gemini is told about one track."""
    u, m, x = tr["url"], meta.get(tr["url"], {}), extra.get(tr["url"], {})
    f = {"title": title_of(tr, meta), "uploader": x.get("by") or m.get("author_name") or m.get("wb_author") or "",
         "uploaded": x.get("up") or "", "site": tr.get("platform", "")}
    if tr.get("platform") == "bandcamp" or "bandcamp.com" in u:
        f["url"] = u
    tags = [t for t in (tr.get("tags") or {}) if t not in ("flagged", "broken link", "plays on youtube only")] if isinstance(tr.get("tags"), dict) else list(tr.get("tags") or [])
    if tags:
        f["group_tags"] = tags
    # the title as written by the group and the link's own title, when they differ (a year in either is a hint)
    fetched = m.get("title") or m.get("wb_title") or ""
    if tr.get("title") and fetched and fetched.strip().lower() != tr["title"].strip().lower():
        f["link_title"] = fetched
    if tr.get("year") is not None:  # set by hand in the group's edit card: these are right
        f["group_year"] = tr["year"] or "none"
    if tr.get("release") is not None:
        f["group_release"] = tr["release"]
    if tr.get("genres") is not None:
        f["group_genres"] = tr["genres"]
    found = {}
    if x.get("rl"):
        found["releases"] = x["rl"][:8]
    if x.get("y"):
        found["years"] = [x["y"]] + [y for y in (x.get("ys") or []) if y != x["y"]][:6]
    if x.get("g"):
        found["genres"] = x["g"]
    if found:
        found["from"] = x.get("src") or ""
        f["found"] = found
    d = (desc.get(u) or "").strip()
    if d:
        f["description"] = d[:700]
    return f


YTKEY = os.environ.get("YT_API_KEY", "").strip()


def yt_comments(video_id):
    """The top comments of a YouTube video (by relevance, short): what listeners call it ("dreamy", "pure 90s rave")."""
    if not YTKEY or not video_id:
        return []
    q = urllib.parse.urlencode({"part": "snippet", "videoId": video_id, "maxResults": 15, "order": "relevance",
                                "textFormat": "plainText", "key": YTKEY})
    try:
        with urllib.request.urlopen("https://www.googleapis.com/youtube/v3/commentThreads?" + q, timeout=20) as r:
            d = json.load(r)
    except Exception:  # noqa: BLE001  (comments switched off, quota, …)
        return []
    out = []
    for it in d.get("items", []):
        t = ((it.get("snippet") or {}).get("topLevelComment") or {}).get("snippet", {}).get("textDisplay", "")
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            out.append(t[:200])
    return out[:10]


def has_sources(f):
    """MusicBrainz or Discogs found something; otherwise Gemini searches the web itself (with the description)."""
    return bool(f.get("found"))


PROMPT = """You help a music-sharing group catalogue the tracks people posted (mostly YouTube links).
For each track below, decide:
- "rl": the name of the ORIGINAL release (album, single or EP) the recording first came out on, or "" if unknown
- "y": the year that release first came out (a number), or null if unknown. The original, not a reissue,
  remaster, compilation or upload year. A remix or edit counts from when that remix or edit came out.
- "g": every genre and style that fits (no limit), lowercase, most fitting first (prefer names from this list when one fits: {vocab})
- "md": every lowercase word that fits the mood or sound (no limit), like "soft", "floating", "romantic", "melancholic",
  "hypnotic", "euphoric", "dark", "warm", "lo-fi".
  For both, use genre words and descriptions found in the title, the description and the listeners' "comments" when
  they fit, and your own knowledge of the track.
- "ar": the artist as credited on that release (e.g. "Röyksopp", "Daft Punk feat. Romanthony"); for music from a
  game, film, anime or TV series the composer. "" if unknown
- "co": the country the artist (or composer) is from, as a two-letter code ("GB", "JP", "US"), or "" if unknown
- "about": one or two plain sentences on what the track is when that isn't obvious from the title, e.g.
  'The track "Mintche" is background music from the Tales of Eternia Original Sound Version (OSV), composed by
  Motoi Sakuraba.' Otherwise "".
- "conf": "high", "medium" or "low": how sure you are.
{how}
Answer with JSON only, no other text: an array with one object per track, in the same order, each
{{"i": <the track's number>, "rl": ..., "y": ..., "g": [...], "md": [...], "ar": ..., "co": ..., "about": ..., "conf": ...}}.

Tracks:
{tracks}"""
HOW = {
    "sources": """Use the "found" data (from MusicBrainz, Discogs and the video description) and your own knowledge.
The found data is often a wrong match: another song with the same name, a cover, a later compilation.
Ignore what doesn't fit the title and uploader. Don't guess: leave a field empty when you aren't fairly sure.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.
A year written in "title" or "link_title" is a strong hint (it can also be a remaster's year).""",
    "search": """MusicBrainz and Discogs found nothing about these tracks. Read the video description when there is one,
and look each track up with Google Search: search "discogs <the title>" and read the first 3 or 4 results (the
Discogs page of the release usually says it all), then search the title by itself (Discogs, MusicBrainz, Bandcamp, Wikipedia, VGMdb, the
artist's pages are good sources). Many are not ordinary releases: music from a video game, film, anime or TV series
(then add genres like "video game music" or "soundtrack", give the year of the game or film, the composer as "ar",
and say in "about" where it is from), a DJ mix, a live recording, a home-made upload.
Don't guess: leave a field empty when you can't find it.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.""",
    "bandcamp": """These are Bandcamp links ("url"). Open each page (Bandcamp often blocks scripts, so read it with the URL
tool; if that fails, find the same page with Google Search). A Bandcamp page has the release's "tags" at the bottom
(genres, moods and places), an "about" text that often names more genres, the line "released <date>", the artist
("by <artist>") and the album cover. Use all of the tags: genres go in "g", mood or sound words in "md", a place
tells the country ("co"). Also give, for these tracks only:
  "tags": every tag listed on the page, exactly as written (lowercase),
  "rd": the release date from the "released ..." line as "YYYY-MM-DD" (and "y" its year), or "" if not shown,
  "cover": the address of the album cover image (the og:image, like "https://f4.bcbits.com/img/a1234567890_10.jpg"),
           exactly as it is on the page, or "" if you can't see it. Never make one up,
  "lt": the title of the track or album as written on the page, "la": the artist ("by ...") as written.
"group_year", "group_release" and "group_genres", when given, were set by hand by the group and are right: keep them.""",
}


def ask(model, how, batch, vocab):
    tracks = "\n".join(json.dumps({"i": k, **f}, ensure_ascii=False) for k, (_, f) in enumerate(batch))
    body = {"contents": [{"role": "user", "parts": [{"text": PROMPT.format(vocab=", ".join(vocab), how=HOW[how], tracks=tracks)}]}],
            "generationConfig": {"temperature": 0.2}}
    if how == "search":
        body["tools"] = [{"google_search": {}}]
    elif how == "bandcamp":
        body["tools"] = [{"url_context": {}}, {"google_search": {}}]
    else:
        body["generationConfig"]["responseMimeType"] = "application/json"
    d = call(f"models/{model}:generateContent", body)
    text = "".join(p.get("text", "") for c in d.get("candidates", [])[:1] for p in c.get("content", {}).get("parts", []))
    s, e = text.find("["), text.rfind("]")
    if s < 0 or e < s:
        raise ValueError("no JSON in the answer: " + text[:200])
    return json.loads(text[s:e + 1])


def clean_answer(a):
    y = a.get("y")
    try:
        y = int(str(y)[:4]) if y else None
    except ValueError:
        y = None
    if y and not 1900 <= y <= time.gmtime().tm_year:
        y = None
    g = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("g") or []) if str(x).strip()]
    md = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("md") or []) if str(x).strip()]  # mood words
    rl = str(a.get("rl") or "").strip()[:200]
    conf = a.get("conf") if a.get("conf") in ("high", "medium", "low") else "low"
    ar = str(a.get("ar") or "").strip()[:200]
    co = str(a.get("co") or "").strip().upper()[:2]
    about = str(a.get("about") or "").strip()[:400]
    out = {"rl": rl, "y": y, "g": g, "md": md, "ar": ar, "co": co if re.fullmatch(r"[A-Z]{2}", co) else "", "about": about, "conf": conf}
    # Bandcamp pages only: the page's tags, release date, cover, title and artist
    tags = [re.sub(r"\s+", " ", str(x)).strip().lower() for x in (a.get("tags") or []) if str(x).strip()]
    if tags:
        out["tags"] = list(dict.fromkeys(tags))
    rd = str(a.get("rd") or "").strip()
    if re.fullmatch(r"\d{4}-\d\d-\d\d", rd):
        out["rd"] = rd
    for k in ("lt", "la"):
        v = str(a.get(k) or "").strip()[:200]
        if v:
            out[k] = v
    cover = str(a.get("cover") or "").strip()
    if cover and image_ok(cover):
        out["cover"] = cover
    return out


def image_ok(u):
    """A cover address from Gemini is kept only when it is a Bandcamp image that really exists."""
    if not re.fullmatch(r"https://f\d\.bcbits\.com/img/[\w.]+\.(jpg|png)", u):
        return False
    try:
        req = urllib.request.Request(u, method="HEAD", headers={"User-Agent": "Mozilla/5.0 (nrgfm archive)"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status == 200 and r.headers.get("Content-Type", "").startswith("image/")
    except Exception:  # noqa: BLE001
        return False


def main():
    tracks = json.load(open(os.path.join(DATA, "tracks.json"), encoding="utf-8"))
    meta = json.load(open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    extra = json.load(open(os.path.join(DATA, "extra.json"), encoding="utf-8"))
    dp = os.path.join(DATA, "descriptions.json")
    desc = json.load(open(dp, encoding="utf-8")) if os.path.exists(dp) else {}
    ai_p = os.path.join(DATA, "ai.json")
    ai = json.load(open(ai_p, encoding="utf-8")) if os.path.exists(ai_p) else {}
    status = {"date": time.strftime("%Y-%m-%d %H:%M", time.gmtime()), "asked": 0, "done": len(ai)}

    def save():
        json.dump(ai, open(ai_p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        status["done"] = len(ai)
        json.dump(status, open(os.path.join(DATA, "gemini-status.json"), "w", encoding="utf-8"), indent=1)

    if not KEY:
        status["state"] = "off (no GEMINI_API_KEY secret)"
        return save()

    # the genres already in use, most used first: Gemini picks from these when one fits
    count = {}
    for x in extra.values():
        for g in x.get("gm") or x.get("g") or []:
            count[g] = count.get(g, 0) + 1
    vocab = [g for g, _ in sorted(count.items(), key=lambda kv: -kv[1])][:250]

    yt_of = {tr["url"]: tr.get("yt") for th in tracks["threads"] for tr in th["tracks"]}
    todo = {"bandcamp": [], "sources": [], "search": []}
    seen = set()
    for th in tracks["threads"]:
        for tr in th["tracks"]:
            u = tr["url"]
            if not u or u in seen or meta.get(u, {}).get("dead") and not title_of(tr, meta):
                continue
            seen.add(u)
            f = facts(tr, meta, extra, desc)
            if not f["title"]:
                continue
            fp = hashlib.sha1(json.dumps(f, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:10]
            if ai.get(u, {}).get("in") == fp and ai[u].get("v") == VERSION:
                continue
            if ai.get(u, {}).get("how") == "research":  # looked up by hand (Claude, with web research): never asked again
                continue
            todo["bandcamp" if f.get("url") else "sources" if has_sources(f) else "search"].append((u, f, fp))
    # tracks listed in data/gemini-priority.json are asked first (e.g. the unsorted pile being sorted again)
    pp = os.path.join(DATA, "gemini-priority.json")
    first = set(json.load(open(pp, encoding="utf-8"))) if os.path.exists(pp) else set()
    for how in todo:
        todo[how].sort(key=lambda item: (item[0] not in first, item[0] in ai))  # then tracks never asked before
    print("to ask:", len(todo["sources"]), "with sources,", len(todo["search"]), "to look up,", len(todo["bandcamp"]), "Bandcamp pages")

    try:
        models = pick_models()
    except urllib.error.HTTPError as e:
        status["state"] = "error: " + why(e)
        return save()
    print("models", models)

    left, fails = MAX, 0
    status["state"] = "ok"
    for how in ("bandcamp", "sources", "search"):
        items = todo[how]
        for i in range(0, len(items), PER_CALL[how]):
            if left <= 0 or time.time() - START > MINUTES * 60:
                status["state"] = "ok (stopped for this run, continues next run)"
                return save()
            batch = [(u, f) for u, f, _ in items[i:i + PER_CALL[how]]]
            for u, f in batch:  # the listeners' comments (only for the tracks being asked now; not part of the fingerprint)
                c = yt_comments(yt_of.get(u))
                if c:
                    f["comments"] = c
            fps = {u: fp for u, _, fp in items[i:i + PER_CALL[how]]}
            try:
                answers = None
                for attempt in range(8):  # "high demand" (503) usually passes after a short wait
                    try:
                        answers = ask(models[0], how, batch, vocab)
                        status["model"] = models[0]
                        break
                    except urllib.error.HTTPError as e:
                        if e.code == 404 and len(models) > 1:  # retired for this key: drop it
                            print(models.pop(0), "not available:", why(e))
                            continue
                        if e.code == 429 and attempt == 0:  # a per-minute limit passes; a daily one doesn't (stop then)
                            print("rate limit:", why(e)[:120], "- waiting a minute")
                            time.sleep(65)
                            continue
                        if e.code == 429 and len(models) > 1:  # this model's free quota is used up: the next model has its own
                            print(models.pop(0), "out of quota, trying", models[0])
                            continue
                        if e.code not in (500, 503) or attempt == 7:
                            raise
                        print(models[0], "busy:", why(e), "- waiting")
                        time.sleep(20 * (attempt + 1))
            except urllib.error.HTTPError as e:
                if how == "bandcamp" and e.code == 400:  # the URL tool isn't available for this model: skip the Bandcamp pages
                    print("Bandcamp pages skipped:", why(e))
                    break
                status["state"] = "error: " + why(e)
                print(status["state"])
                fails += 1
                if e.code in (429, 403, 400, 401, 404) or fails >= 4:  # out of quota, key/model not allowed, or Google keeps failing: stop
                    return save()
                time.sleep(30)
                continue
            except Exception as e:  # noqa: BLE001
                status["state"] = "error: " + type(e).__name__ + " " + str(e)[:200]
                print("skipped a batch:", status["state"])
                fails += 1
                if fails >= 4:
                    return save()
                time.sleep(PAUSE)
                continue
            fails = 0
            status["state"] = "ok"
            for a in answers if isinstance(answers, list) else []:
                k = a.get("i") if isinstance(a, dict) else None
                if not isinstance(k, int) or not 0 <= k < len(batch):
                    continue
                u = batch[k][0]
                ai[u] = {**clean_answer(a), "how": how, "m": status["model"], "in": fps[u], "v": VERSION}
            status["asked"] += len(batch)
            left -= len(batch)
            print(how, status["asked"], "asked")
            if status["asked"] % 100 < PER_CALL[how]:
                save()
            time.sleep(PAUSE)
    save()


if __name__ == "__main__":
    main()
