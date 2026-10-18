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
  const recovered = !!(m.dead && m.wb_title);
  const title = t.title || m.title || m.wb_title || (m.dead ? "Unavailable" : `${PLATFORM[t.platform] || "Link"} track`);
  const author = (m.author_name && t.platform !== "bandcamp" ? m.author_name : "") || m.wb_author || "";
  let thumb = m.thumbnail_url || "";
  if (t.yt) thumb = `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg`;
  const noEmbed = m.status === 401; // video exists but its owner blocks playing it on other sites
  return { title: noEmbed && !t.title ? "Plays on YouTube only" : title, author, thumb, dead: !!m.dead && !noEmbed, noEmbed, recovered, archive: m.wb_url || "", untitled: !t.title && !m.title };
}

function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {};
    t._hay = fold([t.title, m.title, m.author_name, m.wb_title, m.wb_author].filter(Boolean).join(" "));
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
        el("span", { class: "tr-sub" }, [x.author, tr.date ? fmtDate(tr.date) : null, i === 0 ? "Main track" : null, x.recovered ? "deleted, title recovered from the Internet Archive" : null].filter(Boolean).join(", "))),
      x.archive
        ? el("a", { class: "src", href: x.archive, target: "_blank", rel: "noopener" }, "Archive")
        : el("a", { class: "src", href: tr.url, target: "_blank", rel: "noopener" }, PLATFORM[tr.platform] || "Open"));
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

/* ---------- player dock ---------- */
const scripts = {};
function loadScript(src, ready) {
  if (!scripts[src]) scripts[src] = new Promise((res, rej) => {
    if (ready && ready()) return res();
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(); s.onerror = rej;
    document.head.append(s);
  });
  return scripts[src];
}
function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!scripts.yt) scripts.yt = new Promise((res) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); res(); };
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; document.head.append(s);
  });
  return scripts.yt;
}

let adapter = null, loadToken = 0, autoplay = false, seeking = false;
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

function setPlayState(isPlaying) {
  $("#playBtn").textContent = isPlaying ? "Pause" : "Play";
  $("#playBtn").setAttribute("aria-pressed", isPlaying ? "true" : "false");
}
function setTime(cur, dur) {
  if (seeking) return;
  $("#tCur").textContent = fmtTime(cur);
  $("#tDur").textContent = fmtTime(dur);
  const seek = $("#seek");
  seek.max = dur > 0 ? dur : 1;
  seek.value = Math.min(cur, seek.max);
  seek.style.setProperty("--p", (dur > 0 ? (cur / dur) * 100 : 0) + "%");
}
function onEnded() {
  setPlayState(false);
  if (autoplay && playing && playing.index < playing.thread.tracks.length - 1) play(playing.thread, playing.index + 1);
}
const events = { state: setPlayState, time: setTime, ended: onEnded };

