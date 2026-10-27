/* nrgfm play log.
   POST /play     (anyone visiting the site) one play, sent after 10 seconds of playing and updated as it goes on
   GET  /days     (key)  the days with plays and how many, in the viewer's time zone (?tz=minutes east of UTC, ?who=)
   GET  /plays    (key)  the plays of one day (?day=YYYY-MM-DD&tz=&who=), or of some tracks (?urls=a|b|c)
   GET  /periods  (key)  the months (?group=month), years (year) or all time (all) with plays, and how many (?min= seconds)
   GET  /top      (key)  the tracks played most in one of them (?group=&p=2026-10&min=&who=)
   GET  /devices  (key)  every device/guest that played
   POST /name     (key)  give a device a name {who, name}
   "key": the site's GitHub key (Authorization: Bearer …), accepted when it can write to the nrgfm repository. */
const REPO = "nrgproduct/nrgfm";
const ORIGINS = ["https://nrgproduct.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const YEAR = 365 * 86400;
const okKeys = new Map(); // key hash -> time it was checked (checked again after 10 minutes)

function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(req) } });
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : null);
const int = (v) => (Number.isFinite(+v) && v !== null && v !== "" ? Math.max(0, Math.round(+v)) : null);

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function isOwner(req) {
  const key = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!key) return false;
  const h = await sha(key), t = okKeys.get(h);
  if (t && Date.now() - t < 600000) return true;
  const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Authorization: `Bearer ${key}`, "User-Agent": "nrgfm-activity", Accept: "application/vnd.github+json" } });
  if (!r.ok) return false;
  const d = await r.json();
  if (!(d.permissions && d.permissions.push)) return false;
  okKeys.set(h, Date.now());
  return true;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/play" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const id = str(p.id, 64), who = str(p.who, 64);
        if (!id || !who || !/^[\w-]+$/.test(id + who)) return json(req, { error: "bad play" }, 400);
        const sec = int(p.sec), now = Math.floor(Date.now() / 1000);
        if (sec !== null && sec < 10) return json(req, { ok: false }); // shorter than 10 seconds: not a play
        const ts = Math.min(now, int(p.ts) || now), cf = req.cf || {};
        const city = cf.city || null, country = cf.country || null;
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO plays (id, ts, who, url, tid, title, sec, dur, city, country) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET sec = MAX(COALESCE(plays.sec, 0), COALESCE(excluded.sec, 0)), dur = COALESCE(excluded.dur, plays.dur)`)
            .bind(id, ts, who, str(p.url, 500), str(p.tid, 80), str(p.title, 300), sec, int(p.dur), city, country),
          env.DB.prepare(`INSERT INTO devices (who, name, owner, city, country, first, last) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(who) DO UPDATE SET owner = MAX(devices.owner, excluded.owner), city = COALESCE(excluded.city, devices.city),
            country = COALESCE(excluded.country, devices.country), last = excluded.last`)
            .bind(who, p.owner ? 1 : 0, city, country, now),
        ]);
        return json(req, { ok: true });
      }
      if (!(await isOwner(req))) return json(req, { error: "key needed" }, 401);
      const tz = Math.max(-840, Math.min(840, Math.round(+url.searchParams.get("tz") || 0))) * 60; // the viewer's offset from UTC
      const who = url.searchParams.get("who");
      const since = Math.floor(Date.now() / 1000) - YEAR;
      if (path === "/days") {
        const m0 = Math.max(0, Math.min(600, Math.round(+url.searchParams.get("min") || 0)));
        const { results } = await env.DB.prepare(`SELECT date(ts + ?1, 'unixepoch') AS day, COUNT(*) AS n FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) GROUP BY day ORDER BY day DESC`).bind(tz, since, who, m0).all();
        return json(req, results);
      }
      if (path === "/plays") {
        const urls = (url.searchParams.get("urls") || "").split("|").filter(Boolean).slice(0, 300);
        if (urls.length) {
          const q = urls.map((_, k) => "?" + (k + 3)).join(",");
          const { results } = await env.DB.prepare(`SELECT * FROM plays WHERE ts > ?1 AND (?2 IS NULL OR who = ?2) AND url IN (${q}) ORDER BY ts DESC LIMIT 2000`)
            .bind(since, who, ...urls).all();
          return json(req, results);
        }
        const day = url.searchParams.get("day") || "";
        if (!/^\d{4}-\d\d-\d\d$/.test(day)) return json(req, { error: "day?" }, 400);
        const start = Math.floor(Date.parse(day + "T00:00:00Z") / 1000) - tz;
        const { results } = await env.DB.prepare(`SELECT * FROM plays WHERE ts >= ?1 AND ts < ?2 AND (?3 IS NULL OR who = ?3) ORDER BY ts DESC`)
          .bind(start, start + 86400, who).all();
        return json(req, results);
      }
      // most played: the months (or years) with plays, and the tracks played most in one of them
      const minSec = Math.max(0, Math.min(600, Math.round(+url.searchParams.get("min") || 0)));
      const group = url.searchParams.get("group") === "year" ? "%Y" : url.searchParams.get("group") === "all" ? "all" : "%Y-%m";
      const per = group === "all" ? "'all'" : `strftime('${group}', ts + ?1, 'unixepoch')`;
      if (path === "/periods") {
        const { results } = await env.DB.prepare(`SELECT ${per} AS p, COUNT(*) AS n FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) GROUP BY p ORDER BY p DESC`).bind(tz, since, who, minSec).all();
        return json(req, results);
      }
      if (path === "/top") {
        const pp = url.searchParams.get("p") || "all";
        const { results } = await env.DB.prepare(`SELECT url, MAX(tid) AS tid, MAX(title) AS title, COUNT(*) AS n, SUM(COALESCE(sec, 0)) AS sec, MAX(ts) AS last FROM plays
          WHERE ts > ?2 AND (?3 IS NULL OR who = ?3) AND (sec IS NULL OR sec >= ?4) AND ${per} = ?5
          GROUP BY url ORDER BY n DESC, last DESC LIMIT 200`).bind(tz, since, who, minSec, pp).all();
        return json(req, results);
      }
      if (path === "/devices") {
        const { results } = await env.DB.prepare(`SELECT d.*, (SELECT COUNT(*) FROM plays p WHERE p.who = d.who AND p.ts > ?1) AS n FROM devices d ORDER BY d.last DESC`).bind(since).all();
        return json(req, results);
      }
      if (path === "/name" && req.method === "POST") {
        const p = await req.json().catch(() => ({}));
        const w = str(p.who, 64), name = (str(p.name, 40) || "").trim();
        if (!w) return json(req, { error: "who?" }, 400);
        await env.DB.prepare(`INSERT INTO devices (who, name, owner, first, last) VALUES (?1, ?2, 1, ?3, ?3)
          ON CONFLICT(who) DO UPDATE SET name = excluded.name, owner = 1`).bind(w, name || null, Math.floor(Date.now() / 1000)).run();
        return json(req, { ok: true });
      }
      return json(req, { error: "not found" }, 404);
    } catch (e) {
      return json(req, { error: String(e && e.message || e).slice(0, 200) }, 500);
    }
  },
  async scheduled(event, env) { // keep one year
    const cut = Math.floor(Date.now() / 1000) - YEAR;
    await env.DB.prepare("DELETE FROM plays WHERE ts < ?1").bind(cut).run();
    await env.DB.prepare("DELETE FROM devices WHERE last < ?1").bind(cut).run();
  },
};
