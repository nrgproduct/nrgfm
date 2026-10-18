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
let playing = null; // playing = {thread, index}

/* ---------- data helpers ---------- */
const fold = (s) => (s || "").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, " ").trim();

const PLATFORM = { youtube: "YouTube", soundcloud: "SoundCloud", bandcamp: "Bandcamp", vimeo: "Vimeo", mixcloud: "Mixcloud", spotify: "Spotify" };

const BAD_TITLES = new Set(["client challenge", "just a moment...", "attention required!"]);
// Readable fallback from a Bandcamp link: artist.bandcamp.com/album/some-title -> "Some Title – artist"
function slugTitle(t) {
  if (t.platform !== "bandcamp") return "";
  try {
    const u = new URL(t.url), artist = u.hostname.split(".")[0];
    const slug = u.pathname.split("/").filter(Boolean).pop() || "";
    const name = decodeURIComponent(slug).replace(/-\d+$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return name ? `${name} – ${artist}` : artist;
  } catch { return ""; }
}

function info(t) {
  const m = meta[t.url] || {};
  const recovered = !!(m.dead && m.wb_title);
  const fetched = BAD_TITLES.has((m.title || "").toLowerCase()) ? "" : m.title;
  const title = t.title || fetched || m.wb_title || slugTitle(t) || (m.dead ? "Unavailable" : `${PLATFORM[t.platform] || "Link"} track`);
  const author = (m.author_name && t.platform !== "bandcamp" ? m.author_name : "") || m.wb_author || "";
  let thumb = m.thumbnail_url || "";
  if (t.yt) thumb = `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg`;
  const noEmbed = m.status === 401; // video exists but its owner blocks playing it on other sites
  return { title: noEmbed && !t.title ? "Plays on YouTube only" : title, author, thumb, dead: !!m.dead && !noEmbed, noEmbed, recovered, archive: m.wb_url || "", untitled: !t.title && !m.title };
}

function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {};
    t._hay = fold([t.title, m.title, m.author_name, m.wb_title, m.wb_author, slugTitle(t)].filter(Boolean).join(" "));
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

/* ---------- rendering: every thread is shown open ---------- */
const img = (src, cls) => src
  ? el("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", onerror: (e) => e.target.classList.add("broken") })
  : el("span", { class: cls + " empty" });

function trackRow(t, tr, i, hits) {
  const x = info(tr);
  return el("li", { class: ["track", x.dead && "dead", hits && hits.has(i) && "hit"].filter(Boolean).join(" "), "data-k": `${t.id}:${i}` },
    img(x.thumb, "chip"),
    el("button", { class: "play", onclick: () => play(t, i), "aria-label": `Play ${x.title}` },
      el("span", { class: "tr-title" }, x.title),
      el("span", { class: "tr-sub" }, [x.author, tr.date ? fmtDate(tr.date) : null, x.recovered ? "deleted, title recovered from the Internet Archive" : null].filter(Boolean).join(", "))),
    x.archive
      ? el("a", { class: "src", href: x.archive, target: "_blank", rel: "noopener" }, "Archive")
      : el("a", { class: "src", href: tr.url, target: "_blank", rel: "noopener" }, PLATFORM[tr.platform] || "Open"));
}

function threadNode({ t, hits }) {
  const head = t.tracks[0], hi = info(head);
  const sub = [t.kind === "replies" ? "Replies to a friend's post" : null, hi.author, fmtDate(t.date), `${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"}`].filter(Boolean).join(", ");
  const li = el("li", { class: "thread" + (t.kind === "replies" ? " loose" : ""), id: "th-" + t.id },
    el("button", { class: ["thread-head", hi.dead && "dead", hits && hits.has(0) && "hit"].filter(Boolean).join(" "), "data-k": `${t.id}:0`, onclick: () => play(t, 0), "aria-label": `Play ${hi.title}` },
      el("span", { class: "thumb" }, img(hi.thumb, "thumb-img"), hi.thumb ? null : el("span", { class: "ph" }, PLATFORM[head.platform] || "")),
      el("span", { class: "thread-main" },
        el("span", { class: "t-title" }, hi.title),
        el("span", { class: "t-sub" }, sub))),
    t.tracks.length > 1 ? el("ol", { class: "tracks" }, t.tracks.slice(1).map((tr, k) => trackRow(t, tr, k + 1, hits))) : null,
    el("div", { class: "thread-foot" },
      el("button", { class: "linkbtn", onclick: () => openAdd(t) }, "Add a track here"),
      el("button", { class: "linkbtn", onclick: (e) => copyLink(t, e.target) }, "Copy thread link")));
  return li;
}

