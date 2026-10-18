"use strict";
const REPO = "nrgproduct/nrgfm";
const PAGE = 40;

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
  return n;
};

let threads = [], meta = {}, shown = [], rendered = 0, query = "";
let openId = null, playing = null; // playing = {thread, index}

/* ---------- data helpers ---------- */
const fold = (s) => (s || "").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

const PLATFORM = { youtube: "YouTube", soundcloud: "SoundCloud", bandcamp: "Bandcamp", vimeo: "Vimeo", mixcloud: "Mixcloud", spotify: "Spotify" };

function info(t) {
  const m = meta[t.url] || {};
  const title = t.title || m.title || (m.dead ? "Unavailable" : `${PLATFORM[t.platform] || "Link"} track`);
  const author = m.author_name && t.platform !== "bandcamp" ? m.author_name : "";
  let thumb = m.thumbnail_url || "";
  if (t.yt) thumb = `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg`;
  const noEmbed = m.status === 401; // video exists but its owner blocks playing it on other sites
  return { title: noEmbed && !t.title ? "Plays on YouTube only" : title, author, thumb, dead: !!m.dead && !noEmbed, noEmbed, untitled: !t.title && !m.title };
}

function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {};
    t._hay = fold([t.title, m.title, m.author_name].filter(Boolean).join(" "));
  }
  return t._hay;
}