/* Each adapter wraps one platform's embed and exposes the same controls. */
function makeYouTube(box, tr, token) {
  const host = el("div"); box.append(host);
  let p = null, timer = null;
  const a = {
    controllable: true,
    ready: loadYT().then(() => new Promise((res) => {
      if (token !== loadToken) return res();
      p = new YT.Player(host, {
        videoId: tr.yt, host: "https://www.youtube-nocookie.com", width: "100%", height: "100%",
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, vq: "hd1080" },
        events: {
          onReady: () => { res(); timer = setInterval(() => p && p.getCurrentTime && events.time(p.getCurrentTime(), p.getDuration()), 250); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING) events.state(true);
            else if (e.data === YT.PlayerState.PAUSED) events.state(false);
            else if (e.data === YT.PlayerState.ENDED) events.ended();
          },
        },
      });
    })),
    play: () => p && p.playVideo(), pause: () => p && p.pauseVideo(),
    seek: (s) => p && p.seekTo(s, true),
    destroy: () => { clearInterval(timer); try { p && p.destroy(); } catch {} },
  };
  return a;
}
function makeSoundCloud(box, tr, src) {
  const f = el("iframe", { src, allow: "autoplay", title: "SoundCloud player" }); box.append(f);
  let w = null, dur = 0;
  return {
    controllable: true,
    ready: loadScript("https://w.soundcloud.com/player/api.js", () => window.SC && SC.Widget).then(() => {
      w = SC.Widget(f); const E = SC.Widget.Events;
      w.bind(E.READY, () => w.getDuration((d) => { dur = d / 1000; events.time(0, dur); }));
      w.bind(E.PLAY, () => { events.state(true); w.getDuration((d) => (dur = d / 1000)); });
      w.bind(E.PAUSE, () => events.state(false));
      w.bind(E.FINISH, () => events.ended());
      w.bind(E.PLAY_PROGRESS, (e) => events.time(e.currentPosition / 1000, dur));
    }),
    play: () => w && w.play(), pause: () => w && w.pause(),
    seek: (s) => w && w.seekTo(s * 1000),
    destroy: () => {},
  };
}
function makeVimeo(box, tr) {
  const f = el("iframe", { src: `https://player.vimeo.com/video/${tr.vimeo}?autoplay=1`, allow: "autoplay; fullscreen", allowfullscreen: true, title: "Vimeo player" }); box.append(f);
  let p = null;
  return {
    controllable: true,
    ready: loadScript("https://player.vimeo.com/api/player.js", () => window.Vimeo).then(() => {
      p = new Vimeo.Player(f);
      p.on("play", () => events.state(true)); p.on("pause", () => events.state(false));
      p.on("ended", () => events.ended());
      p.on("timeupdate", (d) => events.time(d.seconds, d.duration));
    }),
    play: () => p && p.play(), pause: () => p && p.pause(),
    seek: (s) => p && p.setCurrentTime(s),
    destroy: () => { try { p && p.destroy(); } catch {} },
  };
}
function makePlain(box, src, title) {
  box.append(el("iframe", { src, allow: "autoplay; encrypted-media; fullscreen", allowfullscreen: true, title }));
  return { controllable: false, ready: Promise.resolve(), play() {}, pause() {}, seek() {}, destroy() {} };
}

function play(t, i) {
  if (i < 0 || i >= t.tracks.length) return;
  playing = { thread: t, index: i };
  const token = ++loadToken;
  const tr = t.tracks[i], x = info(tr), m = meta[tr.url] || {};
  if (adapter) adapter.destroy();
  adapter = null;
  const box = $("#media"); box.replaceChildren();
  const dock = $("#dock"); dock.hidden = false;
  $("#nowTitle").textContent = x.title;
  $("#nowSub").textContent = `${i + 1} of ${t.tracks.length} in this thread`;
  $("#openSrc").href = x.dead && x.archive ? x.archive : tr.url;
  $("#openSrc").title = `Open on ${x.dead && x.archive ? "the Internet Archive" : PLATFORM[tr.platform] || "the original site"}`;
  $("#prevBtn").disabled = i === 0;
  $("#nextBtn").disabled = i === t.tracks.length - 1;
  setPlayState(false); setTime(0, 0);

  let kind = "video";
  if (x.dead) {
    kind = "note";
    box.append(el("p", { class: "nolink" }, x.archive
      ? "This track was deleted. “Open” shows the archived page; search the title on YouTube to find a re-upload."
      : "This track was deleted and no archived copy of its page was found."));
  } else if (tr.platform === "youtube" && tr.yt && m.status !== 401) {
    adapter = makeYouTube(box, tr, token);
  } else if (tr.platform === "soundcloud") {
    kind = "audio";
    adapter = makeSoundCloud(box, tr, (m.sc_src || `https://w.soundcloud.com/player/?url=${encodeURIComponent(tr.url)}`) + "&auto_play=true&visual=false");
  } else if (tr.platform === "vimeo" && tr.vimeo) {
    adapter = makeVimeo(box, tr);
  } else if (tr.platform === "bandcamp" && m.bandcamp_embed) {
    kind = "audio";
    adapter = makePlain(box, `https://bandcamp.com/EmbeddedPlayer/${m.bandcamp_embed}/size=large/bgcol=182c24/linkcol=6fcb9f/artwork=small/tracklist=false/transparent=true/`, x.title);
  } else if (tr.platform === "mixcloud") {
    kind = "audio";
    adapter = makePlain(box, `https://player-widget.mixcloud.com/widget/iframe/?hide_cover=1&autoplay=1&feed=${encodeURIComponent(new URL(tr.url).pathname)}`, x.title);
  } else {
    kind = "note";
    box.append(el("p", { class: "nolink" }, `This ${PLATFORM[tr.platform] || "link"} can't play here. Use “Open”.`));
  }
  box.dataset.kind = kind;
  const controllable = !!(adapter && adapter.controllable);
  $("#dock").classList.toggle("no-transport", !controllable);
  $("#playBtn").disabled = !controllable; $("#seek").disabled = !controllable;
  if (adapter) adapter.ready.catch(() => {
    if (token !== loadToken) return;
    box.replaceChildren(el("p", { class: "nolink" }, "The player didn't load. Use “Open” to play it on the original site."));
  });
  if (openId === t.id) refreshOpen();
  syncDockSpace();
}

