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

let threads = [], meta = {}, extra = {}, shown = [], rendered = 0, query = "";
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
    const m = meta[t.url] || {}, x = extra[t.url] || {};
    // notes and looked-up info count too (the full descriptions don't)
    t._hay = fold([t.title, m.title, m.author_name, channelArtist(m.author_name), m.wb_title, m.wb_author, slugTitle(t),
      t.notes, (x.g || []).join(" "), x.y, (x.ys || []).join(" "), (x.rl || []).join(" "), x.by, x.up,
      t.date, fmtDay(t.date), t.shown_date && fmtDay(t.shown_date)].filter(Boolean).join(" "));
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
  if (t.pos_ts) { // the main post's date was set by hand: only tracks added after that lift the thread
    let a = t.pos_ts;
    for (const x of t.tracks) if (x.ts > (t.pos_set || 0) && x.ts > a) a = x.ts;
    return a;
  }
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
    threads.unshift(t); // a new tag shows up at the top (of the Tags page)
    if (!$("#q").value.trim() && view === "tags") {
      const node = threadNode({ t, hits: null });
      $("#threads").prepend(node);
      shown.unshift({ t, hits: null }); rendered++;
    }
  }
  // Mixes and Genres: re-draw the playlists on screen
  if ((view === "mixes" || view === "genres") && !$("#q").value.trim()) {
    const items = new Map(viewItems().map((t) => [t.id, t]));
    shown.forEach((x) => {
      const nt = items.get(x.t.id), node = document.getElementById("th-" + x.t.id);
      if (playing && playing.thread === x.t && nt) playing.thread = nt;
      if (nt) { x.t = nt; if (node) node.replaceWith(threadNode({ t: nt, hits: null })); } else if (node) node.remove();
    });
  }
  markPlaying();
}

/* ---------- search ---------- */
function runSearch() {
  query = fold($("#q").value);
  fixedRows.clear(); scrollOn.clear(); keptHeight.clear(); expanded.clear(); activeId = null;
  const terms = query.split(" ").filter(Boolean);
  $("#viewHead").hidden = true;
  if (!terms.length) {
    shown = viewItems().map((t) => ({ t, hits: null }));
    $("#resultInfo").hidden = true;
    drawViewHead();
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
    shown.sort((x, y) => (y.tag ? 1 : 0) - (x.tag ? 1 : 0) || activity(y.t) - activity(x.t)); // tags first, then like the feed
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
  if (terms.length) pageScrollTo(0); // results start at the top, wherever you were in the feed
  renderMore();
}

/* ---------- pages: Threads, Tags, Mixes, Genres, History (and Random) ----------
   The logo opens the menu. Search always looks through everything; clearing it returns to the page you were on. */
let view = "threads";
const VIEW_NAMES = { threads: "Threads", tags: "Tags", mixes: "Mixes", genres: "Genres", history: "History" };
const slug = (g) => fold(g).replace(/ /g, "-");
const newestFirst = (a, b) => b.ts - a.ts;
function viewItems() {
  if (view === "tags") return threads.filter((t) => t.kind === "tag").sort((a, b) => b.last - a.last);
  if (view === "mixes") return mixThreads();
  if (view === "genres") return genreThreads();
  if (view === "history") return historyMonths();
  return threads.filter(isBase);
}
const baseTracks = () => threads.filter(isBase).flatMap((t) => t.tracks);
const playlist = (id, name, tracks, note) => ({ id, name, note, kind: "tag", tracks, last: Math.max(0, ...tracks.map((x) => x.ts)) });
/* Mixes: every track ticked as a mix ("mix" tag). First all of them, then one box per other tag the mixes
   have (a mix tagged "techno" shows up under techno too), the biggest groups first. */
function mixThreads() {
  const mixes = baseTracks().filter((tr) => tr.tags && tr.tags.mix).sort(newestFirst);
  if (!mixes.length) return [];
  const by = new Map();
  for (const tr of mixes) for (const g of Object.keys(tr.tags)) if (g !== "mix") (by.get(g) || by.set(g, []).get(g)).push(tr);
  return [playlist("mix-all", "all mixes", mixes),
    ...[...by].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([g, list]) => playlist("mix-" + slug(g), g, list))];
}
/* Genres: the suggested genres found by the lookups (MusicBrainz, Discogs, descriptions), one playlist each,
   the biggest first; genres with fewer than 3 tracks are left out. */
