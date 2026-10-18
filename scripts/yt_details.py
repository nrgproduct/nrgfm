"""Read length, category and age restriction of YouTube videos with the official YouTube Data API.
Needs a free API key stored as the repository secret YT_API_KEY (never in the code or the site).
Results go to data/ytinfo.json, keyed by video id:
  {"len": seconds, "cat": "Music", "age": true/false, "title": ..., "author": ...}  or  {"gone": true}
Ids already in the file are skipped. 50 videos per request; ~100 requests for the whole archive.
Usage: YT_API_KEY=... python3 scripts/yt_details.py"""
import json, os, re, sys, urllib.request, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "ytinfo.json")
CATS = {"1": "Film & Animation", "2": "Autos & Vehicles", "10": "Music", "15": "Pets & Animals", "17": "Sports",
        "19": "Travel & Events", "20": "Gaming", "22": "People & Blogs", "23": "Comedy", "24": "Entertainment",
        "25": "News & Politics", "26": "Howto & Style", "27": "Education", "28": "Science & Technology",
        "29": "Nonprofits & Activism", "30": "Movies", "43": "Shows", "44": "Trailers"}


def seconds(iso):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def main():
    key = os.environ.get("YT_API_KEY")
    if not key:
        sys.exit("No YT_API_KEY secret set; nothing to do.")
    tracks = json.load(open(os.path.join(ROOT, "data", "tracks.json"), encoding="utf-8"))
    info = json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else {}
    info = {k: v for k, v in info.items() if "err" not in v and "status" not in v}  # drop results of the old page reader
    ids = []
    for t in tracks["threads"]:
        for x in t["tracks"]:
            v = x.get("yt")
            if v and v not in info and v not in ids:
                ids.append(v)
    print("to look up", len(ids))
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        q = urllib.parse.urlencode({"part": "snippet,contentDetails", "id": ",".join(batch), "key": key, "maxResults": 50})
        with urllib.request.urlopen("https://www.googleapis.com/youtube/v3/videos?" + q, timeout=30) as r:
            items = json.load(r).get("items", [])
        seen = set()
        for it in items:
            sn, cd = it.get("snippet", {}), it.get("contentDetails", {})
            info[it["id"]] = {
                "len": seconds(cd.get("duration")),
                "cat": CATS.get(sn.get("categoryId"), sn.get("categoryId")),
                "age": (cd.get("contentRating") or {}).get("ytRating") == "ytAgeRestricted",
                "title": sn.get("title"),
                "author": sn.get("channelTitle"),
            }
            seen.add(it["id"])
        for v in batch:
            if v not in seen:
                info[v] = {"gone": True}
    json.dump(info, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    from collections import Counter
    print(Counter(v.get("cat", "gone") for v in info.values()).most_common(20))
    print("age restricted", sum(1 for v in info.values() if v.get("age")))


if __name__ == "__main__":
    main()
