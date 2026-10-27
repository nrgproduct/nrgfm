"""Automatic tags, set on every update (only these tags are touched; nothing else in a track changes):

  duplicate                 the same link (same YouTube video, same page) is in the archive more than once,
                            or two tracks have the same title once noise like "(Official Video)" is left out
  +30 min / +1 hour        tracks this long (length from data/extra.json "d", in seconds); only the biggest one
  japanese characters      the title has kana (hiragana/katakana), or Han characters (kanji) and the track isn't Chinese
  chinese characters       the title has Han characters (hanzi), no kana, and the track's country is China, Taiwan, Hong Kong,
                           Macau or Singapore (titles with only Han characters are mostly Japanese in this archive)
  korean characters        the title has Hangul (a title can get more than one of these)
  backup link              the main link has been gone for more than a day and the track plays from its alternative link

Usage: python3 scripts/auto_tags.py"""
import json, os, re, time, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUTO = ("backup link", "duplicate", "+10 min", "+30 min", "+1 hour", "japanese characters", "chinese characters", "korean characters")
KANA = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]")                      # hiragana, katakana (also half-width)
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f]")  # Han characters (CJK unified ideographs)
HANGUL = re.compile(r"[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]")                     # Hangul syllables and jamo
NOISE = re.compile(r"[\(\[][^\)\]]*\b(official|lyric|lyrics|audio|video|hd|hq|4k|remaster(ed)?|visuali[sz]er|explicit|clip|music video|mv|full album|out now|premiere)\b[^\)\]]*[\)\]]", re.I)
GENERIC = {"", "plays on youtube only", "unavailable", "untitled", "youtube track", "soundcloud track"}


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"[​-‏﻿]", "", s)
    if " · " in s:  # YouTube "Title · Artist": the same as "Artist - Title"
        a, b = s.split(" · ", 1)
        s = b + " - " + a
    s = NOISE.sub(" ", s)
    s = re.sub(r"\b(19|20)\d\d\b", " ", s)          # a year in the title
    s = re.sub(r"[^\w]+", " ", s)                     # punctuation and dashes
    return re.sub(r"\s+", " ", s).strip()


def link_key(tr):
    if not tr.get("url"):
        return "id:" + tr["id"]  # (no link: never a duplicate by link)
    if tr.get("yt"):
        return "yt:" + tr["yt"]
    u = re.sub(r"^https?://(www\.|m\.)?", "", tr["url"].strip().lower()).split("#")[0].rstrip("/")
    return "u:" + re.sub(r"[?&](si|feature|utm_[a-z]+)=[^&]*", "", u)


def main():
    p = os.path.join(DATA, "tracks.json")
    data = json.load(open(p, encoding="utf-8"))
    meta = json.load(open(os.path.join(DATA, "meta.json"), encoding="utf-8"))
    ep = os.path.join(DATA, "extra.json")
    extra = json.load(open(ep, encoding="utf-8")) if os.path.exists(ep) else {}
    ap = os.path.join(DATA, "ai.json")
    ai = json.load(open(ap, encoding="utf-8")) if os.path.exists(ap) else {}
    tracks = [tr for th in data["threads"] for tr in th["tracks"]]
    by_link, by_title = {}, {}
    for tr in tracks:
        by_link.setdefault(link_key(tr), []).append(tr)
        m = meta.get(tr["url"], {})
        t = fold(tr.get("title") or m.get("title") or m.get("wb_title") or "")
        if t not in GENERIC and len(t) >= 6:
            by_title.setdefault(t, []).append(tr)
    dup = {id(tr) for group in list(by_link.values()) + list(by_title.values()) if len(group) > 1 for tr in group}
    now, changed = int(time.time()), 0
    dp = os.path.join(DATA, "link-down.json")  # main links found gone, and since when (for "backup link")
    down = json.load(open(dp, encoding="utf-8")) if os.path.exists(dp) else {}
    for tr in tracks:
        want = set()
        if id(tr) in dup:
            want.add("duplicate")
        d = (extra.get(tr["url"]) or {}).get("d") or 0
        if d > 3600:
            want.add("+1 hour")
        elif d > 1800:
            want.add("+30 min")  # ("+10 min" is no longer used; it is listed above only so old ones get removed)
        m = meta.get(tr["url"], {})
        title = " ".join(x for x in (tr.get("title"), m.get("title"), m.get("wb_title")) if x)
        x = extra.get(tr["url"]) or {}
        a = ai.get(tr["url"]) or {}
        co = {c.strip().upper() for c in (x.get("co") or a.get("co") or "").split(",")}
        han, kana, hangul = HAN.search(title), KANA.search(title), HANGUL.search(title)
        chinese = han and not kana and co & {"CN", "TW", "HK", "MO", "SG"}
        if kana or (han and not chinese and not (hangul and co & {"KR", "KP"})):
            want.add("japanese characters")
        if chinese:
            want.add("chinese characters")
        if hangul:
            want.add("korean characters")
        mm = meta.get(tr["url"], {})
        if tr.get("alt") and (mm.get("dead") or mm.get("status") == 401) and not meta.get(tr["alt"], {}).get("dead"):
            since = down.setdefault(tr["url"], now)  # first seen gone; the tag only after a day
            if now - since > 86400:
                want.add("backup link")
        else:
            down.pop(tr["url"], None)
        tags = tr.get("tags") or {}
        have = {g for g in AUTO if g in tags}
        if have == want:
            continue
        changed += 1
        for g in have - want:
            tags.pop(g)
        for g in want - have:
            tags[g] = now
        if tags:
            tr["tags"] = tags
        else:
            tr.pop("tags", None)
    if down or os.path.exists(dp):
        json.dump(down, open(dp, "w", encoding="utf-8"), indent=1)
    if changed:
        json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("automatic tags changed on", changed, "tracks;", len(dup), "duplicates")


if __name__ == "__main__":
    main()