const GENRE_MIN = 3;
function genreThreads() {
  const by = new Map();
  for (const tr of baseTracks()) for (const g of (extra[tr.url] || {}).g || []) (by.get(g) || by.set(g, []).get(g)).push(tr);
  return [...by].filter(([, l]) => l.length >= GENRE_MIN)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([g, list]) => playlist("genre-" + slug(g), g, [...new Set(list)].sort(newestFirst)));
}
/* History: every thread by the month it was posted, newest first, as short rows */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const postDate = (t) => t.tracks[0].shown_date || t.tracks[0].date || "";
function historyMonths() {
  const by = new Map();
  for (const t of threads.filter(isBase)) { const m = postDate(t).slice(0, 7); if (m) (by.get(m) || by.set(m, []).get(m)).push(t); }
  return [...by].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([m, list]) => ({
    id: "m-" + m, kind: "month", month: m, threads: list.sort((a, b) => (postDate(a) < postDate(b) ? 1 : -1)) }));
}
function monthNode({ t }) {
  const [y, mo] = t.month.split("-");
  return el("li", { class: "month", id: "th-" + t.id },
    el("h2", { class: "month-name" }, `${MONTHS[+mo - 1]} ${y}`, el("span", { class: "month-count" }, ` · ${t.threads.length} ${t.threads.length === 1 ? "post" : "posts"}`)),
    el("ol", { class: "month-list" }, t.threads.map((th) => {
      const x = info(th.tracks[0]), n = th.tracks.length;
      return el("li", { class: "month-row" + (x.dead ? " dead" : ""), "data-k": `${th.id}:0` },
        el("button", { class: "when-link", title: "Go to the thread (" + fmtDay(postDate(th)) + ")", onclick: () => goToThread(th) }, fmtDay(postDate(th)).replace(/ \d{4}$/, "")),
        el("button", { class: "play month-play", onclick: () => play(th, 0), "aria-label": `Play ${x.title}` }, el("span", { class: "tr-title" }, x.title)),
        n > 1 ? el("button", { class: "when-link month-n", "aria-expanded": "false", title: "Show the tracks",
          onclick: (e) => { const box = e.currentTarget.parentElement.querySelector(".month-tracks"), open = box.hidden;
            box.hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open)); } }, `${n} tracks`) : el("span", { class: "month-n" }),
        n > 1 ? el("ol", { class: "month-tracks", hidden: true }, th.tracks.slice(1).map((tr, k) => {
          const y = info(tr);
          return el("li", { class: y.dead ? "dead" : "", "data-k": `${th.id}:${k + 1}` },
            el("button", { class: "play month-play", onclick: () => play(th, k + 1), "aria-label": `Play ${y.title}` }, el("span", { class: "tr-title" }, y.title)));
        })) : null);
    })));
}
/* the genre index: the biggest 40, "all 263 genres" shows the rest */
function genreIndex(items, limit) {
  const box = el("div", { class: "genre-index" },
    items.slice(0, limit).map((g) => el("button", { class: "when-link", onclick: () => jumpTo(g.id) }, g.name, el("span", { class: "gi-n" }, g.tracks.length))),
    items.length > limit ? el("button", { class: "more-toggle gi-all", onclick: () => box.replaceWith(genreIndex(items, Infinity)) }, `all ${items.length} genres`) : null);
  return box;
}
function drawViewHead() {
  const head = $("#viewHead");
  head.className = "view-head view-" + view;
  if (view === "genres") {
    const items = shown.map((x) => x.t);
    head.replaceChildren(
      el("p", { class: "view-note" }, `${items.length} genres suggested by MusicBrainz, Discogs and video descriptions (at least ${GENRE_MIN} tracks each). Click one to jump to it.`),
      genreIndex(items, 40));
  } else if (view === "mixes") {
    head.replaceChildren(el("p", { class: "view-note" }, shown.length
      ? "Tracks ticked as Mix in the edit card, grouped by their other tags."
      : "No mixes yet. Tick “Mix” in a track's edit card and it shows up here."));
  } else if (view === "history") {
    const months = shown.map((x) => x.t), years = [...new Set(months.map((m) => m.month.slice(0, 4)))];
    const monthRow = el("div", { class: "hist-months" });
    const pickYear = (y) => {
      head.querySelectorAll(".hist-years .when-link").forEach((b) => b.classList.toggle("on", b.textContent === y));
      monthRow.replaceChildren(...MONTHS.map((name, k) => {
        const id = `m-${y}-${String(k + 1).padStart(2, "0")}`, has = months.some((m) => m.id === id);
        return el("button", { class: "when-link" + (has ? "" : " none"), disabled: !has, onclick: () => jumpTo(id) }, name.slice(0, 3));
      }));
    };
    head.replaceChildren(
      el("div", { class: "hist-years" }, years.map((y) => el("button", { class: "when-link", onclick: () => { pickYear(y); jumpTo(months.find((m) => m.month.startsWith(y)).id); } }, y))),
      monthRow);
    head._pickYear = pickYear;
    if (years.length) pickYear(years[0]);
  } else if (view === "tags") {
    head.replaceChildren(el("p", { class: "view-note" }, "Every tag as a playlist, the most recently tagged first."));
  } else { head.hidden = true; return; }
  head.hidden = false;
}
/* History: the year and month you are looking at light up while you scroll */
function watchHistory() { scroller().addEventListener("scroll", () => {
  if (view !== "history" || $("#q").value.trim()) return;
  const head = $("#viewHead"), top = head.getBoundingClientRect().bottom + 4;
  const all = [...document.querySelectorAll("#threads > .month")];
  const cur = all.filter((m) => m.getBoundingClientRect().top <= top + 12).pop() || all[0];
  if (!cur) return;
  const [, y, mo] = cur.id.match(/m-(\d{4})-(\d{2})/);
  if (!head.querySelector(`.hist-years .on`) || head.querySelector(".hist-years .on").textContent !== y) head._pickYear(y);
  head.querySelectorAll(".hist-months .when-link").forEach((b, k) => b.classList.toggle("on", k === +mo - 1));
}, { passive: true }); }
const contentTop = () => Math.max(headerBottom(), view === "history" && !$("#viewHead").hidden ? $("#viewHead").getBoundingClientRect().bottom : 0);
/* bring a thread, playlist or month on this page to the top */
function jumpTo(id) {
  const at = shown.findIndex((x) => x.t.id === id);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + id);
  if (!node) return;
  let frames = 0;
  const place = () => {
    const dy = node.getBoundingClientRect().top - contentTop() - 8;
    if (Math.abs(dy) > 1) pageScrollBy(dy);
    if (++frames < 30) requestAnimationFrame(place);
  };
  place();
}
function setView(v, keepHash) {
  if (v === "random") { const base = threads.filter(isBase); goToThread(base[Math.floor(Math.random() * base.length)]); return; }
  view = VIEW_NAMES[v] ? v : "threads";
  if (!keepHash) history.replaceState(null, "", view === "threads" ? location.pathname : "#/" + view);
  document.querySelectorAll("#menu button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view)));
  $("#q").value = ""; syncClear();
  runSearch(); pageScrollTo(0);
}
function toggleMenu(open = $("#menu").hidden) {
  $("#menu").hidden = !open; $("#home").setAttribute("aria-expanded", String(open));
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
}
addEventListener("hashchange", () => { // back/forward and links between pages
  const page = location.hash.match(/^#\/(\w+)/);
  if (page && VIEW_NAMES[page[1]] && page[1] !== view) setView(page[1], true);
  else if (!location.hash && view !== "threads") setView("threads", true);
});
$("#menu").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) { toggleMenu(false); setView(b.dataset.view); } });

/* ---------- rendering: every thread is shown open ---------- */
const img = (src, cls) => src
  ? el("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", onerror: (e) => e.target.classList.add("broken") })
  : el("span", { class: cls + " empty" });

/* tags under a title; clicking one searches for it */
function tagLine(tr, extra) {
  const tags = Object.keys(tr.tags || {});
  return [el("span", { class: "tag-wrap" }, tags.map((g) => el("span", { class: "tag" }, g))), extra ? el("span", { class: "sub-note" }, extra) : null];
}
function searchFor(text) { $("#q").value = text; syncClear(); runSearch(); pageScrollTo(0); }
const fmtDay = (d) => { const [y, mo, da] = (d || "").split("-"); return y ? `${+da} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]} ${y}` : ""; };
const RECOVERED = "title recovered from Internet Archive";

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
const threadLimit = () => (phone() ? 20 : 30); // tracks shown before Expand appears
const expanded = new Set();    // threads opened with Expand
const scrollOn = new Set();    // search results whose list was switched to scrolling
const fixedRows = new Map();   // phone: the window kept after playing from a scrolled result
const userToggled = new Set();

const phone = () => window.matchMedia("(max-width: 640px)").matches;
/* iPhone: the page scrolls inside the body instead of the window, so the browser's bars don't pop up and down */
const INNER_SCROLL = (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) && phone();
if (INNER_SCROLL) document.documentElement.classList.add("inner-scroll");
if (window.matchMedia("(max-width: 400px)").matches) $("#q").placeholder = "Artist, title or tag"; // small phones: it all fits
const scroller = () => (INNER_SCROLL ? document.body : window);
const pageScrollBy = (y, smooth) => scroller().scrollBy({ top: y, behavior: smooth ? "smooth" : "auto" });
const pageScrollTo = (y) => scroller().scrollTo({ top: y, behavior: "auto" });
/* bring an element fully into view (between the header and the player), moving as little as possible */
function revealWhole(node, smooth = true) {
  const r = node.getBoundingClientRect(), top = headerBottom() + 8;
  const bottom = innerHeight - ($("#dock").hidden ? 0 : $("#dock").getBoundingClientRect().height) - 8;
  let dy = 0;
  if (r.bottom > bottom) dy = r.bottom - bottom;
  if (r.top - dy < top) dy = r.top - top; // too tall: show its top
  if (dy) pageScrollBy(dy, smooth);
}
const headerBottom = () => $(".top").getBoundingClientRect().bottom;
const btn = (cls, label, fn) => el("button", { class: "more-toggle " + cls, onclick: fn }, label);

/* A box that scrolls inside the page only scrolls once its thread is selected: click anywhere in it, play one
   of its tracks or press Expand. Collapse unselects it. Until then the wheel scrolls the page. */