const fmtDate = (d) => {
  const [y, mo] = d.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}`;
};

/* ---------- search ---------- */
function runSearch() {
  query = fold($("#q").value);
  const terms = query.split(" ").filter(Boolean);
  if (!terms.length) {
    shown = threads.map((t) => ({ t, hits: null }));
    $("#resultInfo").hidden = true;
  } else {
    shown = [];
    for (const t of threads) {
      const hits = new Set();
      t.tracks.forEach((tr, i) => {
        const h = haystack(tr);
        if (terms.every((w) => h.includes(w))) hits.add(i);
      });
      if (hits.size) shown.push({ t, hits });
    }
    const n = shown.reduce((a, s) => a + s.hits.size, 0);
    $("#resultInfo").hidden = false;
    $("#resultInfo").textContent = n
      ? `${n} ${n === 1 ? "track" : "tracks"} in ${shown.length} ${shown.length === 1 ? "thread" : "threads"}`
      : `Nothing matches “${$("#q").value.trim()}”. Many old links have no title yet; try fewer words.`;
  }
  rendered = 0;
  $("#threads").replaceChildren();
  renderMore();
}

/* ---------- rendering ---------- */
function threadNode({ t, hits }) {
  const firstHit = hits ? [...hits][0] : 0;
  const head = t.tracks[firstHit];
  const hi = info(head);
  const others = t.tracks.filter((_, i) => i !== firstHit);
  const strip = el("span", { class: "strip" },
    others.slice(0, 12).map((tr) => {
      const idx = t.tracks.indexOf(tr);
      return el("span", { class: "chip" + (hits && hits.has(idx) ? " hit" : ""), style: `background-image:url(${info(tr).thumb})`, title: info(tr).title });
    }),
    others.length > 12 ? el("span", { class: "count" }, `+${others.length - 12}`) : null,
    others.length ? null : el("span", { class: "count" }, "No similar tracks yet"));
  const sub = [t.kind === "replies" ? "Replies to a friend's post" : null, hi.author, fmtDate(t.date), `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}`].filter(Boolean).join(", ");
  const li = el("li", { class: "thread" + (t.kind === "replies" ? " loose" : ""), id: "th-" + t.id },
    el("button", { class: "thread-head", "aria-expanded": "false", onclick: () => toggle(t.id) },
      el("span", { class: "thumb", style: hi.thumb ? `background-image:url(${hi.thumb})` : "" }, hi.thumb ? null : el("span", { class: "ph" }, PLATFORM[head.platform] || "")),
      el("span", { class: "thread-main" },
        el("span", { class: "t-title" }, hi.title),
        el("span", { class: "t-sub" }, sub),
        strip)));
  li._data = { t, hits };
  if (openId === t.id) expand(li);
  return li;
}

function expand(li) {
  const { t, hits } = li._data;
  li.querySelector(".thread-head").setAttribute("aria-expanded", "true");
  const list = el("ol", { class: "tracks" }, t.tracks.map((tr, i) => {
    const x = info(tr);
    const isPlaying = playing && playing.thread === t && playing.index === i;
    return el("li", { class: ["track", x.dead && "dead", hits && hits.has(i) && "hit", isPlaying && "playing"].filter(Boolean).join(" ") },
      el("span", { class: "chip", style: x.thumb ? `background-image:url(${x.thumb})` : "" }),
      el("button", { class: "play", onclick: () => play(t, i), "aria-label": `Play ${x.title}` },
        el("span", { class: "tr-title" }, x.title),
        el("span", { class: "tr-sub" }, [x.author, tr.date ? fmtDate(tr.date) : null, i === 0 ? "Main track" : null].filter(Boolean).join(", "))),
      el("a", { class: "src", href: tr.url, target: "_blank", rel: "noopener" }, PLATFORM[tr.platform] || "Open"));
  }));
  const foot = el("div", { class: "thread-foot" },
    el("button", { class: "linkbtn", onclick: () => play(t, 0) }, "Play from the top"),
    el("button", { class: "linkbtn", onclick: () => openAdd(t) }, "Add a track here"),
    el("button", { class: "linkbtn", onclick: () => copyLink(t) }, "Copy link"));
  li.append(list, foot);
}

function collapse(li) {
  li.querySelector(".thread-head").setAttribute("aria-expanded", "false");
  li.querySelector(".tracks")?.remove();
  li.querySelector(".thread-foot")?.remove();
}

function toggle(id) {
  const prev = openId && document.getElementById("th-" + openId);
  if (prev) collapse(prev);
  if (openId === id) { openId = null; history.replaceState(null, "", location.pathname); return; }
  openId = id;
  history.replaceState(null, "", "#t/" + id);
  const li = document.getElementById("th-" + id);
  if (li) expand(li);
}

function refreshOpen() {
  const li = openId && document.getElementById("th-" + openId);
  if (li) { collapse(li); expand(li); }
}

function renderMore() {
  const frag = document.createDocumentFragment();
  const end = Math.min(shown.length, rendered + PAGE);
  for (; rendered < end; rendered++) frag.append(threadNode(shown[rendered]));
  $("#threads").append(frag);
}

new IntersectionObserver((e) => { if (e[0].isIntersecting && rendered < shown.length) renderMore(); }, { rootMargin: "800px" }).observe($("#more"));

/* ---------- player ---------- */
function embedFor(tr) {
  const m = meta[tr.url] || {};
  const enc = encodeURIComponent;
  switch (tr.platform) {
    case "youtube": return tr.yt && m.status !== 401 ? { src: `https://www.youtube-nocookie.com/embed/${tr.yt}?autoplay=1&rel=0`, video: true } : null;
    case "vimeo": return tr.vimeo ? { src: `https://player.vimeo.com/video/${tr.vimeo}?autoplay=1`, video: true } : null;
    case "soundcloud": return { src: (m.sc_src || `https://w.soundcloud.com/player/?url=${enc(tr.url)}`) + "&auto_play=true&visual=false" };
    case "bandcamp": return m.bandcamp_embed ? { src: `https://bandcamp.com/EmbeddedPlayer/${m.bandcamp_embed}/size=large/bgcol=182c24/linkcol=6fcb9f/artwork=small/tracklist=false/transparent=true/` } : null;
    case "mixcloud": return { src: `https://player-widget.mixcloud.com/widget/iframe/?hide_cover=1&autoplay=1&feed=${enc(new URL(tr.url).pathname)}` };
    default: return null;
  }
}

function play(t, i) {
  if (i < 0 || i >= t.tracks.length) return;
  playing = { thread: t, index: i };
  const tr = t.tracks[i], x = info(tr), e = embedFor(tr);
  $("#player").hidden = false;
  $("#nowTitle").textContent = x.title;
  $("#nowSub").textContent = `${i + 1} of ${t.tracks.length} in this thread`;
  $("#openSrc").href = tr.url;
  $("#openSrc").textContent = "Open"; $("#openSrc").title = `Open on ${PLATFORM[tr.platform] || "the original site"}`;
  $("#prevBtn").disabled = i === 0;
  $("#nextBtn").disabled = i === t.tracks.length - 1;
  const wrap = $("#frameWrap");
  wrap.className = "frame" + (e && !e.video ? " audio" : "");
  wrap.replaceChildren(e
    ? el("iframe", { src: e.src, allow: "autoplay; encrypted-media; fullscreen", allowfullscreen: true, title: x.title })
    : el("p", { class: "nolink" }, `This ${PLATFORM[tr.platform] || "link"} can't play here yet. Use “Open” above.`));
  if (openId === t.id) refreshOpen();
}

