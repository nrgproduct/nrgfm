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

/* "Randy Newman - Topic" -> "Randy Newman", "KTTunstallVEVO" -> "KT Tunstall".
   Only for YouTube's automatic artist channels and VEVO; labels ("...RecordingsVEVO") are skipped. */
function channelArtist(author) {
  if (!author) return "";
  let a = "";
  if (/\s-\sTopic$/i.test(author)) a = author.replace(/\s-\sTopic$/i, "");
  else if (/VEVO$/.test(author)) a = author.replace(/VEVO$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  a = a.trim();
  if (!a || /various artists|records|recordings|music$/i.test(a)) return "";
  return a;
}
/* "Emotions · Mariah Carey" -> "Mariah Carey – Emotions"; a trailing year stays at the end:
   "Suimasen · Blonde Redhead (1998)" -> "Blonde Redhead – Suimasen (1998)" */
function flipDotTitle(title) {
  const parts = title.split(" · ");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) return title;
  const m = parts[1].trim().match(/^(.*?)\s*(\(\d{4}\))?$/);
  const artist = m[1], year = m[2] ? " " + m[2] : "";
  return `${artist} – ${parts[0].trim()}${year}`;
}
const HAS_ARTIST_SEP = /\s[-–—]\s|\S[-–—]\s|\s[-–—]\S/;

function info(t) {
  const m = meta[t.url] || {};
  const recovered = !!(m.dead && m.wb_title);
  const fetched = BAD_TITLES.has((m.title || "").toLowerCase()) ? "" : m.title;
  const channel = (m.author_name && t.platform !== "bandcamp" ? m.author_name : "") || m.wb_author || "";
  const artist = channelArtist(channel);
  let title = t.title || fetched || m.wb_title || slugTitle(t) || (m.dead ? "Unavailable" : `${PLATFORM[t.platform] || "Link"} track`);
  // link-only tracks from artist channels: put the artist in front of YouTube's bare song title
  if (!t.title && artist && (fetched || m.wb_title) && !HAS_ARTIST_SEP.test(title) && !title.toLowerCase().includes(artist.toLowerCase())) title = `${artist} – ${title}`;
  title = flipDotTitle(title);
  const author = artist || channel;
  let thumb = m.thumbnail_url || "";
  if (t.yt) thumb = `https://i.ytimg.com/vi/${t.yt}/mqdefault.jpg`;
  const noEmbed = m.status === 401; // video exists but its owner blocks playing it on other sites
  return { title: noEmbed && !t.title ? "Plays on YouTube only" : title, author, thumb, dead: !!m.dead && !noEmbed, noEmbed, recovered, archive: m.wb_url || "", untitled: !t.title && !m.title };
}

function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {};
    t._hay = fold([t.title, m.title, m.author_name, channelArtist(m.author_name), m.wb_title, m.wb_author, slugTitle(t)].filter(Boolean).join(" "));
  }
  return t._hay;
}