let activeId = null, addingId = null; // the selected thread; the thread with an open "Add a track here" card
function setActive(id, clickedK) {
  const before = activeId;
  activeId = id;
  document.querySelectorAll(".thread.active").forEach((n) => n.classList.remove("active"));
  if (id) document.getElementById("th-" + id)?.classList.add("active");
  // search results: unselected they show the hits grouped (padded to 5); selected, the whole thread in order
  for (const x of new Set([before, id])) {
    if (!x || !$("#q").value.trim()) continue;
    const entry = shown.find((e) => e.t.id === x && e.hits);
    const node = document.getElementById("th-" + x);
    if (!entry || !node || expanded.has(x)) continue;
    const old = node.querySelector(".tracks");
    if (x === id && old) keptHeight.set(x, old.getBoundingClientRect().height); // the box keeps its height
    const fresh = rerenderKeep(entry.t, entry.hits);
    if (fresh) fitList(fresh);
    const row = x === id && clickedK && fresh && fresh.querySelector(`.scroll-list [data-k="${CSS.escape(clickedK)}"]`);
    if (row) { const box = row.closest(".scroll-list"); if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop; }
  }
}
const selectable = (th) => th.querySelector(".scroll-list") || (th.classList.contains("searching") && th.querySelector(".tracks"));
document.addEventListener("click", (e) => {
  if (!e.target.closest || e.target.closest(".dock, .edit-btn, .add-form, .edit-wrap")) return; // the player and editing leave it as it is
  if (addingId) return; // adding a track: stays selected until the card closes
  const th = e.target.closest("#threads > .thread");
  if (th && th.classList.contains("active") && e.target.closest("button, a")) return; // playing, matches, links: stays selected
  const k = e.target.closest("[data-k]")?.dataset.k;
  if (th && selectable(th) && !th.classList.contains("active")) setActive(th.id.slice(3), k); // select (and unselect another)
  else if (activeId) setActive(null); // a click in the selected box or anywhere else unselects
}, true);
document.addEventListener("wheel", (e) => {
  // inside a selected box but not over its list (the name, the thumbnail, the counter): scroll the list anyway
  const sel = e.target.closest && e.target.closest(".thread.active");
  if (sel && !sel.querySelector(".edit-wrap") && !e.target.closest(".scroll-list, .add-form, .edit-wrap")) {
    const list = sel.querySelector(".scroll-list");
    if (list) { e.preventDefault(); list.scrollBy(0, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY); return; }
  }
  const box = e.target.closest && e.target.closest(".scroll-list");
  if (!box || box.closest(".thread").classList.contains("active") || box.querySelector(".edit-wrap")) return; // selected, or editing in it
  e.preventDefault();
  scroller().scrollBy(0, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY);
}, { passive: false });

function rerenderKeep(t, hits) {
  const node = document.getElementById("th-" + t.id);
  if (!node) return null;
  const fresh = threadNode({ t, hits });
  node.replaceWith(fresh);
  markPlaying();
  return fresh;
}
const keepDrawn = new Map();
function toggleExpand(t, hits) {
  userToggled.add(t.id);
  const wasOpen = expanded.has(t.id);
  const oldList = document.querySelector(`#th-${CSS.escape(t.id)} .scroll-list`), keep = oldList ? oldList.scrollTop : 0;
  if (oldList) keepDrawn.set(t.id, oldList.children.length); // playlists drawn in batches: draw as far again
  wasOpen ? expanded.delete(t.id) : expanded.add(t.id);
  const fresh = rerenderKeep(t, hits);
  if (!fresh) return;
  if (wasOpen) { setActive(null); pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8); } // collapsed: the thread at the top
  else setActive(t.id);
  fitList(fresh, !wasOpen);
  if (!wasOpen && hits && phone()) { // phone search: the whole thread, with the (first) hit at the top
    const hit = fresh.querySelector("li.track.hit, .head-row.hit");
    if (hit) pageScrollBy(hit.getBoundingClientRect().top - headerBottom() - 8);
    return;
  }
  if (!wasOpen && hits && t.tracks.length > threadLimit()) pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8); // long thread: at the top
  const list = fresh.querySelector(".scroll-list"); // carry on from where you were in the list
  if (list && keep) { list.scrollTop = keep; fresh.querySelector(".scroll-list").dataset.centred = "1"; updateListPos(fresh); }
}
const keptHeight = new Map(); // search results: Scroll keeps the box as tall as it was
/* "2 matches" in a selected result: the next match goes to the top of the box */
function nextMatch(node) {
  node = node && document.getElementById(node.id); // the first press re-draws the result (it gets selected)
  if (node) pageScrollBy(node.getBoundingClientRect().top - headerBottom() - 8, true); // the thread at the top
  const list = node && node.querySelector(".scroll-list");
  if (!list) return;
  const hs = [...list.querySelectorAll(":scope > li.track.hit")];
  const next = hs.find((h) => h.offsetTop > list.scrollTop + 2) || hs[0];
  if (next) list.scrollTo({ top: next.offsetTop, behavior: "smooth" });
}
function toggleScroll(t, hits) {
  setActive(t.id);
  const old = document.querySelector(`#th-${CSS.escape(t.id)} .tracks`);
  if (old && !scrollOn.has(t.id)) keptHeight.set(t.id, old.getBoundingClientRect().height);
  scrollOn.has(t.id) ? scrollOn.delete(t.id) : scrollOn.add(t.id);
  fixedRows.delete(t.id);
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
    const id = node.id.slice(3);
    if (keptHeight.has(id) && node.classList.contains("searching")) list.style.maxHeight = keptHeight.get(id) + "px";
    else if (last) list.style.maxHeight = last.offsetTop + last.offsetHeight + 4 + "px";
    const hitsIn = list.querySelectorAll(":scope > li.track.hit"), focus = hitsIn[0];
    if (focus && list.dataset.centred !== "1") { // search: one hit in the middle, several: the first at the top
      list.dataset.centred = "1";
      list.scrollTop = hitsIn.length > 1 ? focus.offsetTop : focus.offsetTop - (list.clientHeight - focus.offsetHeight) / 2;
    }
    updateListPos(node);
    return;
  }
  // open: the whole frame fits between the header and the bottom of the window (or the player), with the same
  // small gap above and below it
  const GAP = 8;
  const dock = $("#dock").hidden ? 0 : $("#dock").getBoundingClientRect().height;
  const below = () => node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; // Collapse, Add a track…
  const size = () => { list.style.maxHeight = Math.max(200, innerHeight - dock - GAP - list.getBoundingClientRect().top - below()) + "px"; };
  if (scroll) {
    const above = list.getBoundingClientRect().top - node.getBoundingClientRect().top;
    list.style.maxHeight = Math.max(200, innerHeight - dock - headerBottom() - 2 * GAP - above - below()) + "px";
    const room = INNER_SCROLL ? $("main") : document.body;
    room.style.minHeight = (INNER_SCROLL ? document.body.scrollHeight : document.documentElement.scrollHeight) + innerHeight + "px"; // room to scroll even near the end
    pageScrollBy(node.getBoundingClientRect().top - headerBottom() - GAP);
    size();
    room.style.minHeight = "";
    updateListPos(node);
    return;
  }
  size();
  updateListPos(node);
}
function updateListPos(node) {
  const list = node.querySelector(".scroll-list"), pos = node.querySelectorAll(".more-pos");
  if (!list || !pos.length) return;
  const offset = list.classList.contains("tracks") ? 1 : 0; // a track thread's main post is number 1
  const rows = [...list.children].filter((r) => r.matches("li.track")), top = list.scrollTop, bottom = top + list.clientHeight;
  let first = 0, last = 0;
  rows.forEach((r, k) => { if (r.offsetTop + r.offsetHeight > top && !first) first = k + 1; if (r.offsetTop < bottom) last = k + 1; });
  const total = +list.dataset.total || rows.length + offset;
  const text = `${offset && top < 4 ? 1 : (first || 1) + offset} of ${total}`;
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
  // big playlists (Genres) draw their rows a batch at a time while you scroll, so the page stays quick
  const BATCH = 50;
  let drawn = all ? Math.min(n, Math.max(BATCH, keepDrawn.get(t.id) || 0)) : Math.min(n, TAG_PREVIEW);
  const rows = t.tracks.slice(0, drawn).map((tr, i) => trackRow(t, tr, i, hits));
  const scrolls = many && all;
  const list = el("ol", { class: "tag-list" + (scrolls ? " scroll-list" : "") + (open ? " open" : ""), "data-show": TAG_PREVIEW, "data-total": n }, rows);
  if (all && drawn < n) list.addEventListener("scroll", () => {
    if (drawn >= n || list.scrollTop + list.clientHeight < list.scrollHeight - 400) return;
    const more = t.tracks.slice(drawn, drawn + BATCH).map((tr, k) => trackRow(t, tr, drawn + k, hits));
    drawn += more.length; list.append(...more); markPlaying();
  }, { passive: true });
  const pos = () => el("span", { class: "more-pos" }, `1 of ${n}`);
  const node = el("li", { class: "thread tag-thread framed" + (open ? " expanded" : "") + (t.id === activeId ? " active" : ""), id: "th-" + t.id },
    el("div", { class: "tag-frame" },
      el("div", { class: "tag-side" },
        el("div", { class: "tag-label" },
          el("span", { class: "tag-name" }, t.name),
          el("span", { class: "tag-count" }, `${n} ${n === 1 ? "track" : "tracks"}`),
          many ? pos() : null),
        many ? el("div", { class: "tag-more" }, pos(), btn("", open ? "Collapse" : "Expand", () => toggleExpand(t, hits))) : null),
      list));
  if (scrolls) {
    list.addEventListener("scroll", () => updateListPos(node), { passive: true });
    requestAnimationFrame(() => fitList(node));
  }
  return node;
}