function markPlaying() {
  document.querySelectorAll(".playing").forEach((n) => n.classList.remove("playing"));
  if (playing) document.querySelectorAll(`[data-k="${playing.thread.id}:${playing.index}"]`).forEach((n) => n.classList.add("playing"));
}

function renderMore() {
  const frag = document.createDocumentFragment();
  const end = Math.min(shown.length, rendered + PAGE);
  for (; rendered < end; rendered++) frag.append(threadNode(shown[rendered]));
  $("#threads").append(frag);
  markPlaying();
}

new IntersectionObserver((e) => { if (e[0].isIntersecting && rendered < shown.length) renderMore(); }, { rootMargin: "1200px" }).observe($("#more"));

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
let volume = 100;
try { const v = parseInt(localStorage.getItem("nrgfm-volume"), 10); if (v >= 0 && v <= 100) volume = v; } catch {}
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
/* One YouTube player is kept for the whole visit and reused for every YouTube track.
   iPhones only start sound in a player the person has already tapped, so after the first
   play, later tracks (and autoplay through a thread) start by themselves. */
const yt = { player: null, ready: false, active: false, pending: null, waiters: [], timer: null };
function ytSlot() { return $("#ytSlot"); }
function makeYouTube(tr) {
  ytSlot().hidden = false;
  yt.active = true;
  const a = {
    controllable: true,
    play: () => yt.player && yt.player.playVideo(), pause: () => yt.player && yt.player.pauseVideo(),
    seek: (s) => yt.player && yt.player.seekTo(s, true),
    setVolume: (v) => { if (yt.ready) { yt.player.setVolume(v); if (v > 0) yt.player.unMute(); } },
    destroy: () => { yt.active = false; try { yt.ready && yt.player.pauseVideo(); } catch {} ytSlot().hidden = true; },
  };
  if (yt.ready) {
    // load straight away, inside the click, so the browser still counts it as the person's action
    yt.player.loadVideoById(tr.yt);
    try { yt.player.setVolume(volume); } catch {}
    a.ready = Promise.resolve();
    return a;
  }
  yt.pending = tr.yt;
  a.ready = loadYT().then(() => new Promise((res) => {
    yt.waiters.push(res);
    if (yt.player) return; // still starting up; it will load yt.pending when ready
    const host = el("div"); ytSlot().replaceChildren(host);
    yt.player = new YT.Player(host, {
      videoId: yt.pending, host: "https://www.youtube-nocookie.com", width: "100%", height: "100%",
      playerVars: { autoplay: 1, rel: 0, playsinline: 1, vq: "hd1080" },
      events: {
        onReady: () => {
          yt.ready = true;
          try { yt.player.setVolume(volume); } catch {}
          const vid = yt.player.getVideoData && yt.player.getVideoData().video_id;
          if (yt.pending && vid !== yt.pending) yt.player.loadVideoById(yt.pending);
          yt.timer = setInterval(() => { if (yt.active && yt.player.getCurrentTime) events.time(yt.player.getCurrentTime(), yt.player.getDuration()); }, 250);
          yt.waiters.splice(0).forEach((f) => f());
        },
        onStateChange: (e) => {
          if (!yt.active) return;
          if (e.data === YT.PlayerState.PLAYING) events.state(true);
          else if (e.data === YT.PlayerState.PAUSED) events.state(false);
          else if (e.data === YT.PlayerState.ENDED) events.ended();
        },
      },
    });
  }));
  return a;
}
function makeSoundCloud(box, tr, src) {
  const f = el("iframe", { src, allow: "autoplay", title: "SoundCloud player" }); box.append(f);
  let w = null, dur = 0;
  return {
    controllable: true,
    ready: loadScript("https://w.soundcloud.com/player/api.js", () => window.SC && SC.Widget).then(() => {
      w = SC.Widget(f); const E = SC.Widget.Events;
      w.bind(E.READY, () => { w.setVolume(volume); w.getDuration((d) => { dur = d / 1000; events.time(0, dur); }); });
      w.bind(E.PLAY, () => { events.state(true); w.getDuration((d) => (dur = d / 1000)); });
      w.bind(E.PAUSE, () => events.state(false));
      w.bind(E.FINISH, () => events.ended());
      w.bind(E.PLAY_PROGRESS, (e) => events.time(e.currentPosition / 1000, dur));
    }),
    play: () => w && w.play(), pause: () => w && w.pause(),
    seek: (s) => w && w.seekTo(s * 1000),
    setVolume: (v) => w && w.setVolume(v),
    destroy: () => {},
  };
}
function makeVimeo(box, tr) {
  const f = el("iframe", { src: `https://player.vimeo.com/video/${tr.vimeo}?autoplay=1`, allow: "autoplay; fullscreen", allowfullscreen: true, title: "Vimeo player" }); box.append(f);
  let p = null;
  return {
    controllable: true,
    ready: loadScript("https://player.vimeo.com/api/player.js", () => window.Vimeo).then(() => {
      p = new Vimeo.Player(f); p.setVolume(volume / 100).catch(() => {});
      p.on("play", () => events.state(true)); p.on("pause", () => events.state(false));
      p.on("ended", () => events.ended());
      p.on("timeupdate", (d) => events.time(d.seconds, d.duration));
    }),
    play: () => p && p.play(), pause: () => p && p.pause(),
    seek: (s) => p && p.setCurrentTime(s),
    setVolume: (v) => p && p.setVolume(v / 100).catch(() => {}),
    destroy: () => { try { p && p.destroy(); } catch {} },
  };
}
function makePlain(box, src, title) {
  box.append(el("iframe", { src, allow: "autoplay; encrypted-media; fullscreen", allowfullscreen: true, title }));
  return { controllable: false, ready: Promise.resolve(), play() {}, pause() {}, seek() {}, setVolume() {}, destroy() {} };
}