const fmtDate = (d) => {
  const [y, mo] = d.split("-");
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}`;
};

/* ---------- tags: every tag is also shown as a thread (a playlist) ---------- */
const normTag = (g) => (g || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
const isBase = (t) => t.kind !== "tag";
function activity(t) {
  if (t.kind === "tag") return t.last;
  let a = t.ts || 0; // only new tracks count as activity, not edits, tags or moves
  for (const x of t.tracks) if (x.ts > a) a = x.ts;
  return a;
}
function makeTagThreads() {
  const by = new Map();
  for (const t of threads) {
    if (!isBase(t)) continue;
    for (const tr of t.tracks) for (const [g, ts] of Object.entries(tr.tags || {})) {
      if (!by.has(g)) by.set(g, []);
      by.get(g).push({ tr, ts });
    }
  }
  return [...by].map(([g, list]) => {
    list.sort((a, b) => b.ts - a.ts || b.tr.ts - a.tr.ts); // the most recently tagged first
    return { id: "tag-" + fold(g).replace(/ /g, "-"), name: g, kind: "tag", ts: list[list.length - 1].ts, last: list[0].ts, tracks: list.map((x) => x.tr) };
  });
}
function allTags() {
  const n = new Map();
  for (const t of threads) if (isBase(t)) for (const tr of t.tracks) for (const g of Object.keys(tr.tags || {})) n.set(g, (n.get(g) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}
function sortThreads() {
  threads.sort((a, b) => activity(b) - activity(a));
}
/* after a change: rebuild the tag threads and update the ones on screen without moving the page */
function refreshTags() {
  const fresh = makeTagThreads(), byId = new Map(fresh.map((t) => [t.id, t]));
  const old = threads.filter((t) => !isBase(t));
  threads = threads.filter(isBase);
  for (const t of old) {
    const node = document.getElementById("th-" + t.id);
    const nt = byId.get(t.id);
    if (!nt) { if (node) node.remove(); shown = shown.filter((x) => x.t !== t); continue; }
    if (playing && playing.thread === t) playing.thread = nt;
    shown.forEach((x) => { if (x.t === t) x.t = nt; });
    if (node) node.replaceWith(threadNode({ t: nt, hits: null }));
  }
  for (const t of fresh) {
    if (old.some((o) => o.id === t.id)) { threads.push(t); continue; }
    threads.unshift(t); // a new tag shows up at the top
    if (!$("#q").value.trim()) {
      const node = threadNode({ t, hits: null });
      $("#threads").prepend(node);
      shown.unshift({ t, hits: null }); rendered++;
    }
  }
  markPlaying();
}

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
      if (t.kind === "tag") { // a tag shows up when its name matches; its tracks are found in their own threads
        if (terms.every((w) => fold(t.name).includes(w))) shown.push({ t, hits: null, tag: true });
        continue;
      }
      const hits = new Set();
      t.tracks.forEach((tr, i) => {
        const h = haystack(tr);
        if (terms.every((w) => h.includes(w))) hits.add(i);
      });
      if (hits.size) shown.push({ t, hits });
    }
    // searching a tag's name: its playlist comes first
    shown.sort((x, y) => (y.tag ? 1 : 0) - (x.tag ? 1 : 0)); // matching tags first
    const tagHits = shown.filter((s) => s.tag).length, trackThreads = shown.length - tagHits;
    const n = shown.reduce((a, s) => a + (s.hits ? s.hits.size : 0), 0);
    const parts = [];
    if (tagHits) parts.push(`${tagHits} ${tagHits === 1 ? "tag" : "tags"}`);
    if (n) parts.push(`${n} ${n === 1 ? "track" : "tracks"} in ${trackThreads} ${trackThreads === 1 ? "thread" : "threads"}`);
    $("#resultInfo").hidden = false;
    $("#resultInfo").textContent = parts.length ? parts.join(", ")
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

/* tags under a title; clicking one searches for it */
function tagLine(tr, extra) {
  const tags = Object.keys(tr.tags || {});
  return [...tags.map((g) => el("span", { class: "tag" }, g)), extra ? el("span", { class: "sub-note" }, extra) : null];
}
function searchFor(text) { $("#q").value = text; syncClear(); runSearch(); scrollTo(0, 0); }
const fmtDay = (d) => { const [y, mo, da] = (d || "").split("-"); return y ? `${+da} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}` : ""; };
const RECOVERED = "deleted, title recovered from the Internet Archive";

function trackRow(t, tr, i, hits) {
  const x = info(tr);
  return el("li", { class: ["track", x.dead && "dead", hits && hits.has(i) && "hit"].filter(Boolean).join(" "), "data-k": `${t.id}:${i}` },
    img(x.thumb, "chip"),
    el("button", { class: "play", onclick: () => play(t, i), "aria-label": `Play ${x.title}` },
      el("span", { class: "tr-title" }, x.title),
      el("span", { class: "tr-sub" }, tagLine(tr, x.recovered ? RECOVERED : null))),
    rowLinks(t, i, x));
}

/* right side of a row: "Edit" (only on a device with a key) and the platform link */
function rowLinks(t, i, x) {
  const tr = t.tracks[i];
  const findable = x.dead && x.title !== "Unavailable";
  return el("span", { class: "row-links" },
    el("button", { class: "linkbtn edit-btn", onclick: (e) => toggleEditForm(t, i, e.currentTarget.closest("[data-k]")) }, "Edit"),
    findable ? el("a", { class: "src find-yt", href: "https://www.youtube.com/results?search_query=" + encodeURIComponent(x.title), target: "_blank", rel: "noopener", title: "Look for this title on YouTube" }, "Search") : null,
    x.archive
      ? el("a", { class: "src", href: x.archive, target: "_blank", rel: "noopener" }, "Archive")
      : el("a", { class: "src", href: tr.url, target: "_blank", rel: "noopener" }, PLATFORM[tr.platform] || "Open"));
}

/* A tag is shown as its own thread: a blue "tag" box, the tag's name, and its first 8 tracks
   (Expand shows all of them). */
const TAG_PREVIEW = 5;
const SEARCH_AROUND = 5;       // in search results: 5 replies, the hit in the middle
const threadLimit = () => (phone() ? 12 : 30); // tracks shown before Expand appears
const expanded = new Set();    // threads opened with Expand
const scrollOn = new Set();    // search results whose list was switched to scrolling
const userToggled = new Set();

const phone = () => window.matchMedia("(max-width: 640px)").matches;
const headerBottom = () => $(".top").getBoundingClientRect().bottom;
const btn = (cls, label, fn) => el("button", { class: "more-toggle " + cls, onclick: fn }, label);

function rerenderKeep(t, hits) {
  const node = document.getElementById("th-" + t.id);
  if (!node) return null;
  const fresh = threadNode({ t, hits });
  node.replaceWith(fresh);
  markPlaying();
  return fresh;
}
function toggleExpand(t, hits) {
  userToggled.add(t.id);
  const wasOpen = expanded.has(t.id);
  wasOpen ? expanded.delete(t.id) : expanded.add(t.id);
  const fresh = rerenderKeep(t, hits);
  if (!fresh) return;
  if (wasOpen && fresh.getBoundingClientRect().top < headerBottom()) fresh.scrollIntoView({ block: "start" });
  fitList(fresh, !wasOpen);
}
function toggleScroll(t, hits) {
  scrollOn.has(t.id) ? scrollOn.delete(t.id) : scrollOn.add(t.id);
  const fresh = rerenderKeep(t, hits);
  if (fresh) fitList(fresh);
}

/* Expanded: the thread moves to the top of the window and its list fills the rest of it
   (down to the player) and scrolls inside. Collapsed boxes on a laptop show a few tracks and
   scroll for the rest. The counter follows the scrolling. */
function fitList(node, scroll) {
  if (!node) return;
  const list = node.querySelector(".scroll-list");
  if (!list || !list.children.length) return;
  if (!list.classList.contains("open")) {
    const rows = [...list.querySelectorAll(":scope > li.track")];
    const last = rows[Math.min(rows.length, +list.dataset.show || TAG_PREVIEW) - 1];
    if (last) list.style.maxHeight = last.offsetTop + last.offsetHeight + 4 + "px";
    const focus = list.querySelector(":scope > li.track.hit");
    if (focus && list.dataset.centred !== "1") { // search: put the hit in the middle
      list.dataset.centred = "1";
      list.scrollTop = focus.offsetTop - (list.clientHeight - focus.offsetHeight) / 2;
    }
    updateListPos(node);
    return;
  }
  if (scroll) {
    const anchor = phone() ? node.querySelector(".tag-side, .thread-more") || node : node;
    scrollBy(0, anchor.getBoundingClientRect().top - headerBottom() - 8);
  }
  const dock = $("#dock").hidden ? 0 : $("#dock").getBoundingClientRect().height;
  const room = innerHeight - dock - list.getBoundingClientRect().top - 12;
  list.style.maxHeight = Math.max(240, room) + "px";
  updateListPos(node);
}
function updateListPos(node) {
  const list = node.querySelector(".scroll-list"), pos = node.querySelectorAll(".more-pos");
  if (!list || !pos.length) return;
  const offset = list.classList.contains("tracks") ? 1 : 0; // a track thread's main post is number 1
  const rows = [...list.children].filter((r) => r.matches("li.track")), top = list.scrollTop, bottom = top + list.clientHeight;
  let first = 0, last = 0;
  rows.forEach((r, k) => { if (r.offsetTop + r.offsetHeight > top && !first) first = k + 1; if (r.offsetTop < bottom) last = k + 1; });
  const total = rows.length + offset;
  const text = `${offset && top < 4 ? 1 : (first || 1) + offset}–${last + offset} of ${total}`;
  pos.forEach((p) => (p.textContent = text));
}
addEventListener("resize", () => {
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
  document.querySelectorAll(".scroll-list").forEach((l) => fitList(l.closest(".thread")));
});
document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");

/* A tag: its name, track count, Expand and counter on the left, the newest tagged tracks on the right,
   all inside one frame. */
function tagThreadNode({ t, hits }) {
  const open = expanded.has(t.id), n = t.tracks.length, many = n > TAG_PREVIEW;
  // on a laptop every track is in the list (5 visible, scroll for more); on a phone only 5 until Expand
  const all = open || !phone();
  const rows = (all ? t.tracks : t.tracks.slice(0, TAG_PREVIEW)).map((tr, i) => trackRow(t, tr, i, hits));
  const scrolls = many && all;
  const list = el("ol", { class: "tag-list" + (scrolls ? " scroll-list" : "") + (open ? " open" : ""), "data-show": TAG_PREVIEW }, rows);
  const pos = () => el("span", { class: "more-pos" }, `1–${Math.min(n, TAG_PREVIEW)} of ${n}`);
  const node = el("li", { class: "thread tag-thread" + (open ? " expanded" : ""), id: "th-" + t.id },
    el("div", { class: "tag-frame" },
      el("div", { class: "tag-side" },
        el("div", { class: "tag-label" },
          el("span", { class: "tag-name" }, t.name),
          el("span", { class: "tag-count" }, `${n} ${n === 1 ? "track" : "tracks"}`),
          many ? pos() : null),
        many ? el("div", { class: "tag-more" }, btn("", open ? "Collapse" : "Expand", () => toggleExpand(t, hits)), pos()) : null,
        many && open ? btn("tag-collapse-bottom", "Collapse", () => toggleExpand(t, hits)) : null),
      list));
  if (scrolls) {
    list.addEventListener("scroll", () => updateListPos(node), { passive: true });
    requestAnimationFrame(() => fitList(node));
  }
  return node;
}

function threadNode({ t, hits }) {
  if (t.kind === "tag") return tagThreadNode({ t, hits });
  const n = t.tracks.length, limit = threadLimit();
  const long = n > limit, open = long && expanded.has(t.id);
  const firstHit = hits ? [...hits].sort((x, y) => x - y).find((i) => i > 0) : undefined;
  const searching = !!hits && !open && n - 1 > SEARCH_AROUND; // show the hit with 2 tracks above and below
  const scrolling = searching && scrollOn.has(t.id);
  let from = 1, to = n, list = null, listCls = "tracks", show = limit - 1;
  if (open) { listCls += " scroll-list open"; }
  else if (searching && !scrolling) {
    const h = firstHit || 1;
    from = Math.max(1, Math.min(h - 2, n - SEARCH_AROUND)); to = from + SEARCH_AROUND;
  } else if (scrolling) { listCls += " scroll-list"; show = SEARCH_AROUND; }
  else if (long && !phone()) { listCls += " scroll-list"; }
  else if (long) { to = limit; }
  const controls = long || searching;
  const head = t.tracks[0], hi = info(head);
  const posText = `${from === 1 ? 1 : from + 1}–${Math.min(n, to)} of ${n}`;
  const buttons = (where) => [
    (where === "top" || !open) ? btn("tg-expand", open ? "Collapse" : "Expand", () => toggleExpand(t, hits)) : null,
    searching ? btn("tg-scroll" + (scrolling ? " on" : ""), scrolling ? "Stop" : "Scroll", () => toggleScroll(t, hits)) : null,
  ];
  const li = el("li", { class: "thread" + (controls ? " long" : "") + (open ? " expanded" : "") + (searching ? " searching" : ""), id: "th-" + t.id },
    el("div", { class: ["head-row", hi.dead && "dead", hits && hits.has(0) && "hit"].filter(Boolean).join(" "), "data-k": `${t.id}:0` },
      el("button", { class: "thread-head", onclick: () => play(t, 0), "aria-label": `Play ${hi.title}` },
        el("span", { class: "thumb" }, img(hi.thumb, "thumb-img"), hi.thumb ? null : el("span", { class: "ph" }, PLATFORM[head.platform] || "")),
        el("span", { class: "thread-main" },
          el("span", { class: "t-title" }, hi.title),
          el("span", { class: "t-sub t-tags" }, tagLine(head)),
          el("span", { class: "t-sub t-date" }, [fmtDay(head.date), hi.recovered ? RECOVERED : null].filter(Boolean).join(" · ")))),
      el("span", { class: "head-side" }, rowLinks(t, 0, hi))),
    controls ? el("div", { class: "thread-more" },
      el("div", { class: "more-info" }, el("span", { class: "more-title" }, hi.title), el("span", { class: "more-pos" }, posText)),
      el("div", { class: "more-btns" }, buttons("top")),
      // laptop: the same buttons again at the bottom of the left column
      (open || searching) ? el("div", { class: "more-btns more-bottom" }, open ? btn("", "Collapse", () => toggleExpand(t, hits)) : buttons("bottom")) : null) : null,
    n > 1 ? (list = el("ol", { class: listCls, "data-show": show }, t.tracks.slice(from, to).map((tr, k) => trackRow(t, tr, k + from, hits)))) : null,
    // phone: Expand (and Scroll) again under the list while collapsed
    controls && !open ? el("div", { class: "more-after" }, buttons("bottom")) : null,
    el("div", { class: "thread-foot" },
      el("button", { class: "linkbtn add-here", onclick: (e) => toggleAddForm(t, e.currentTarget.closest(".thread")) }, "Add a track here")));
  if (list && list.classList.contains("scroll-list")) {
    list.addEventListener("scroll", () => updateListPos(li), { passive: true });
    requestAnimationFrame(() => fitList(li));
  }
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
/* autoplay goes to the next track that can play, skipping deleted links and ones that only play on YouTube */
function playable(tr) { const x = info(tr); return !x.dead && !x.noEmbed; }
function autoNext() {
  if (!autoplay || !playing) return;
  const { thread: t, index: i } = playing;
  for (let k = i + 1; k < t.tracks.length; k++) if (playable(t.tracks[k])) { play(t, k); return; }
}
function onEnded() { setPlayState(false); autoNext(); }
function onError() { setPlayState(false); autoNext(); }
const events = { state: setPlayState, time: setTime, ended: onEnded, error: onError };

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
        onError: () => { if (yt.active) events.error(); },
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
      if (E.ERROR) w.bind(E.ERROR, () => events.error());
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
      p.on("error", () => events.error());
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
  fitTitle();
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
    kind = "bandcamp"; // Bandcamp's player is 120px high
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

/* "Artist – Title" for the playing track. YouTube titles often lack the artist when the
   uploader is the artist's own channel ("Randy Newman - Topic", "SomeoneVEVO"), so add it then. */
function fullInfo(tr) {
  return info(tr).title; // info() already puts the artist in front for artist channels
}
$("#infoBtn").onclick = (e) => { if (playing) copyText(fullInfo(playing.thread.tracks[playing.index]), e.currentTarget, "Copied"); };

/* phone: shrink the player title so long names fit on one line (down to 11px, then "…") */
const narrow = window.matchMedia("(max-width: 640px)");
function fitTitle() {
  const n = $("#nowTitle");
  n.style.fontSize = "";
  if (!narrow.matches || $("#dock").hidden) return;
  let size = 16;
  while (n.scrollWidth > n.clientWidth && size > 11) { size -= 0.5; n.style.fontSize = size + "px"; }
}
window.addEventListener("resize", fitTitle);

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
function closeDock() {
  try { adapter && adapter.pause(); } catch {}
  if (adapter) adapter.destroy();
  adapter = null;
  $("#otherSlot").replaceChildren();
  playing = null;
  setPlayState(false);
  $("#dock").hidden = true;
  markPlaying();
  syncDockSpace();
}
$("#closeBtn").onclick = closeDock;

function syncDockSpace() {
  const d = $("#dock");
  document.body.style.setProperty("--dock-h", d.hidden ? "0px" : d.offsetHeight + "px");
}
new ResizeObserver(syncDockSpace).observe($("#dock"));

/* ---------- add track: saved straight to the repository with a key stored on this device ----------
   The key is a GitHub fine-grained token limited to this one repository (Contents: read & write).
   It lives in this browser's storage for this site only. Without it, adding is hidden. */
const TOKEN_KEY = "nrgfm-token";
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
function updateCanAdd() { document.body.classList.toggle("can-add", !!getToken()); }
updateCanAdd();

async function gh(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${opts.token || getToken()}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  return r;
}

/* setup screen: open the site with #setup in the address */
function openSetup() {
  $("#tokenInput").value = "";
  $("#setupMsg").textContent = getToken() ? "A key is saved on this device." : "No key saved on this device yet.";
  $("#tokenRemove").hidden = !getToken();
  $("#setupDlg").showModal();
}
$("#setupForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const token = $("#tokenInput").value.trim();
  if (!token) return;
  $("#setupMsg").textContent = "Checking the key…";
  try {
    const r = await gh("", { token });
    const j = r.ok ? await r.json() : null;
    if (!r.ok) throw new Error(r.status === 401 ? "GitHub doesn't accept this key. Check that you copied all of it." : `GitHub answered ${r.status}. Check the key has access to the nrgfm repository.`);
    if (!j.permissions || !j.permissions.push) throw new Error("This key can read the repository but not save to it. Give it Contents: Read and write.");
    try { localStorage.setItem(TOKEN_KEY, token); } catch { throw new Error("This browser won't store the key (private window?)."); }
    updateCanAdd();
    $("#setupMsg").textContent = "Saved on this device. You can now add tracks.";
    $("#tokenRemove").hidden = false;
    $("#tokenInput").value = "";
  } catch (e) {
    $("#setupMsg").textContent = e.message;
  }
});
$("#tokenRemove").onclick = () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  updateCanAdd();
  $("#setupMsg").textContent = "Key removed from this device.";
  $("#tokenRemove").hidden = true;
};
$("#setupClose").onclick = () => { $("#setupDlg").close(); history.replaceState(null, "", location.pathname); };
function checkSetupHash() { if (location.hash === "#setup") openSetup(); }
window.addEventListener("hashchange", checkSetupHash);

/* Inline add form: under the header for a new thread, under a thread's footer for a reply.
   Title first, then link. Saving writes inbox/<time>.json straight to the repository. */
const toBase64 = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str)));
const LINK_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|soundcloud\.com|[\w-]+\.bandcamp\.com|bandcamp\.com|vimeo\.com|mixcloud\.com|open\.spotify\.com)\//i;

/* Tag field: type, pick a suggestion with Enter (or the arrow keys), keep typing the next one.
   Chosen tags show as chips; clicking a chip removes it. */
function tagEditor(initial, suggested = []) {
  const chosen = [...initial];
  const input = el("input", { type: "text", class: "tag-input", placeholder: "Add tag", autocomplete: "off", spellcheck: "false", "aria-label": "Add tag" });
  const drop = el("ul", { class: "tag-drop", hidden: true });
  const chips = el("span", { class: "tag-chips" });
  let opts = [], active = 0;
  const drawChips = () => chips.replaceChildren(
    ...chosen.map((g) => el("button", { type: "button", class: "tag-chip", title: "Remove tag", onclick: () => { chosen.splice(chosen.indexOf(g), 1); drawChips(); input.focus(); } }, g, el("span", { "aria-hidden": "true" }, " ×"))),
    // the main track's tags, offered with a dotted outline; click to use one
    ...suggested.filter((g) => !chosen.includes(g)).map((g) => el("button", { type: "button", class: "tag-chip suggest", title: "Use this tag", onclick: () => { chosen.push(g); drawChips(); } }, "+ " + g)));
  const drawDrop = () => {
    const q = fold(input.value);
    opts = q ? allTags().filter((g) => !chosen.includes(g) && fold(g).includes(q)).sort((a, b) => fold(b).startsWith(q) - fold(a).startsWith(q)).slice(0, 6) : [];
    active = 0;
    drop.hidden = !opts.length;
    drop.replaceChildren(...opts.map((g, k) => el("li", { class: k === active ? "on" : "", onmousedown: (e) => { e.preventDefault(); add(g); } }, g)));
  };
  const add = (g) => { g = normTag(g); if (g && !chosen.includes(g)) chosen.push(g); input.value = ""; drawDrop(); drawChips(); input.focus(); };
  input.addEventListener("input", drawDrop);
  input.addEventListener("blur", () => setTimeout(() => (drop.hidden = true), 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || (e.key === "," && input.value.trim())) {
      e.preventDefault();
      if (!drop.hidden && opts[active]) add(opts[active]); else if (input.value.trim()) add(input.value);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (drop.hidden) return; e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      [...drop.children].forEach((li, k) => li.classList.toggle("on", k === active));
    } else if (e.key === "Escape" && !drop.hidden) { e.stopPropagation(); drop.hidden = true; }
    else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); drawChips(); }
  });
  drawChips();
  return { box: el("span", { class: "tag-box" }, input, drop), chips, get: () => [...chosen] };
}

function addForm(thread, edit) {
  // edit = { t, i } when editing an existing track
  const tr = edit ? edit.t.tracks[edit.i] : null;
  const tags = tagEditor(tr ? Object.keys(tr.tags || {}) : [], !tr && thread ? Object.keys(thread.tracks[0].tags || {}) : []);
  const form = el("form", { class: "add-form" + (edit ? " edit-form" : ""), autocomplete: "off" },
    el("label", { class: "af-field" }, el("span", {}, "Title"),
      el("input", { name: "title", type: "text", placeholder: "Artist – Track (optional, filled in automatically)" })),
    el("label", { class: "af-field" }, el("span", {}, "Link"),
      el("input", { name: "url", type: "url", required: true, placeholder: "YouTube, SoundCloud, Bandcamp or Vimeo link" })),
    el("div", { class: "af-actions" },
      tags.box,
      el("span", { class: "af-msg hint", role: "status" }),
      tags.chips,
      edit ? el("button", { type: "button", class: "btn ghost danger", onclick: (e) => deleteTrack(form, edit, e.currentTarget) }, "Delete") : null,
      edit ? el("button", { type: "button", class: "btn ghost move-btn", "aria-expanded": "false", onclick: (e) => toggleMovePanel(form, edit, e.currentTarget) }, "Move") : null,
      el("button", { type: "submit", class: "btn" }, "Save")));
  if (tr) { form.title.value = tr.title || info(tr).title; form.url.value = tr.url; }
  form.url.addEventListener("input", () => form.url.setCustomValidity(""));
  form.tags = tags;
  form.addEventListener("submit", (ev) => { ev.preventDefault(); edit ? saveEdit(form, edit) : saveTrack(form, thread); });
  form.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeAddForm(form); });
  return form;
}
function closeAddForm(form) {
  if (!form) return;
  if (form.parentElement && form.parentElement.classList.contains("edit-li")) { const th = form.closest(".thread"); form.parentElement.remove(); fitList(th); return; }
  if (form.parentElement && form.parentElement.id === "addPanel") { $("#addPanel").hidden = true; $("#addBtn").setAttribute("aria-expanded", "false"); }
  form.remove();
}
function openAdd(thread) {
  if (!getToken()) { openSetup(); return; }
  if (thread) toggleAddForm(thread, document.getElementById("th-" + thread.id));
  else toggleHeaderForm();
}
function toggleHeaderForm() {
  if (!getToken()) { openSetup(); return; }
  const panel = $("#addPanel");
  if (!panel.hidden) { closeAddForm(panel.querySelector("form")); return; }
  panel.replaceChildren(addForm(null));
  panel.hidden = false; $("#addBtn").setAttribute("aria-expanded", "true");
  panel.querySelector("input").focus();
}
function toggleAddForm(thread, li) {
  if (!getToken()) { openSetup(); return; }
  if (!li) return;
  const open = li.querySelector(".add-form");
  if (open) { closeAddForm(open); return; }
  const form = addForm(thread);
  li.querySelector(".thread-foot").after(form);
  form.querySelector("input").focus();
}
$("#addBtn").onclick = toggleHeaderForm;

function toggleEditForm(t, i, row) {
  if (!getToken()) { openSetup(); return; }
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) { next.remove(); fitList(row.closest(".thread")); return; }
  if (t.kind === "tag") { // the track lives in its own thread; edit it there
    const tr = t.tracks[i], home = threads.find((x) => x.kind !== "tag" && x.tracks.includes(tr));
    if (!home) return;
    t = home; i = home.tracks.indexOf(tr);
  }
  const form = addForm(null, { t, i });
  const wrap = el(row.tagName === "LI" ? "li" : "div", { class: "edit-wrap edit-li" }, form);
  row.after(wrap);
  const box = wrap.closest(".scroll-list"); // inside a scrolling box: make room for the card
  if (box) { box.style.maxHeight = box.clientHeight + wrap.offsetHeight + "px"; wrap.scrollIntoView({ block: "nearest" }); }
  form.title.focus(); form.title.select();
}

async function writeInbox(item, kind) {
  const name = `${Date.now()}${kind ? "-" + kind : ""}.json`;
  const r = await gh(`/contents/inbox/${name}`, {
    method: "PUT",
    body: JSON.stringify({ message: kind ? `${kind[0].toUpperCase() + kind.slice(1)} track` : "Add track", content: toBase64(JSON.stringify(item, null, 2) + "\n") }),
  });
  if (!r.ok) {
    if (r.status === 401) throw new Error("The saved key no longer works (expired or deleted). Open the site with #setup and paste a new one.");
    throw new Error(`GitHub answered ${r.status}. Nothing was saved; try again.`);
  }
}
const netMsg = (e) => (e.message === "Failed to fetch" ? "No connection to GitHub. Nothing was saved; try again." : e.message);

function parseLocal(url) {
  const yt = (url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/) || [])[1];
  const host = new URL(url).hostname;
  const platform = yt ? "youtube" : /soundcloud/.test(host) ? "soundcloud" : /bandcamp/.test(host) ? "bandcamp" : /vimeo/.test(host) ? "vimeo" : /mixcloud/.test(host) ? "mixcloud" : "link";
  const vimeo = (url.match(/vimeo\.com\/(\d+)/) || [])[1];
  return { platform, url: yt ? `https://www.youtube.com/watch?v=${yt}` : url, yt, vimeo };
}
function rerenderThread(t, flashIndex) {
  const old = document.getElementById("th-" + t.id);
  if (!old) return;
  if (!t.tracks.length) { old.remove(); return; }
  const node = threadNode({ t, hits: null });
  old.replaceWith(node);
  markPlaying();
  if (flashIndex != null) {
    const row = node.querySelector(`[data-k="${t.id}:${flashIndex}"]`);
    if (row) { row.classList.add("just-saved"); setTimeout(() => row.classList.remove("just-saved"), 3000); }
  }
}