/* Search results: the hits next to each other, padded with the tracks around them to 5 replies.
   More than 5 hits: all hits, no padding. Returns reply indices (1 = first reply). */
function searchRows(t, hits) {
  const n = t.tracks.length, found = [...hits].filter((i) => i > 0).sort((x, y) => x - y);
  if (found.length > SEARCH_AROUND) return found;
  if (!found.length) return range(1, Math.min(n, 1 + SEARCH_AROUND));
  // the hits plus the replies closest to them, up to 5 (one pass, no loop that could get stuck)
  const dist = (i) => Math.min(...found.map((h) => Math.abs(i - h)));
  return range(1, n)
    .sort((x, y) => dist(x) - dist(y) || x - y)
    .slice(0, Math.min(SEARCH_AROUND, n - 1))
    .sort((x, y) => x - y);
}
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

function threadNode({ t, hits }) {
  if (t.kind === "month") return monthNode({ t });
  if (t.kind === "tag") return tagThreadNode({ t, hits });
  const n = t.tracks.length, limit = threadLimit(), mobile = phone();
  const long = n > limit, open = expanded.has(t.id) && (long || !!hits);
  const searching = !!hits && !open && n - 1 > SEARCH_AROUND; // results: hits with a few tracks around them
  const scrolling = searching && activeId === t.id; // selected: the whole thread in a box that scrolls
  let idx, listCls = "tracks", show = long ? TAG_PREVIEW : limit - 1; // long threads show 5, like tags
  const addingHere = addingId === t.id && !hits && !long && n - 1 > TAG_PREVIEW; // adding a track here: 5 replies in a box
  if (addingHere) { idx = range(1, n); listCls += " scroll-list"; show = TAG_PREVIEW; }
  else if (open && hits && mobile) { idx = range(1, n); }                     // phone search: the whole thread
  else if (open && long) { idx = range(1, n); listCls += " scroll-list open"; } // fills the window, scrolls inside
  else if (open) { idx = range(1, n); }                                 // short thread: simply all of it
  else if (scrolling) { idx = range(1, n); listCls += " scroll-list"; show = SEARCH_AROUND; }
  else if (searching) { idx = searchRows(t, hits); }
  else if (searching) { idx = fixedRows.get(t.id) || searchRows(t, hits); }
  else if (long && !mobile) { idx = range(1, n); listCls += " scroll-list"; }
  else if (long) { idx = range(1, 1 + TAG_PREVIEW); }
  else { idx = range(1, n); }
  const head = t.tracks[0], hi = info(head);
  const lo = idx.length ? idx[0] + 1 : 1, hiIdx = idx.length ? idx[idx.length - 1] + 1 : 1;
  const posText = `${!searching || lo === 2 ? 1 : lo} of ${n}`;
  const pos = () => el("span", { class: "more-pos" }, posText);
  const expandBtn = (cls = "") => btn("tg-expand " + cls, open ? "Collapse" : "Expand", () => toggleExpand(t, hits));
  const day = fmtDay(head.shown_date || head.date);

  // what goes where
  let side = null, foot = null, after = null;
  // under the thumbnail: the post date; in search results it leads to the thread, with the track count under it
  const when = el("div", { class: "t-when" + (hits ? " in-search" : "") },
    hits ? el("button", { class: "when-link", title: "Show this thread in the feed", onclick: () => goToThread(t) }, day) : el("span", {}, day),
    // "4 matches": selects the result, then each press brings the next match to the top of its box
    hits && hits.size > 1 ? el("button", { class: "when-link", title: "Next match", onclick: (e) => nextMatch(e.currentTarget.closest(".thread")) }, `${hits.size} matches`) : null);
  if (hits && !mobile) {
    // laptop search: "175 tracks" under the tracks, centred, shows the whole thread (no Collapse)
    if (searching) foot = el("div", { class: "search-foot" }, el("span", {}),
      btn("tg-expand", `${n} ${n === 1 ? "track" : "tracks"}`, () => toggleExpand(t, hits)), el("span", {}));
    else if (open && long) foot = el("div", { class: "search-foot" }, el("span", {}), expandBtn(), el("span", {})); // long threads: Collapse
  } else if (hits && mobile) {
    // phone search: counter, Scroll and Expand under the tracks; Expand shows the whole thread (no Collapse)
    if (searching) foot = el("div", { class: "search-foot" }, pos(), el("span", {}), expandBtn("foot-right"));
  } else if (long) {
    side = el("div", { class: "thread-more" },
      el("div", { class: "more-info" }, el("span", { class: "more-title" }, hi.title), pos()),
      el("div", { class: "more-btns" }, expandBtn()));
    if (!open) after = el("div", { class: "more-after" }, pos(), expandBtn()); // phone: again under the list
  }
  const li = el("li", { class: "thread" + (side ? " long framed" : "") + (open ? " expanded" : "") + (hits ? " searching" : "") + (t.id === activeId ? " active" : ""), id: "th-" + t.id },
    el("div", { class: ["head-row", hi.dead && "dead", hits && hits.has(0) && "hit", ].filter(Boolean).join(" "), "data-k": `${t.id}:0` },
      el("button", { class: "thread-head", onclick: () => play(t, 0), "aria-label": `Play ${hi.title}` },
        el("span", { class: "thumb" }, img(hi.thumb, "thumb-img"), hi.thumb ? null : el("span", { class: "ph" }, PLATFORM[head.platform] || "")),
        el("span", { class: "thread-main" },
          el("span", { class: "t-title" }, hi.title),
          el("span", { class: "t-sub t-tags" }, tagLine(head)),
          el("span", { class: "t-sub t-date" + (hi.recovered ? "" : " only-date") },
            hits ? null : el("span", { class: "t-date-phone" }, day + (hi.recovered ? " · " : "")), // phone: the date under the title
            hi.recovered ? RECOVERED : null))),
      el("span", { class: "head-side" }, rowLinks(t, 0, hi))),
    when,
    side,
    n > 1 ? el("ol", { class: listCls, "data-show": show }, idx.map((i) => trackRow(t, t.tracks[i], i, hits))) : null,
    foot, after,
    hits ? null : el("div", { class: "thread-foot" }, // no "Add a track here" in search results
      el("button", { class: "linkbtn add-here", onclick: (e) => toggleAddForm(t, e.currentTarget.closest(".thread")) }, "Add a track here")));
  const list = li.querySelector(".scroll-list");
  if (list) {
    list.addEventListener("scroll", () => updateListPos(li), { passive: true });
    requestAnimationFrame(() => fitList(li));
  }
  return li;
}