function play(t, i) {
  if (i < 0 || i >= t.tracks.length) return;
  playing = { thread: t, index: i };
  const token = ++loadToken;
  const tr = t.tracks[i], x = info(tr), m = meta[tr.url] || {};
  if (adapter) adapter.destroy();
  adapter = null;
  const box = $("#otherSlot"); box.replaceChildren();
  const dock = $("#dock"); dock.hidden = false;
  $("#nowTitle").textContent = x.title;
  $("#threadBtn").textContent = `${i + 1} of ${t.tracks.length} in this thread`;
  closeThread();
  $("#openSrc").href = x.dead && x.archive ? x.archive : tr.url;
  $("#openSrc").title = `Open the link on ${x.dead && x.archive ? "the Internet Archive" : PLATFORM[tr.platform] || "the original site"}`;
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
    adapter = makeYouTube(tr);
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
  $("#media").dataset.kind = kind;
  const controllable = !!(adapter && adapter.controllable);
  $("#dock").classList.toggle("no-transport", !controllable);
  $("#playBtn").disabled = !controllable; $("#seek").disabled = !controllable; $("#volBtn").disabled = !controllable;
  if (!controllable) closeVol();
  if (adapter) adapter.ready.catch(() => {
    if (token !== loadToken) return;
    ytSlot().hidden = true;
    box.replaceChildren(el("p", { class: "nolink" }, "The player didn't load. Use “Open” to play it on the original site."));
  });
  markPlaying();
  syncDockSpace();
}

$("#prevBtn").onclick = () => playing && play(playing.thread, playing.index - 1);
$("#nextBtn").onclick = () => playing && play(playing.thread, playing.index + 1);
$("#playBtn").onclick = () => { if (!adapter) return; $("#playBtn").textContent === "Pause" ? adapter.pause() : adapter.play(); };