function stop() {
  loadToken++;
  if (adapter) adapter.destroy();
  adapter = null; playing = null;
  $("#media").replaceChildren(); $("#dock").hidden = true;
  refreshOpen(); syncDockSpace();
}

$("#prevBtn").onclick = () => playing && play(playing.thread, playing.index - 1);
$("#nextBtn").onclick = () => playing && play(playing.thread, playing.index + 1);
$("#playBtn").onclick = () => { if (!adapter) return; $("#playBtn").textContent === "Pause" ? adapter.pause() : adapter.play(); };
$("#closeBtn").onclick = stop;

const seekEl = $("#seek");
seekEl.addEventListener("input", () => {
  seeking = true;
  $("#tCur").textContent = fmtTime(+seekEl.value);
  seekEl.style.setProperty("--p", (seekEl.value / seekEl.max) * 100 + "%");
});
seekEl.addEventListener("change", () => { seeking = false; adapter && adapter.seek(+seekEl.value); });

$("#autoBtn").onclick = () => {
  autoplay = !autoplay;
  $("#autoBtn").setAttribute("aria-pressed", autoplay ? "true" : "false");
  $("#autoBtn").textContent = autoplay ? "Autoplay on" : "Autoplay off";
};

function setSize(size) {
  $("#dock").dataset.size = size;
  document.querySelectorAll("#sizes button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.size === size ? "true" : "false"));
  try { localStorage.setItem("nrgfm-size", size); } catch {}
  syncDockSpace();
}
document.querySelectorAll("#sizes button").forEach((b) => (b.onclick = () => setSize(b.dataset.size)));
let savedSize = "m";
try { savedSize = localStorage.getItem("nrgfm-size") || "m"; } catch {}
setSize(savedSize);

/* keep the end of the list reachable above the dock */
function syncDockSpace() {
  const d = $("#dock");
  document.body.style.setProperty("--dock-h", d.hidden ? "0px" : d.offsetHeight + "px");
}
new ResizeObserver(syncDockSpace).observe($("#dock"));

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
    $("#resultInfo").hidden = false;
    $("#resultInfo").textContent = "The archive didn't load. Reload the page to try again.";
    return;
  }
  const deep = location.hash.match(/^#t\/(.+)$/);
  if (deep) {
    const i = threads.findIndex((t) => t.id === deep[1]);
    if (i > -1) { openId = deep[1]; threads.unshift(threads.splice(i, 1)[0]); }
  }
  runSearch();
})();