/* "Thread": leave the search and show this thread where it sits in the feed */
function goToThread(t) {
  $("#q").value = ""; syncClear();
  if (view !== "threads") { view = "threads"; history.replaceState(null, "", location.pathname); document.querySelectorAll("#menu button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === "threads"))); }
  expanded.delete(t.id);
  runSearch();
  const at = shown.findIndex((x) => x.t === t);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + t.id);
  if (!node) return;
  // boxes above size themselves a moment later: keep placing it under the header until nothing moves
  let frames = 0;
  const place = () => {
    const dy = node.getBoundingClientRect().top - headerBottom() - 8;
    if (Math.abs(dy) > 1) pageScrollBy(dy);
    if (++frames < 40) requestAnimationFrame(place);
  };
  place();
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
let lastTime = 0;
function setTime(cur, dur) {
  lastTime = cur || 0;
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
  const pn = document.getElementById("th-" + t.id);
  // the thread you play from gets the selected frame (in search results only the ones that scroll)
  if (pn && activeId !== t.id && !addingId && (selectable(pn) || !$("#q").value.trim())) setActive(t.id, `${t.id}:${i}`);
  const token = ++loadToken;
  const tr = t.tracks[i], x = info(tr), m = meta[tr.url] || {};
  if (adapter) adapter.destroy();
  adapter = null;
  const box = $("#otherSlot"); box.replaceChildren();
  const dock = $("#dock"); dock.hidden = false;
  $("#nowTitle").textContent = x.title;
  $("#threadBtn").textContent = `${i + 1} of ${t.tracks.length}` + (phone() ? "" : t.kind === "tag" ? " in this tag" : " in this thread");
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
    const css = getComputedStyle(document.documentElement), hex = (v) => css.getPropertyValue(v).trim().replace("#", "");
    adapter = makePlain(box, `https://bandcamp.com/EmbeddedPlayer/${m.bandcamp_embed}/size=large/bgcol=${hex("--surface")}/linkcol=${hex("--jade")}/artwork=small/tracklist=false/transparent=true/`, x.title);
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
/* phone, search results with Scroll on: playing a track switches Scroll off and keeps
   the tracks that were on screen as the result window */
function freezeScrolledResult(t) {
  if (!phone() || !scrollOn.has(t.id)) return;
  const node = document.getElementById("th-" + t.id), list = node && node.querySelector(".scroll-list");
  const entry = shown.find((x) => x.t === t);
  if (!list || !entry) return;
  const box = list.getBoundingClientRect();
  const seen = [...list.querySelectorAll(":scope > li.track")]
    .filter((r) => { const q = r.getBoundingClientRect(); return q.bottom > box.top + 4 && q.top < box.bottom - 4; })
    .map((r) => +r.dataset.k.split(":").pop());
  if (!seen.length) return;
  fixedRows.set(t.id, seen);
  scrollOn.delete(t.id);
  rerenderKeep(t, entry.hits);
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
  const room = $(".bar").getBoundingClientRect().top - headerBottom() - 16;
  $("#threadPop").style.maxHeight = phone() ? Math.max(120, room) + "px" : "";
  $("#threadPop").hidden = false; $("#threadBtn").setAttribute("aria-expanded", "true");
  $("#threadList .current")?.scrollIntoView({ block: "nearest" });
}
$("#threadBtn").onclick = (e) => { e.stopPropagation(); $("#threadPop").hidden ? openThread() : closeThread(); };
$("#threadPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("touchmove", (e) => {
  if (!$("#threadPop").hidden && !e.target.closest("#threadPop")) e.preventDefault();
}, { passive: false });
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
  $("#volNum").textContent = volume; $("#volNum").hidden = volume === 100;
}
showVolume();
$("#volBtn").onclick = (e) => {
  e.stopPropagation();
  const open = $("#volPop").hidden;
  $("#volPop").hidden = !open; $("#volBtn").setAttribute("aria-expanded", open ? "true" : "false");
};
$("#volPop").addEventListener("click", (e) => e.stopPropagation());
$("#volNum").onclick = (e) => $("#volBtn").onclick(e);
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
  document.querySelectorAll(".scroll-list.open").forEach((l) => { // an open box at the top ends above the player
    const th = l.closest(".thread"), top = th.getBoundingClientRect().top - headerBottom();
    if (top > -4 && top < 40) fitList(th);
  });
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
/* Tag field: type, pick a suggestion with Enter (or the arrow keys), keep typing the next one.
   Editing a track: its tags under the title get an × and can be clicked away.
   Adding a track: the tags stack in two rows to the right of the field. */
function tagEditor(initial, suggested = [], host = null) {
  const chosen = [...initial];
  const input = el("input", { type: "text", class: "tag-input", placeholder: "Add tag", autocomplete: "off", spellcheck: "false", "aria-label": "Add tag" });
  const drop = el("ul", { class: "tag-drop", hidden: true });
  const stack = host ? null : el("span", { class: "tag-stack" });
  const original = host ? [...host.childNodes] : null;
  let opts = [], active = 0;
  const remove = (g) => { chosen.splice(chosen.indexOf(g), 1); drawChips(); input.focus(); };
  const drawChips = () => {
    if (host) {
      host.replaceChildren(...chosen.map((g) => el("span", {
        class: "tag tag-x", role: "button", tabindex: "0", title: "Remove tag",
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); remove(g); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); remove(g); } },
      }, g, el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
      return;
    }
    stack.replaceChildren(
      ...chosen.map((g) => el("button", { type: "button", class: "tag-chip", title: "Remove tag", onclick: () => remove(g) }, g, el("span", { "aria-hidden": "true" }, " ×"))),
      // the main track's tags, offered with a dotted outline; click to use one
      ...suggested.filter((g) => !chosen.includes(g)).map((g) => el("button", { type: "button", class: "tag-chip suggest", title: "Use this tag", onclick: () => { chosen.push(g); drawChips(); } }, "+ " + g)));
  };
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
    if (e.key === "Enter" && e.shiftKey) return; // Shift+Enter saves the card (handled by the form)
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
  return {
    box: el("span", { class: "tag-area" }, el("span", { class: "tag-box" }, input, drop), stack),
    input,
    use: (g) => { g = normTag(g); if (g && !chosen.includes(g)) { chosen.push(g); drawChips(); } },
    has: (g) => chosen.includes(normTag(g)),
    drop: (g) => { const k = chosen.indexOf(normTag(g)); if (k > -1) { chosen.splice(k, 1); drawChips(); } },
    get: () => { if (input.value.trim()) add(input.value); return [...chosen]; }, // a typed but not yet added tag counts too
    restore: () => { if (host) host.replaceChildren(...original); },
  };
}