const seekEl = $("#seek");
seekEl.addEventListener("input", () => {
  seeking = true;
  $("#tCur").textContent = fmtTime(+seekEl.value);
  seekEl.style.setProperty("--p", (seekEl.value / seekEl.max) * 100 + "%");
});
seekEl.addEventListener("change", () => { seeking = false; adapter && adapter.seek(+seekEl.value); });

/* thread menu: list the playing thread above the bar; picking a track plays it and closes the menu */
function closeThread() { $("#threadPop").hidden = true; $("#threadBtn").setAttribute("aria-expanded", "false"); }
function openThread() {
  if (!playing) return;
  const t = playing.thread;
  $("#threadList").replaceChildren(...t.tracks.map((tr, i) => {
    const x = info(tr);
    return el("li", {},
      el("button", { class: "tl-item" + (i === playing.index ? " current" : "") + (x.dead ? " dead" : ""), onclick: () => play(t, i), "aria-current": i === playing.index ? "true" : null },
        img(x.thumb, "chip"),
        el("span", { class: "tl-text" },
          el("span", { class: "tr-title" }, x.title),
          el("span", { class: "tr-sub" }, [i === 0 ? "Main track" : null, x.author].filter(Boolean).join(", ")))));
  }));
  $("#threadPop").hidden = false; $("#threadBtn").setAttribute("aria-expanded", "true");
  $("#threadList .current")?.scrollIntoView({ block: "nearest" });
}
$("#threadBtn").onclick = (e) => { e.stopPropagation(); $("#threadPop").hidden ? openThread() : closeThread(); };
$("#threadPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeThread);

/* copy the playing track's original link */
$("#copyBtn").onclick = (e) => { if (playing) copyText(playing.thread.tracks[playing.index].url, e.currentTarget, "Copied"); };

/* volume popup; the level is remembered and applied to every track that loads */
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (IOS) $("#volWrap").hidden = true; // iOS only allows the hardware volume buttons
function closeVol() { $("#volPop").hidden = true; $("#volBtn").setAttribute("aria-expanded", "false"); }
function showVolume() {
  $("#vol").value = volume; $("#volVal").textContent = volume;
  $("#vol").style.setProperty("--p", volume + "%");
}
showVolume();
$("#volBtn").onclick = (e) => {
  e.stopPropagation();
  const open = $("#volPop").hidden;
  $("#volPop").hidden = !open; $("#volBtn").setAttribute("aria-expanded", open ? "true" : "false");
};
$("#volPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", closeVol);
$("#vol").addEventListener("input", () => {
  volume = +$("#vol").value; showVolume();
  adapter && adapter.setVolume(volume);
  try { localStorage.setItem("nrgfm-volume", String(volume)); } catch {}
});

$("#autoBtn").onclick = () => {
  autoplay = !autoplay;
  $("#autoBtn").setAttribute("aria-pressed", autoplay ? "true" : "false");
  $("#autoBtn").textContent = autoplay ? "Autoplay on" : "Autoplay off";
};



/* keep the end of the list reachable above the dock */
function syncDockSpace() {
  const d = $("#dock");
  document.body.style.setProperty("--dock-h", d.hidden ? "0px" : d.offsetHeight + "px");
}
new ResizeObserver(syncDockSpace).observe($("#dock"));

/* ---------- add track (via GitHub's web editor, no token needed) ---------- */
let addTarget = null, lastAdded = null;
function openAdd(t) {
  addTarget = t || (playing && playing.thread) || null;
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

async function copyText(text, btn, done) {
  try { await navigator.clipboard.writeText(text); } catch { prompt("Copy this:", text); return; }
  if (!btn) return;
  const old = btn.textContent; btn.textContent = done;
  setTimeout(() => (btn.textContent = old), 1500);
}
function copyLink(t, btn) {
  copyText(`${location.origin}${location.pathname}#t/${t.id}`, btn, "Copied");
}

/* ---------- boot ---------- */
let timer;
$("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); });
$("#home").onclick = (e) => { e.preventDefault(); $("#q").value = ""; history.replaceState(null, "", location.pathname); runSearch(); scrollTo(0, 0); };

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
    if (i > -1) threads.unshift(threads.splice(i, 1)[0]);
  }
  runSearch();
})();