async function saveEdit(form, { t, i }) {
  const tr = t.tracks[i];
  const url = form.url.value.trim(), title = form.title.value.trim();
  if (!LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a YouTube, SoundCloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const item = { action: "edit", thread: t.id, id: tr.id, title, url, tags: form.tags.get(), ts: Math.floor(Date.now() / 1000) };
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Saving…";
  try { await writeInbox(item, "edit"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  // apply on screen right away
  if (url !== tr.url) { const p = parseLocal(url); delete tr.yt; delete tr.vimeo; Object.assign(tr, p); if (!p.yt) delete tr.yt; if (!p.vimeo) delete tr.vimeo; }
  if (title) tr.title = title; else delete tr.title;
  applyTags(tr, item.tags, item.ts);
  tr._hay = null;
  rerenderThread(t, i);
  refreshTags();
}
function applyTags(tr, list, ts) {
  const old = tr.tags || {}, nu = {};
  for (const g of list) nu[g] = old[g] || ts;
  if (Object.keys(nu).length) tr.tags = nu; else delete tr.tags;
}

/* ---------- move a track to another thread ---------- */
const threadLabel = (t) => t.name || info(t.tracks[0]).title;

function toggleMovePanel(form, edit, btn) {
  const open = form.querySelector(".move-panel");
  if (open) { open.remove(); btn.setAttribute("aria-expanded", "false"); return; }
  btn.setAttribute("aria-expanded", "true");
  const input = el("input", { type: "search", placeholder: "Search a track in the thread you want to move it to", autocomplete: "off", spellcheck: "false" });
  const list = el("ul", { class: "move-results" });
  const panel = el("div", { class: "move-panel" }, el("label", { class: "af-field" }, el("span", {}, "Move to the thread of…"), input), list);
  form.appendChild(panel);
  input.focus();
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("button"); if (first) first.click(); } });
  input.addEventListener("input", () => {
    const terms = fold(input.value).split(" ").filter(Boolean);
    list.replaceChildren();
    if (!terms.length) return;
    const found = [];
    for (const t of threads) {
      if (t === edit.t || t.kind === "tag") continue;
      const byName = t.name && terms.every((w) => fold(t.name).includes(w));
      const k = byName ? 0 : t.tracks.findIndex((tr) => { const h = haystack(tr); return terms.every((w) => h.includes(w)); });
      if (k > -1) found.push({ t, k });
      if (found.length >= 8) break;
    }
    if (!found.length) { list.appendChild(el("li", { class: "move-none hint" }, "No other thread has a track like that.")); return; }
    for (const { t, k } of found) {
      const x = info(t.tracks[k]);
      list.appendChild(el("li", {},
        el("button", { type: "button", class: "move-hit", onclick: () => moveTrack(form, edit, t) },
          el("span", { class: "mh-thumb" }, img(x.thumb, "thumb-img")),
          el("span", { class: "mh-text" },
            el("span", { class: "mh-title" }, x.title),
            el("span", { class: "mh-thread" }, "Thread: " + threadLabel(t) + ` (${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"})`)))));
    }
  });
}