function addForm(thread, edit, row) {
  // edit = { t, i } when editing an existing track; row = that track's row (its tags become removable)
  const tr = edit ? edit.t.tracks[edit.i] : null;
  const host = row ? row.querySelector(".tag-wrap") : null;
  const tags = tagEditor(tr ? Object.keys(tr.tags || {}) : [], !tr && thread ? Object.keys(thread.tracks[0].tags || {}) : [], host);
  const more = moreInfo(tr, edit, tags);
  const arrow = el("button", { type: "button", class: "btn ghost more-info-btn", "aria-expanded": "false", title: "More info: notes, date, suggestions",
    "aria-label": "More info", onclick: (e) => {
      const open = more.hidden; more.hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open));
      if (open) more.querySelector("textarea").focus({ preventScroll: true });
      const wrap = form.closest(".edit-wrap");
      if (wrap && wrap.previousElementSibling) focusRow(wrap.previousElementSibling, true, "top", "top"); // the track stays at the top
      else if (open) revealWhole(form);
    } }, "▾");
  const form = el("form", { class: "add-form" + (edit ? " edit-form" : ""), autocomplete: "off" },
    el("label", { class: "af-field" }, el("span", {}, "Title"),
      el("input", { name: "title", type: "text", placeholder: "Artist – Track (optional, filled in automatically)" })),
    el("label", { class: "af-field" }, el("span", {}, "Link"),
      el("input", { name: "url", type: "url", required: true, placeholder: "YouTube, SoundCloud, Bandcamp or Vimeo link" })),
    el("div", { class: "af-actions" },
      tags.box,
      // a mix (DJ mix, full album…): it gets the "mix" tag and shows up on the Mixes page
      el("button", { type: "button", class: "btn ghost mix-btn", "aria-pressed": String(tags.has("mix")),
        title: "A DJ mix, full album or other long recording: shows up under Mixes",
        onclick: (e) => { const on = e.currentTarget.getAttribute("aria-pressed") !== "true"; e.currentTarget.setAttribute("aria-pressed", String(on)); on ? tags.use("mix") : tags.drop("mix"); } }, "Mix"),
      edit ? arrow : null,
      el("span", { class: "af-msg hint", role: "status" }),
      edit ? el("button", { type: "button", class: "btn ghost danger", onclick: (e) => deleteTrack(form, edit, e.currentTarget) }, "Delete") : null,
      edit ? el("button", { type: "button", class: "btn ghost move-btn", "aria-expanded": "false", onclick: (e) => toggleMovePanel(form, edit, e.currentTarget) }, "Move") : null,
      edit ? null : arrow,
      el("button", { type: "submit", class: "btn" }, "Save")),
    more);
  if (tr) { form.title.value = tr.title || info(tr).title; form.url.value = tr.url; }
  form.url.addEventListener("input", () => form.url.setCustomValidity(""));
  form.tags = tags;
  form.addEventListener("submit", (ev) => { ev.preventDefault(); edit ? saveEdit(form, edit) : saveTrack(form, thread); });
  // Shift+Enter saves from any field, the tag field included
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); form.requestSubmit(); }
  }, true);
  return form;
}
/* the panel under the arrow: notes, the main post's date, suggestions from the lookups, and Meta */
let descriptions = null; // loaded only when a Description is opened
const loadDescriptions = () => (descriptions ||= fetch("data/descriptions.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
function moreInfo(tr, edit, tags) {
  const x = (tr && extra[tr.url]) || {};
  const notes = el("textarea", { name: "notes", rows: "3", placeholder: "Not shown on the site; searches still find them" });
  notes.value = (tr && tr.notes) || "";
  const box = el("div", { class: "af-more", hidden: true },
    el("label", { class: "af-field" }, el("span", {}, "Notes"), notes));
  if (edit && edit.i === 0) {
    const date = el("input", { name: "date", type: "date", required: true });
    date.value = tr.shown_date || tr.date;
    // the arrows move the thread one place up or down in the feed (saved with Save)
    const t = edit.t, note = el("span", { class: "hint" });
    let pos = null;
    const others = () => threads.filter((o) => isBase(o) && o !== t).sort((a, b) => activity(b) - activity(a));
    const step = (up) => {
      const cur = pos ?? activity(t), list = others();
      let next, beyond;
      if (up) { const above = list.filter((o) => activity(o) > cur); next = above[above.length - 1]; beyond = above[above.length - 2]; }
      else { const below = list.filter((o) => activity(o) < cur); next = below[0]; beyond = below[1]; }
      if (!next) return;
      const a = activity(next), b = beyond ? activity(beyond) : a + (up ? 7200 : -7200);
      pos = Math.round((a + b) / 2); // halfway between the next thread and the one after it
      if (pos === a) pos = a + (up ? 1 : -1);
      date.value = new Date(pos * 1000).toISOString().slice(0, 10);
      note.textContent = (up ? "above " : "below ") + info(next.tracks[0]).title;
    };
    date.addEventListener("input", () => { pos = null; note.textContent = ""; });
    box.feedPos = () => pos;
    box.append(el("div", { class: "af-field af-date" },
      el("span", {}, "Posted", tr.shown_date ? el("span", { class: "hint" }, ` (originally ${fmtDay(tr.date)})`) : null),
      el("div", { class: "af-date-row" }, date,
        el("button", { type: "button", class: "btn ghost", title: "One place up in the feed", "aria-label": "Move up in the feed", onclick: () => step(true) }, "↑"),
        el("button", { type: "button", class: "btn ghost", title: "One place down in the feed", "aria-label": "Move down in the feed", onclick: () => step(false) }, "↓"),
        note)));
  }
  if (tr) {
    const sug = el("div", { class: "af-sug" });
    const chips = () => sug.replaceChildren(
      el("span", { class: "af-label" }, "Suggested genres"),
      ...(x.g && x.g.length
        ? x.g.map((g) => tags.has(g) ? null : el("button", { type: "button", class: "tag-chip suggest", title: "Use as a tag", onclick: () => { tags.use(g); chips(); } }, "+ " + g))
        : [el("span", { class: "hint" }, x.chk ? "none found" : "not looked up yet")]).filter(Boolean));
    chips();
    box.append(sug,
      el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested release"),
        x.rl && x.rl.length ? el("span", {}, x.rl[0]) : el("span", { class: "hint" }, x.chk && x.v >= 3 ? "none found" : "not looked up yet"),
        x.rl && x.rl.length > 1 ? el("span", { class: "hint" }, "(also " + x.rl.slice(1).join(", ") + ")") : null),
      el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested year"),
        el("span", {}, x.y ? String(x.y) : el("span", { class: "hint" }, x.chk ? "none found" : "not looked up yet")),
        x.ys && x.ys.length ? el("span", { class: "hint" }, "(also " + x.ys.join(", ") + ")") : null,
        x.src ? el("span", { class: "hint" }, "from " + x.src.split("+").join(", ")) : null));
    // Meta: uploader and upload date; inside it, Description
    const descBox = el("div", { class: "af-desc", hidden: true });
    const descBtn = el("button", { type: "button", class: "thread-btn", onclick: async () => {
      if (!descBox.hidden) { descBox.hidden = true; return; }
      descBox.hidden = false; descBox.textContent = "Loading…";
      const d = await loadDescriptions();
      descBox.textContent = d[tr.url] || "No description found.";
    } }, "Description");
    const metaBox = el("div", { class: "af-meta", hidden: true },
      el("div", {}, el("span", { class: "af-label" }, "Uploader"), x.by || el("span", { class: "hint" }, "unknown")),
      el("div", {}, el("span", { class: "af-label" }, "Uploaded"), x.up ? fmtDay(x.up) : el("span", { class: "hint" }, "unknown")),
      el("div", {}, descBtn), descBox);
    box.append(el("div", {}, el("button", { type: "button", class: "thread-btn", onclick: () => (metaBox.hidden = !metaBox.hidden) }, "Meta")), metaBox);
  } else {
    box.append(el("p", { class: "hint af-later" }, "Suggested genres, year and the uploader are looked up after saving (every few hours)."));
  }
  return box;
}
const mixTags = (form) => { const g = form.tags.get().filter((x) => x !== "mix"); return form.querySelector(".mix-btn").getAttribute("aria-pressed") === "true" ? [...g, "mix"] : g; };
function closeAddForm(form, opts = {}) {
  if (!form) return;
  if (form.tags) form.tags.restore();
  if (form.parentElement && form.parentElement.classList.contains("edit-li")) {
    const wrap = form.parentElement, th = form.closest(".thread"), row = wrap.previousElementSibling, inBox = !!wrap.closest(".scroll-list");
    if (wrap._ro) wrap._ro.disconnect();
    if (row) row.classList.remove("editing");
    wrap.remove(); fitList(th);
    if (row && !opts.quiet) focusRow(row, true, "top", "top"); // back to the track that was edited, at the top
    return;
  }
  if (form.parentElement && form.parentElement.id === "addPanel") { $("#addPanel").hidden = true; $("#addBtn").setAttribute("aria-expanded", "false"); }
  const inThread = form.parentElement && form.parentElement.classList.contains("thread");
  form.remove();
  if (inThread && addingId) { // the thread shows all its tracks again and is no longer selected
    const t = threads.find((x) => x.id === addingId);
    addingId = null; setActive(null);
    if (t) rerenderKeep(t, null);
  }
}
/* only one add/edit card open at a time */
function closeAllCards() { document.querySelectorAll(".add-form").forEach((f) => closeAddForm(f, { quiet: true })); }
function openAdd(thread) {
  if (!getToken()) { openSetup(); return; }
  if (thread) toggleAddForm(thread, document.getElementById("th-" + thread.id));
  else toggleHeaderForm();
}
function toggleHeaderForm() {
  if (!getToken()) { openSetup(); return; }
  const panel = $("#addPanel");
  if (!panel.hidden) { closeAddForm(panel.querySelector("form")); return; }
  closeAllCards();
  panel.replaceChildren(addForm(null));
  panel.hidden = false; $("#addBtn").setAttribute("aria-expanded", "true");
  panel.querySelector("input").focus();
}
function toggleAddForm(thread, li) {
  if (!getToken()) { openSetup(); return; }
  if (!li) return;
  const open = li.querySelector(":scope > .add-form");
  if (open) { closeAddForm(open); return; }
  closeAllCards();
  const form = addForm(thread);
  li.querySelector(".thread-foot").after(form);
  form.querySelector("input").focus({ preventScroll: true });
  revealWhole(form); // the card in view
}
$("#addBtn").onclick = toggleHeaderForm;