$("#prevBtn").onclick = () => playing && play(playing.thread, playing.index - 1);
$("#nextBtn").onclick = () => playing && play(playing.thread, playing.index + 1);
$("#closeBtn").onclick = () => { $("#frameWrap").replaceChildren(); $("#player").hidden = true; playing = null; refreshOpen(); };

/* ---------- add track (via GitHub's web editor, no token needed) ---------- */
let addTarget = null, lastAdded = null;
function openAdd(t) {
  addTarget = t || (openId && threads.find((x) => x.id === openId)) || null;
  $("#addForm").hidden = false; $("#shareStep").hidden = true; $("#copied").hidden = true;
  $("#addForm").reset();
  $("#replyOpt").hidden = !addTarget;
  if (addTarget) {
    $("#replyLabel").textContent = `Add to “${info(addTarget.tracks[0]).title}”`;
    if (t) $("#addForm").where.value = "reply";
  }
  $("#addDlg").showModal();
}
$("#addBtn").onclick = () => openAdd(null);
$("#aCancel").onclick = () => $("#addDlg").close();
$("#shareDone").onclick = () => $("#addDlg").close();

$("#addForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const url = $("#aUrl").value.trim();
  if (!/^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|soundcloud\.com|[\w-]+\.bandcamp\.com|bandcamp\.com|vimeo\.com|mixcloud\.com|open\.spotify\.com)\//i.test(url)) {
    $("#aUrl").setCustomValidity("Use a YouTube, SoundCloud, Bandcamp, Vimeo or Mixcloud link.");
    $("#aUrl").reportValidity();
    return;
  }
  const ts = Math.floor(Date.now() / 1000);
  const reply = $("#addForm").where.value === "reply" && addTarget;
  const item = { url, title: $("#aTitle").value.trim(), thread: reply ? addTarget.id : "", ts };
  const file = `inbox/${ts}.json`;
  const gh = `https://github.com/${REPO}/new/main?filename=${encodeURIComponent(file)}&value=${encodeURIComponent(JSON.stringify(item, null, 2))}&message=${encodeURIComponent("Add track")}`;
  window.open(gh, "_blank", "noopener");
  lastAdded = item;
  $("#fbShare").href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
  $("#addForm").hidden = true; $("#shareStep").hidden = false;
});
$("#aUrl").addEventListener("input", () => $("#aUrl").setCustomValidity(""));

$("#fbCopy").onclick = async () => {
  if (!lastAdded) return;
  const text = lastAdded.title ? `${lastAdded.title}\n${lastAdded.url}` : lastAdded.url;
  try { await navigator.clipboard.writeText(text); $("#copied").hidden = false; }
  catch { prompt("Copy this:", text); }
};

async function copyLink(t) {
  const link = `${location.origin}${location.pathname}#t/${t.id}`;
  try { await navigator.clipboard.writeText(link); } catch { prompt("Copy this link:", link); }
}

/* ---------- boot ---------- */
let timer;
$("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); });
$("#home").onclick = (e) => { e.preventDefault(); $("#q").value = ""; openId = null; history.replaceState(null, "", location.pathname); runSearch(); scrollTo(0, 0); };

(async function boot() {
  try {
    const [d, m] = await Promise.all([
      fetch("data/tracks.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    threads = d.threads; meta = m;
  } catch (e) {
    $("#stats").textContent = "The archive didn't load. Reload the page to try again.";
    return;
  }
  const n = threads.reduce((a, t) => a + t.tracks.length, 0);
  const first = threads.reduce((a, t) => (t.date < a ? t.date : a), "9999");
  $("#stats").textContent = `${n.toLocaleString("en")} tracks in ${threads.length} threads since ${first.slice(0, 4)}`;
  const deep = location.hash.match(/^#t\/(.+)$/);
  if (deep) {
    const i = threads.findIndex((t) => t.id === deep[1]);
    if (i > -1) { openId = deep[1]; threads.unshift(threads.splice(i, 1)[0]); }
  }
  runSearch();
})();