async function moveTrack(form, { t, i }, dest) {
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Moving…";
  try { await writeInbox({ action: "move", thread: t.id, id: tr.id, to: dest.id, ts: Math.floor(Date.now() / 1000) }, "move"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (playing && playing.thread === t) playing = null;
  t.tracks.splice(i, 1);
  t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  delete tr.main;
  dest.tracks.push(tr);
  dest.tracks.sort((a, b) => a.ts - b.ts);
  dest.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  if (!t.tracks.length) { threads.splice(threads.indexOf(t), 1); shown = shown.filter((x) => x.t !== t); }
  rerenderThread(t, null);
  rerenderThread(dest, dest.tracks.indexOf(tr));
  refreshTags();
  // say where it went, on the spot where the track was
  const src = document.getElementById("th-" + t.id);
  if (src) {
    const note = el("p", { class: "moved-note" }, "Moved to: ", el("a", { href: "#th-" + dest.id, onclick: (e) => { e.preventDefault(); const n = document.getElementById("th-" + dest.id); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); else { history.replaceState(null, "", `#t/${dest.id}`); threads.unshift(threads.splice(threads.indexOf(dest), 1)[0]); runSearch(); scrollTo(0, 0); } } }, threadLabel(dest)));
    src.querySelector(".thread-foot").before(note);
    setTimeout(() => note.remove(), 8000);
  }
}

async function deleteTrack(form, { t, i }, btn) {
  if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "Click again to delete"; return; }
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Deleting…";
  try { await writeInbox({ action: "delete", thread: t.id, id: tr.id, ts: Math.floor(Date.now() / 1000) }, "delete"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (playing && playing.thread === t && playing.index === i) playing = null;
  t.tracks.splice(i, 1);
  if (t.tracks[0]) t.tracks[0].main = true;
  if (!t.tracks.length) { threads.splice(threads.indexOf(t), 1); shown = shown.filter((x) => x.t !== t); }
  rerenderThread(t, null);
  if (tr.tags) refreshTags();
}

async function saveTrack(form, thread) {
  const url = form.url.value.trim();
  if (!LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a YouTube, SoundCloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const ts = Math.floor(Date.now() / 1000);
  const item = { url, title: form.title.value.trim(), thread: thread ? thread.id : "", tags: form.tags.get(), ts };
  const msg = form.querySelector(".af-msg"), btn = form.querySelector("button[type=submit]");
  btn.disabled = true; msg.textContent = "Saving…";
  try { await writeInbox(item, ""); }
  catch (e) { msg.textContent = netMsg(e); btn.disabled = false; return; }
  closeAddForm(form);
  showLocally(item);
}

/* show the new track right away; the full title and thumbnail arrive with the next site update */
function showLocally(item) {
  const yt = (item.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1];
  const host = new URL(item.url).hostname;
  const platform = yt ? "youtube" : /soundcloud/.test(host) ? "soundcloud" : /bandcamp/.test(host) ? "bandcamp" : /vimeo/.test(host) ? "vimeo" : /mixcloud/.test(host) ? "mixcloud" : "link";
  const tr = { id: `t${item.ts}_0`, date: new Date(item.ts * 1000).toISOString().slice(0, 10), ts: item.ts, platform, url: item.url };
  if (yt) tr.yt = yt;
  if (item.title) tr.title = item.title;
  if (item.tags && item.tags.length) applyTags(tr, item.tags, item.ts);
  let th = item.thread && threads.find((x) => x.id === item.thread);
  if (th) th.tracks.push(tr);
  else { tr.main = true; th = { id: `p${item.ts}`, date: tr.date, ts: item.ts, kind: "thread", tracks: [tr] }; threads.unshift(th); }
  // update only what changed, so the page doesn't jump
  const old = document.getElementById("th-" + th.id);
  const node = threadNode({ t: th, hits: null });
  if (old) old.replaceWith(node);
  else if (!$("#q").value.trim()) { $("#threads").prepend(node); rendered++; shown.unshift({ t: th, hits: null }); }
  markPlaying();
  const row = node.querySelector(`[data-k="${th.id}:${th.tracks.length - 1}"]`);
  if (row) {
    row.classList.add("just-saved");
    row.querySelector(".tr-sub, .t-sub")?.prepend(el("span", { class: "saved-tag" }, "Saved"));
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => row.classList.remove("just-saved"), 4000);
  }
  if (item.tags && item.tags.length) refreshTags();
}


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
function syncClear() { $("#clearQ").hidden = !$("#q").value; }
$("#q").addEventListener("input", () => { syncClear(); clearTimeout(timer); timer = setTimeout(runSearch, 150); });
$("#clearQ").onclick = () => { $("#q").value = ""; syncClear(); runSearch(); if (phone()) $("#q").blur(); else $("#q").focus(); };
// phones: Enter, or touching anywhere outside the search field, puts the keyboard away
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); runSearch(); $("#q").blur(); } });
document.addEventListener("touchstart", (e) => { if (document.activeElement === $("#q") && !e.target.closest(".search")) $("#q").blur(); }, { passive: true });
$("#home").onclick = (e) => { e.preventDefault(); $("#q").value = ""; syncClear(); history.replaceState(null, "", location.pathname); runSearch(); scrollTo(0, 0); };

(async function boot() {
  try {
    const [d, m] = await Promise.all([
      fetch("data/tracks.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    threads = d.threads; meta = m;
    threads.push(...makeTagThreads());
    sortThreads();
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
  checkSetupHash();
})();