function toggleEditForm(t, i, row) {
  if (!getToken()) { openSetup(); return; }
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) { closeAddForm(next.querySelector(".add-form")); return; }
  closeAllCards();
  if (t.kind === "tag") { // the track lives in its own thread; edit it there
    const tr = t.tracks[i], home = threads.find((x) => x.kind !== "tag" && x.tracks.includes(tr));
    if (!home) return;
    t = home; i = home.tracks.indexOf(tr);
  }
  const form = addForm(null, { t, i }, row);
  const wrap = el(row.tagName === "LI" ? "li" : "div", { class: "edit-wrap edit-li" }, form);
  row.after(wrap);
  row.classList.add("editing"); // a dotted box around the track and its card
  const box = wrap.closest(".scroll-list");
  form.tags.input.focus({ preventScroll: true }); // editing usually means tagging: start in the tag field
  if (box) {
    // inside a scrolling box: the box grows to fit the card (and its More info), the track goes a third of the way down
    const base = box.clientHeight, grow = () => { box.style.maxHeight = base + wrap.offsetHeight + "px"; };
    grow();
    wrap._ro = new ResizeObserver(grow); wrap._ro.observe(wrap);
  }
  focusRow(row, true, "top", "top"); // the track goes to the top, the card under it
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
  const fromThread = form.closest(".thread").id.slice(3); // where the track was edited (a tag thread or its own)
  const url = form.url.value.trim(), title = form.title.value.trim();
  if (!LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a YouTube, SoundCloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const item = { action: "edit", thread: t.id, id: tr.id, title, url, tags: mixTags(form), ts: Math.floor(Date.now() / 1000) };
  const notes = form.notes.value.trim();
  if (notes !== (tr.notes || "")) item.notes = notes;
  if (form.date && i === 0) {
    if (!form.date.value) { form.date.reportValidity(); return; }
    const pos = form.querySelector(".af-more").feedPos();
    if (pos) { item.date = form.date.value; item.pos = pos; }
    else if (form.date.value !== (tr.shown_date || tr.date)) item.date = form.date.value;
  }
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button"), save = form.querySelector("button[type=submit]");
  btns.forEach((b) => (b.disabled = true)); save.textContent = "Saving…"; msg.textContent = "";
  try { await writeInbox(item, "edit"); }
  catch (e) { msg.textContent = netMsg(e); save.textContent = "Save"; btns.forEach((b) => (b.disabled = false)); return; }
  // apply on screen right away
  if (url !== tr.url) { const p = parseLocal(url); delete tr.yt; delete tr.vimeo; Object.assign(tr, p); if (!p.yt) delete tr.yt; if (!p.vimeo) delete tr.vimeo; }
  if (title) tr.title = title; else delete tr.title;
  applyTags(tr, item.tags, item.ts);
  if ("notes" in item) { if (notes) tr.notes = notes; else delete tr.notes; }
  if (item.date) { // option A: the thread takes its place by this date (on the next load of the feed)
    if (item.date === tr.date && !item.pos) { delete tr.shown_date; delete t.pos_ts; delete t.pos_set; }
    else {
      if (item.date === tr.date) delete tr.shown_date; else tr.shown_date = item.date;
      t.pos_ts = item.pos || Math.floor(Date.parse(item.date + "T12:00:00Z") / 1000); t.pos_set = item.ts;
    }
    sortThreads();
  }
  tr._hay = null;
  rerenderThread(t, i);
  refreshTags();
  // back to the track, at the top (once the re-drawn boxes above it have their final height)
  requestAnimationFrame(() => requestAnimationFrame(() => focusTrack(fromThread, tr, "top")));
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
  btns.forEach((b) => (b.disabled = true)); form.querySelector(".move-btn").textContent = "Moving…"; msg.textContent = "";
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
    const note = el("p", { class: "moved-note" }, "Moved to: ", el("a", { href: "#th-" + dest.id, onclick: (e) => { e.preventDefault(); const n = document.getElementById("th-" + dest.id); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); else { history.replaceState(null, "", `#t/${dest.id}`); threads.unshift(threads.splice(threads.indexOf(dest), 1)[0]); runSearch(); pageScrollTo(0); } } }, threadLabel(dest)));
    src.querySelector(".thread-foot").before(note);
    setTimeout(() => note.remove(), 8000);
  }
}

