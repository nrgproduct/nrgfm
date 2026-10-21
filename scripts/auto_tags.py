"""Automatic tags, set on every update (only these tags are touched; nothing else in a track changes):

  duplicate                 the same link (same YouTube video, same page) is in the archive more than once,
                            or two tracks have the same title once noise like "(Official Video)" is left out
  +10 min / +30 min / +1 hour   tracks this long (length from data/extra.json "d", in seconds); only the biggest one

Usage: python3 scripts/auto_tags.py"""
import json, os, re, time, unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
AUTO = ("duplicate", "+10 min", "+30 min", "+1 hour")
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
    for tr in tracks:
        want = set()
        if id(tr) in dup:
            want.add("duplicate")
        d = (extra.get(tr["url"]) or {}).get("d") or 0
        if d > 3600:
            want.add("+1 hour")
        elif d > 1800:
            want.add("+30 min")
        elif d > 600:
            want.add("+10 min")
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
    if changed:
        json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("automatic tags changed on", changed, "tracks;", len(dup), "duplicates")


if __name__ == "__main__":
    main()