async function deleteTrack(form, { t, i }, btn) {
  if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "Confirm delete"; return; }
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); btn.textContent = "Deleting…"; msg.textContent = "";
  try { await writeInbox({ action: "delete", thread: t.id, id: tr.id, ts: Math.floor(Date.now() / 1000) }, "delete"); }
  catch (e) { msg.textContent = netMsg(e); btn.textContent = "Delete"; btn.dataset.confirm = ""; btns.forEach((b) => (b.disabled = false)); return; }
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
  const item = { url, title: form.title.value.trim(), thread: thread ? thread.id : "", tags: mixTags(form), ts };
  if (form.notes.value.trim()) item.notes = form.notes.value.trim();
  const msg = form.querySelector(".af-msg"), btn = form.querySelector("button[type=submit]");
  btn.disabled = true; btn.textContent = "Saving…"; msg.textContent = "";
  try { await writeInbox(item, ""); }
  catch (e) { msg.textContent = netMsg(e); btn.textContent = "Save"; btn.disabled = false; return; }
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
  if (item.notes) tr.notes = item.notes;
  if (item.tags && item.tags.length) applyTags(tr, item.tags, item.ts);
  let th = item.thread && threads.find((x) => x.id === item.thread);
  if (th) th.tracks.push(tr);
  else { tr.main = true; th = { id: `p${item.ts}`, date: tr.date, ts: item.ts, kind: "thread", tracks: [tr] }; threads.unshift(th); }
  // update only what changed, so the page doesn't jump
  const old = document.getElementById("th-" + th.id);
  const node = threadNode({ t: th, hits: null });
  if (old) old.replaceWith(node);
  else if (!$("#q").value.trim() && view === "threads") { $("#threads").prepend(node); rendered++; shown.unshift({ t: th, hits: null }); }
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

/* Escape: close every add/edit card and leave the search */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (activeId) setActive(null);
  const now = Date.now(), twice = now - lastEsc < 450;
  lastEsc = twice ? 0 : now;
  if (twice) { showPlaying(); return; }
  document.querySelectorAll(".add-form").forEach((f) => closeAddForm(f));
  if ($("#q").value) { $("#q").value = ""; syncClear(); runSearch(); }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
});
/* Esc twice quickly: bring the playing track to the middle of the screen (when it is on the page) */
let lastEsc = 0;
function showPlaying() {
  if (!playing) return;
  const row = [...document.querySelectorAll(".playing")].find((r) => r.offsetParent);
  if (row) focusRow(row, true);
}
/* a track a third of the way down the window (and in view inside its scrolling box) */
function focusTrack(threadId, tr, at = "third") {
  const t = threads.find((x) => x.id === threadId);
  const i = t ? t.tracks.indexOf(tr) : -1;
  const row = i > -1 && document.querySelector(`[data-k="${CSS.escape(threadId)}:${i}"]`);
  if (row) focusRow(row, true, "top", at);
}
function focusRow(row, smooth, boxAt = "center", at = "third") {
  const box = row.closest(".scroll-list"); // inside a scrolling box: first bring it into the box's view
  if (box) box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - (boxAt === "top" ? 0 : (box.clientHeight - row.offsetHeight) / 2);
  const top = headerBottom(), dock = $("#dock").hidden ? 0 : $("#dock").getBoundingClientRect().height;
  const y = at === "top" ? top + 8 : top + (innerHeight - dock - top) / 3; // right under the header, or a third of the way down
  pageScrollBy(row.getBoundingClientRect().top - y, smooth);
}
/* typing a letter or number anywhere starts a search */
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  $("#q").focus(); // the key itself then lands in the search field
});

/* "Source" in the player: the playing track's own thread (when playing from a tag) */
const homeOf = (tr) => threads.find((x) => x.kind !== "tag" && x.tracks.includes(tr));
$("#discogsBtn").onclick = () => {
  if (!playing) return;
  const title = info(playing.thread.tracks[playing.index]).title;
  open("https://www.google.com/search?q=" + encodeURIComponent("discogs " + title), "_blank", "noopener");
};
$("#sourceBtn").onclick = () => {
  if (!playing) return;
  const home = homeOf(playing.thread.tracks[playing.index]);
  if (home) goToThread(home);
};
/* Cmd+Enter (Ctrl+Enter on Windows) while a track plays: open its edit card (on a device with a key) */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !playing || !getToken()) return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]") && !t.closest(".edit-form")) return;
  e.preventDefault();
  const tr = playing.thread.tracks[playing.index], home = homeOf(tr);
  if (!home) return;
  const i = home.tracks.indexOf(tr);
  let row = document.querySelector(`[data-k="${home.id}:${i}"]`);
  if (!row) { goToThread(home); row = document.querySelector(`[data-k="${home.id}:${i}"]`); }
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) { // already open: open (or close) its More info
    next.querySelector(".more-info-btn")?.click();
    return;
  }
  toggleEditForm(home, i, row);
  row.scrollIntoView({ block: "nearest" });
});

/* keyboard (laptop): Space plays/pauses, Left/Right jump 5 seconds back/forward */
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  if ($("#dock").hidden) return;
  if (e.code === "Space") { e.preventDefault(); if (!$("#playBtn").disabled) $("#playBtn").click(); }
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !IOS) { // volume in steps of 5
    e.preventDefault();
    const v = Math.max(0, Math.min(100, volume + (e.key === "ArrowUp" ? 5 : -5)));
    $("#vol").value = v; $("#vol").dispatchEvent(new Event("input"));
  }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && adapter && adapter.controllable) {
    e.preventDefault();
    adapter.seek(Math.max(0, lastTime + (e.key === "ArrowRight" ? 5 : -5)));
  }
});

/* ---------- boot ---------- */
let timer;
function syncClear() { $("#clearQ").hidden = !$("#q").value; }
$("#q").addEventListener("input", () => { syncClear(); clearTimeout(timer); timer = setTimeout(runSearch, 150); });
$("#clearQ").onclick = () => { $("#q").value = ""; syncClear(); runSearch(); if (phone()) $("#q").blur(); else $("#q").focus(); };
// phones: Enter, or touching anywhere outside the search field, puts the keyboard away
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); runSearch(); $("#q").blur(); } });
document.addEventListener("touchstart", (e) => { if (document.activeElement === $("#q") && !e.target.closest(".search")) $("#q").blur(); }, { passive: true });
$("#home").onclick = (e) => { e.preventDefault(); toggleMenu(); };

(async function boot() {
  try {
    const [d, m, x] = await Promise.all([
      fetch("data/tracks.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/extra.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    threads = d.threads; meta = m; extra = x;
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
  const page = location.hash.match(/^#\/(\w+)/);
  if (page && VIEW_NAMES[page[1]]) view = page[1];
  document.querySelectorAll("#menu button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view)));
  runSearch();
  watchHistory();
  checkSetupHash();
})();
