"use strict";
const REPO = "nrgproduct/nrgfm";
const PAGE = 40;

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false || k === "title") continue; // no hover hints on this site
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

/* What search looks in, field by field (the filters next to the result count switch fields off) */
// in order of importance: a match in an earlier field ranks a result higher
const FIELDS = [["title", "Titles"], ["notes", "Notes"], ["tags", "Tags"], ["release", "Release"], ["year", "Year"], ["genres", "Genres"], ["uploader", "Meta"]];
function haystack(t) {
  if (t._hay == null) {
    const m = meta[t.url] || {}, x = extra[t.url] || {};
    const j = (a) => " " + fold(a.filter(Boolean).join(" ")); // words start after a space: matching is by word start
    const named = t.title || m.title || m.wb_title;
    t._f = {
      title: j([t.title, m.title, m.wb_title, named ? "" : slugTitle(t)]), // the link's words only when there is no title
      notes: j([t.notes]),
      tags: j(shownTags(t)),
      genres: j(x.g || []),
      year: j([x.y, decadeOf(x.y)]),
      release: j(t.release || x.rl || []),
      uploader: j([m.author_name, channelArtist(m.author_name), m.wb_author, x.by]),
    };
    t._hay = Object.values(t._f).join(" ");
  }
  return t._hay;
}
const fieldsOf = (t) => (haystack(t), t._f);
let searchOff = new Set(); // filters switched off for this search only
/* a word you type matches the start of a word ("sear" finds "Search", not "Research") */
const has = (field, w) => field.includes(" " + w);
const matches = (tr, terms, off = searchOff) => { const f = fieldsOf(tr); return terms.every((w) => FIELDS.some(([k]) => !off.has(k) && has(f[k], w))); };
/* how well a track matches: the first field (in order of importance) holding all the words, else any of them */
function matchRank(tr, terms) {
  const f = fieldsOf(tr), on = FIELDS.filter(([k]) => !searchOff.has(k));
  const all = on.findIndex(([k]) => terms.every((w) => has(f[k], w)));
  if (all > -1) return all;
  const any = on.findIndex(([k]) => terms.some((w) => has(f[k], w)));
  return any > -1 ? any + 0.5 : 99;
}
let byNewest = false; // "Best match" each time

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
      if (HIDDEN_TAGS.has(g)) continue;
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
  for (const t of threads) if (isBase(t)) for (const tr of t.tracks) for (const g of shownTags(tr)) n.set(g, (n.get(g) || 0) + 1);
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
    searchOff.clear(); byNewest = false; // leaving search: the next one starts fresh
    shown = viewItems().map((t) => ({ t, hits: null }));
    $("#resultInfo").hidden = true;
    drawViewHead();
  } else {
    shown = [];
    const used = new Set(), none = new Set(), perField = new Map(); // tracks found (also) through each part
    for (const t of threads) {
      if (t.kind === "tag") continue; // tags are searched on the tracks themselves
      const hits = new Set();
      let rank = 99;
      t.tracks.forEach((tr, i) => {
        if (!matches(tr, terms, none)) return;
        const f = fieldsOf(tr);
        for (const [k] of FIELDS) if (terms.some((w) => has(f[k], w))) used.add(k); // which filters are worth showing
        if (matches(tr, terms)) {
          hits.add(i); rank = Math.min(rank, matchRank(tr, terms));
        }
        for (const [k] of FIELDS) if (terms.some((w) => has(f[k], w))) perField.set(k, (perField.get(k) || 0) + 1); // (also for parts switched off)
      });
      if (hits.size) shown.push({ t, hits, rank });
    }
    // best matches first (title, then notes, tags…), newest first within each; or simply newest first
    shown.sort((x, y) => (byNewest ? 0 : x.rank - y.rank) || activity(y.t) - activity(x.t));
    const tagHits = shown.filter((s) => s.tag).length, trackThreads = shown.length - tagHits;
    const n = shown.reduce((a, s) => a + (s.hits ? s.hits.size : 0), 0);
    const parts = [];
    if (tagHits) parts.push(`${tagHits} ${tagHits === 1 ? "tag" : "tags"}`);
    if (n) parts.push(`${n} ${n === 1 ? "track" : "tracks"} in ${trackThreads} ${trackThreads === 1 ? "thread" : "threads"}`);
    $("#resultInfo").hidden = false;
    $("#resultInfo").replaceChildren(
      el("span", { class: "result-n" }, n ? `${n} ${n === 1 ? "result" : "results"}` : `Nothing matches “${$("#q").value.trim()}”.`),
      el("button", { class: "sf sf-order", "aria-pressed": String(byNewest), onclick: () => { byNewest = !byNewest; runSearch(); } },
        byNewest ? "Newest first" : "Best match"),
      el("span", { class: "search-fields" }, FIELDS.filter(([k]) => used.has(k) || searchOff.has(k)).map(([k, name]) => el("button", {
        class: "sf" + (searchOff.has(k) ? " off" : ""), "aria-pressed": String(!searchOff.has(k)),
        onclick: () => { searchOff.has(k) ? searchOff.delete(k) : searchOff.add(k); runSearch(); } }, name,
        el("span", { class: "gi-n" }, perField.get(k) || 0)))));
    requestAnimationFrame(placeFilters);
  }
  rendered = 0;
  $("#threads").replaceChildren();
  if (terms.length) pageScrollTo(0); // results start at the top, wherever you were in the feed
  renderMore(terms.length ? 12 : PAGE); // search: the first results right away, more as you scroll
}

/* computer: the search line stays one line; filters too wide for their side get a little smaller */
function placeFilters() {
  const info = $("#resultInfo"), f = info.querySelector(".search-fields");
  if (!f || info.hidden) return;
  f.querySelectorAll(".sf, .gi-n").forEach((x) => x.style.removeProperty("font-size"));
  f.style.gap = ""; f.style.maxWidth = ""; info.classList.remove("two-rows");
  if (phone()) return;
  const room = info.getBoundingClientRect().right - info.querySelector(".result-n").getBoundingClientRect().right - 20;
  if (f.getBoundingClientRect().width <= room) return;
  // too many for one line: smaller, in two rows centred on the line (the line itself keeps its height)
  info.classList.add("two-rows"); f.style.maxWidth = room + "px";
  f.querySelectorAll(".sf, .gi-n").forEach((x) => x.style.setProperty("font-size", "12px", "important"));
}
addEventListener("resize", placeFilters);
/* Search results: rest the pointer on a found track for a moment and a small note says where the words
   were found ("Title", "Uploader: …"). 0.6 s: long enough not to pop up while just moving past. */
const whyBox = el("div", { class: "why", hidden: true });
document.body.append(whyBox);
let whyTimer = 0, whyRow = null, whyXY = [0, 0];
document.addEventListener("mousemove", (e) => {
  whyXY = [e.clientX, e.clientY];
  const title = e.target.closest && e.target.closest(".tr-title, .t-title"); // only over the highlighted title itself
  const row = title && title.closest(".thread.searching .track.hit, .thread.searching .head-row.hit");
  if (row === whyRow) return;
  whyRow = row; clearTimeout(whyTimer); whyBox.hidden = true;
  if (row) whyTimer = setTimeout(() => showWhy(row), 600);
}, { passive: true });
addEventListener("scroll", () => { whyBox.hidden = true; }, { passive: true, capture: true });
function showWhy(row) {
  const [id, i] = row.dataset.k.split(":"), t = threads.find((x) => x.id === id), tr = t && t.tracks[+i];
  if (!tr) return;
  const terms = query.split(" ").filter(Boolean), f = fieldsOf(tr), m = meta[tr.url] || {}, x = extra[tr.url] || {};
  const hit = (s) => terms.some((w) => has(" " + fold(s), w));
  const cut = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const note = () => { // the part of the notes around the first word found
    const n = tr.notes || "", k = Math.max(0, fold(n).indexOf(terms.find((w) => fold(n).includes(w)) || "") - 20);
    return (k ? "…" : "") + cut(n.slice(k), 70);
  };
  const say = {
    title: () => "Title: " + ([tr.title, m.title, m.wb_title].filter(Boolean).find(hit) || info(tr).title),
    notes: () => "Notes: " + note(),
    tags: () => "Tags: " + shownTags(tr).filter(hit).join(", "),
    genres: () => "Genres: " + (x.g || []).filter(hit).join(", "),
    year: () => "Year: " + x.y + " (" + decadeOf(x.y) + ")",
    release: () => "Release: " + cut((tr.release || x.rl || []).filter(hit).join(", ")),
    uploader: () => "Uploader: " + ([m.author_name, m.wb_author, x.by].filter(Boolean).find(hit) || m.author_name || x.by),
  };
  const lines = FIELDS.filter(([k]) => !searchOff.has(k) && terms.some((w) => has(f[k], w))).map(([k]) => say[k]());
  if (!lines.length) return;
  whyBox.replaceChildren(...lines.map((l) => el("div", {}, l)));
  whyBox.hidden = false;
  const r = whyBox.getBoundingClientRect();
  whyBox.style.left = Math.min(whyXY[0] + 14, innerWidth - r.width - 8) + "px";
  whyBox.style.top = Math.min(whyXY[1] + 18, innerHeight - r.height - 8) + "px";
}

/* ---------- pages: Threads, Tags, Mixes, Genres, History (and Random) ----------
   The logo opens the menu. Search always looks through everything; clearing it returns to the page you were on. */
let view = "threads";
const VIEW_NAMES = { threads: "Threads", tags: "Tags", mixes: "Mixes", genres: "Genres", history: "History", genreboxes: "Genres (one box each)" };
const slug = (g) => fold(g).replace(/ /g, "-");
const newestFirst = (a, b) => b.ts - a.ts;
function viewItems() {
  if (view === "tags") return threads.filter((t) => t.kind === "tag").sort((a, b) => b.last - a.last);
  if (view === "mixes") return mixThreads();
  if (view === "genres") return gSel.length ? [genreMix()] : []; // no playlist until a genre is picked
  if (view === "genreboxes") return genreThreads(); // the earlier Genres page (#/genreboxes), kept as a backup
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
/* ---------- Genres: mix genres into one playlist ----------
   Pick a genre and the playlist is every track with it; the genres left to pick are only those the playlist's
   tracks also have, each with the number of tracks you would get by adding it. Remove a genre and it widens
   again. Each new mix is shuffled; "Date added" puts the newest first. The choice is kept in the address. */
let gSel = [], gOrder = "shuffle", gMix = null, gIndex = null;
/* the same genre spelled differently counts once (drum n bass = drum and bass, synth-pop = synth pop);
   micro genres stay as they are. Your own tags count as genres here too. */
const SAME_GENRE = { "drum n bass": "drum and bass", "drum & bass": "drum and bass", "drum'n'bass": "drum and bass", "drumnbass": "drum and bass",
  "dnb": "drum and bass", "d&b": "drum and bass", "d n b": "drum and bass", "rock n roll": "rock and roll", "rock & roll": "rock and roll",
  "rock'n'roll": "rock and roll", "rock 'n' roll": "rock and roll", "hiphop": "hip hop", "r'n'b": "r&b", "rnb": "r&b", "lofi": "lo fi",
  "dub step": "dubstep", "synthpop": "synth pop", "italodisco": "italo disco", "triphop": "trip hop", "kpop": "k pop", "jpop": "j pop", "electropop": "electro pop" };
const sameGenre = (g) => { g = g.trim().toLowerCase().replace(/\s+/g, " "); g = SAME_GENRE[g] || g; g = g.replace(/\s*-\s*/g, " "); return SAME_GENRE[g] || g; };
const NOT_GENRES = new Set(["broken link", "plays on youtube only"]); // housekeeping tags
/* the decade of the earliest release year found: 1984 → "80s", 2004 → "2000s", 2014 → "2010s" */
const decadeOf = (y) => { y = +y; if (!y) return ""; const d = Math.floor(y / 10) * 10; return d >= 1920 && d < 2000 ? String(d).slice(2) + "s" : d + "s"; };
const genresOf = (tr) => { const x = extra[tr.url] || {}; return [...new Set([...(x.gm || (x.g || []).map(sameGenre)), ...shownTags(tr).filter((g) => !NOT_GENRES.has(g)), decadeOf(x.y)].filter(Boolean))]; };
function genreIndexAll() {
  if (gIndex) return gIndex;
  gIndex = new Map();
  for (const tr of baseTracks()) for (const g of genresOf(tr)) (gIndex.get(g) || gIndex.set(g, new Set()).get(g)).add(tr);
  return gIndex;
}
function genreTracks(sel) {
  if (!sel.length) return [];
  const idx = genreIndexAll(), sets = sel.map((g) => idx.get(g) || new Set()).sort((a, b) => a.size - b.size);
  return [...sets[0]].filter((tr) => sets.every((st) => st.has(tr)));
}
function genreCounts() { // genre -> tracks you would get by adding it
  const idx = genreIndexAll(), out = new Map();
  if (!gSel.length) { for (const [g, st] of idx) out.set(g, st.size); }
  else for (const tr of genreTracks(gSel)) for (const g of genresOf(tr)) if (!gSel.includes(g)) out.set(g, (out.get(g) || 0) + 1);
  return [...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
function genreMix(fresh) {
  if (gMix && !fresh) return gMix;
  const tracks = genreTracks(gSel);
  if (gOrder === "date") tracks.sort((a, b) => b.ts - a.ts);
  else for (let i = tracks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
  gMix = { id: "genre-mix", kind: "tag", mix: true, name: gSel.join(" + "), tracks, last: 0 };
  return gMix;
}
function setGenres(sel) {
  gSel = sel;
  history.replaceState(null, "", "#/genres" + (gSel.length ? "?g=" + gSel.map(encodeURIComponent).join(",") : ""));
  const t = genreMix(true), node = document.getElementById("th-genre-mix");
  shown = gSel.length ? [{ t, hits: null }] : [];
  if (!gSel.length) { if (node) node.remove(); rendered = 0; }
  else if (node) node.replaceWith(genreMixNode(t));
  else { $("#threads").replaceChildren(genreMixNode(t)); rendered = 1; }
  if (playing && playing.thread.mix) markPlaying();
  const old = $("#viewHead .gm-picker"); if (old) old.replaceWith(genrePicker(true));
}
function genrePicker(keepFocus) {
  const counts = genreCounts();
  const input = el("input", { type: "text", class: "tag-input", placeholder: gSel.length ? "" : "Combine multiple genres into a playlist", autocomplete: "off", spellcheck: "false", "aria-label": "Add genre" });
  const chips = el("span", { class: "tag-chips-in" }, gSel.map((g) => el("button", { type: "button", class: "tag-chip in",
    onmousedown: (e) => e.preventDefault(), onclick: () => setGenres(gSel.filter((x) => x !== g)) }, g, el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
  const field = el("span", { class: "tag-field", onmousedown: (e) => { if (e.target === field || e.target === chips) { e.preventDefault(); input.focus(); } } }, chips, input);
  const drop = el("div", { class: "tag-drop", hidden: true });
  let opts = [], active = 0;
  const drawDrop = () => {
    const q = fold(input.value);
    opts = q ? counts.filter(([g]) => fold(g).split(" ").some((w) => w.startsWith(q)) || fold(g).startsWith(q)).slice(0, 8) : [];
    active = 0;
    drop.replaceChildren(el("ul", { class: "drop-list" }, opts.map(([g, n], k) => el("li", { class: k === active ? "on" : "",
      onmousedown: (e) => { e.preventDefault(); setGenres([...gSel, g]); } }, g, el("span", { class: "gi-n" }, n)))));
    drop.hidden = !opts.length;
  };
  input.addEventListener("input", drawDrop);
  input.addEventListener("blur", () => setTimeout(() => (drop.hidden = true), 100));
  input.addEventListener("keydown", (e) => {
    const items = [...drop.querySelectorAll("li")];
    if (e.key === "Enter") { e.preventDefault(); if (opts[active]) setGenres([...gSel, opts[active][0]]); if (phone()) setTimeout(() => document.activeElement.blur(), 50); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && items.length) {
      e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      items.forEach((li, k) => li.classList.toggle("on", k === active));
    } else if (e.key === "Backspace" && !input.value && gSel.length) setGenres(gSel.slice(0, -1));
    else if (e.key === "Escape") { e.stopPropagation(); if (!drop.hidden) drop.hidden = true; else { setGenres([]); } }
  });
  const pool = el("div", { class: "gm-pool genre-index" },
    counts.length ? counts.flatMap(([g, n]) => [el("button", { class: "when-link", onclick: () => setGenres([...gSel, g]) }, g, el("span", { class: "gi-n" }, n)), " "])
      : el("span", { class: "hint" }, "No other genres in this mix."));
  const moreArrow = el("span", { class: "gm-more", hidden: true, "aria-hidden": "true" });
  moreArrow.innerHTML = '<svg viewBox="0 0 16 10"><path d="M2 2l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
  pool.addEventListener("scroll", () => (moreArrow.hidden = pool.scrollTop + pool.clientHeight >= pool.scrollHeight - 4), { passive: true });
  const clear = el("button", { type: "button", class: "btn ghost square gm-clear", "aria-label": "Clear", hidden: !gSel.length || null, onclick: () => setGenres([]) });
  clear.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  const box = el("div", { class: "gm-picker" + (gSel.length ? " picked" : "") }, el("span", { class: "tag-box gm-field" }, field, clear, drop),
    el("div", { class: "gm-pool-wrap" }, pool, moreArrow));
  // (phone: no keyboard popping up again; and never taken from the search bar or another field the person is in)
  const busy = () => { const a = document.activeElement; return a && a.matches("input, textarea") && !a.closest(".gm-picker"); };
  if (keepFocus && !phone() && !busy()) requestAnimationFrame(() => { if (!busy()) input.focus(); });
  requestAnimationFrame(() => (field.scrollLeft = field.scrollWidth)); // the last genre picked stays in view
  requestAnimationFrame(() => fitMix());
  return box;
}
function genreMixNode(t) {
  const n = t.tracks.length, BATCH = 60;
  let drawn = Math.min(n, BATCH);
  const list = el("ol", { class: "tag-list scroll-list gm-list", "data-total": n },
    n ? t.tracks.slice(0, drawn).map((tr, i) => trackRow(t, tr, i, null))
      : el("li", { class: "gm-empty hint" }, gSel.length ? "No tracks have all of these genres." : "Pick a genre above to start a playlist."));
  list.addEventListener("scroll", () => {
    if (drawn >= n || list.scrollTop + list.clientHeight < list.scrollHeight - 500) return;
    const more = t.tracks.slice(drawn, drawn + BATCH).map((tr, k) => trackRow(t, tr, drawn + k, null));
    drawn += more.length; list.append(...more); markPlaying();
  }, { passive: true });
  list.addEventListener("scroll", () => updateListPos(list.closest(".thread")), { passive: true }); // "3 of 8" follows the scrolling
  // only the playlist is redrawn (the genre field above is left alone); Date added pressed again goes back to shuffled
  const order = (o, label) => el("button", { class: "more-toggle" + (o === "date" && gOrder === o ? " on" : ""), onclick: () => {
    gOrder = o === "date" && gOrder === "date" ? "shuffle" : o;
    const mix = genreMix(true), old = document.getElementById("th-genre-mix");
    shown = [{ t: mix, hits: null }];
    if (old) old.replaceWith(genreMixNode(mix));
    if (playing && playing.thread.mix) markPlaying();
  } }, label);
  const node = el("li", { class: "thread tag-thread framed genre-mix", id: "th-" + t.id },
    el("div", { class: "tag-frame" },
      el("div", { class: "tag-side" },
        el("div", { class: "tag-label" },
          el("span", { class: "gm-names" }, gSel.map((g) => el("span", { class: "gm-name" }, "+ " + g))),
          el("span", { class: "tag-count gm-n" }, `${n} ${n === 1 ? "track" : "tracks"}`)),
        el("div", { class: "gm-order" }, n > 1 ? el("span", { class: "more-pos" }, `1 of ${n}`) : null, order("shuffle", "Shuffle"), order("date", "Date added"))),
      list));
  requestAnimationFrame(() => { fitMix(node); fitNames(node); updateFade(list); });
  return node;
}
/* each "+ genre" line scaled to fill the width: short names big, long ones small */
/* a genre name too long for the side of the playlist box gets smaller until it fits on one line */
function fitNames(node) {
  node.querySelectorAll(".gm-name").forEach((n) => {
    n.style.fontSize = "";
    const w = n.parentElement.clientWidth, nat = n.scrollWidth, base = parseFloat(getComputedStyle(n).fontSize);
    if (nat > w) n.style.fontSize = Math.max(9, Math.floor(base * w / nat * 10) / 10) + "px";
  });
}
/* the playlist box reaches down to the bottom of the window (or the player) and no further */
/* Genres layout: the genres to pick and the playlist share the window. The playlist gets at least half of it
   (or just what its tracks need); when the genres don't fit above it, they scroll in their own box with a small
   arrow showing there is more. The page itself doesn't scroll. */
/* how much of the bottom of the window the player covers over the content column: the video floats beside the
   content on wide screens, so only the bar counts there */
function dockH() {
  const d = $("#dock"); if (d.hidden) return 0;
  const m = $("main").getBoundingClientRect(), media = d.querySelector("#media").getBoundingClientRect();
  if (media.height && media.left > m.left + m.width / 2) return d.querySelector(".bar").getBoundingClientRect().height;
  return d.getBoundingClientRect().height;
}
function fitMix(node = document.getElementById("th-genre-mix")) {
  const pool = $("#viewHead .gm-pool"), list = node && node.querySelector(".gm-list");
  if (!pool) return;
  const dock = dockH();
  pool.style.height = ""; pool.parentElement.classList.remove("scrolls");
  const avail = innerHeight - dock - (pool.getBoundingClientRect().top + pageY()) - 12; // from the top of the genres to the bottom
  if (!list) { pool.parentElement.querySelector(".gm-more").hidden = true; return; }
  list.style.height = "";
  const frame = node.getBoundingClientRect().height - list.getBoundingClientRect().height; // the box around the list
  const gap = node.getBoundingClientRect().top - pool.getBoundingClientRect().bottom;
  const poolNeed = pool.scrollHeight, row = 56; // a fixed row height, so the box is always in the same place
  // the box has one size: half the window plus two tracks (on a phone it reaches down to the bottom)
  const fixed = Math.min(avail - 60 - gap, avail / 2 + 2 * row);
  const listH = phone() ? Math.max(fixed, avail - poolNeed - gap) : fixed;
  const poolH = phone() ? Math.min(poolNeed, avail - listH - gap) : avail - listH - gap; // computer: the genres area keeps its height, so the box stays put
  pool.style.height = phone() && poolH >= poolNeed ? "" : Math.max(60, poolH) + "px";
  if (poolH < poolNeed) pool.parentElement.classList.add("scrolls");
  pool.parentElement.querySelector(".gm-more").hidden = !(poolH < poolNeed) || pool.scrollTop + pool.clientHeight >= pool.scrollHeight - 4;
  const below = node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; // the box's edge under the list
  const room = innerHeight - dock - (list.getBoundingClientRect().top + pageY()) - below - 12;
  // the top stays put; the box is only as tall as its tracks need (up to its full size)
  list.style.height = Math.max(phone() ? 120 : 60, Math.min(phone() ? room : Math.min(listH - frame, room), list.scrollHeight)) + "px";
  const over = (INNER_SCROLL ? document.body.scrollHeight : document.documentElement.scrollHeight) - innerHeight;
  if (over > 0) list.style.height = Math.max(120, list.getBoundingClientRect().height - over) + "px"; // the page itself doesn't scroll
}
addEventListener("resize", () => fitMix());
/* boxes with more tracks above or below fade out at that edge (Genres playlist: only at the bottom) */
function updateFade(list) {
  if (!list) return;
  let up, down;
  if (list.classList.contains("scroll-list")) {
    up = list.scrollTop > 2 && !list.classList.contains("gm-list");
    down = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
  } else { // a search result showing a few tracks of its thread
    const th = list.closest(".thread"), ks = [...list.querySelectorAll(":scope > li.track")].map((r) => +r.dataset.k.split(":").pop());
    const n = th ? shown.find((x) => "th-" + x.t.id === th.id)?.t.tracks.length || 0 : 0;
    up = ks.length && ks[0] > 1; down = ks.length && ks[ks.length - 1] < n - 1;
  }
  list.classList.toggle("fade-up", !!up); list.classList.toggle("fade-down", !!down);
}
document.addEventListener("scroll", (e) => { if (e.target.classList && e.target.classList.contains("scroll-list")) updateFade(e.target); }, { passive: true, capture: true });
const fadeAll = () => { document.querySelectorAll("#threads .scroll-list, #threads .thread.searching .tracks").forEach(updateFade); placeMidPos(); };
function placeMidPos() {
  document.querySelectorAll("#threads .thread .mid-pos").forEach((p) => {
    const th = p.closest(".thread"), list = th.querySelector(".tracks");
    if (!list) return;
    const mid = list.getBoundingClientRect().top + list.getBoundingClientRect().height / 2 - th.getBoundingClientRect().top;
    p.style.top = mid - p.offsetHeight / 2 + "px";
  });
}
addEventListener("resize", placeMidPos);

/* History: every thread by the month it was posted, newest first, as short rows */
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const postDate = (t) => t.tracks[0].shown_date || t.tracks[0].date || "";
function historyMonths() {
  const by = new Map();
  for (const t of threads.filter(isBase)) { const m = postDate(t).slice(0, 7); if (m) (by.get(m) || by.set(m, []).get(m)).push(t); }
  return [...by].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([m, list]) => ({
    id: "m-" + m, kind: "month", month: m, threads: list.sort((a, b) => (postDate(a) < postDate(b) ? 1 : -1)) }));
}
/* History thumbnails: always on; − and + change their size (remembered) */
const THUMB_SIZES = [[32, 18], [44, 25], [56, 32], [72, 40], [96, 54]];
let thumbSize = (() => { try { const v = +localStorage.getItem("nrgfm-thumb-size"); return Number.isFinite(v) && localStorage.getItem("nrgfm-thumb-size") !== null ? v : 1; } catch { return 1; } })();
function setThumbSize() {
  const [w, h] = THUMB_SIZES[thumbSize] || THUMB_SIZES[1];
  document.documentElement.style.setProperty("--mini-w", w + "px"); document.documentElement.style.setProperty("--mini-h", h + "px");
  try { localStorage.setItem("nrgfm-thumb-size", thumbSize); } catch {}
}
setThumbSize();
document.body.classList.add("hist-thumbs-on");
function monthNode({ t }) {
  const [y, mo] = t.month.split("-");
  return el("li", { class: "month", id: "th-" + t.id },
    el("h2", { class: "month-name" }, `${MONTHS[+mo - 1]} ${y}`, el("span", { class: "month-count" }, ` · ${t.threads.length} ${t.threads.length === 1 ? "post" : "posts"}`)),
    el("ol", { class: "month-list" }, t.threads.map((th) => {
      const x = info(th.tracks[0]), n = th.tracks.length;
      return el("li", { class: "month-row" + (x.dead ? " dead" : "") }, el("div", { class: "month-line", "data-k": `${th.id}:0` },
        el("button", { class: "when-link", title: "Go to the thread (" + fmtDay(postDate(th)) + ")", onclick: () => goToThread(th) }, fmtDay(postDate(th)).replace(/ \d{4}$/, "")),
        el("button", { class: "play month-play", onclick: () => play(th, 0), "aria-label": `Play ${x.title}` }, img(x.thumb, "mini"), el("span", { class: "tr-title" }, x.title)),
        n > 1 ? el("button", { class: "when-link month-n", "aria-expanded": "false", title: "Show the tracks",
          onclick: (e) => { const box = e.currentTarget.closest(".month-row").querySelector(".month-tracks"), open = box.hidden;
            box.hidden = !open; e.currentTarget.setAttribute("aria-expanded", String(open)); } }, `${n} tracks`) : el("span", { class: "month-n" })),
        n > 1 ? el("ol", { class: "month-tracks", hidden: true }, th.tracks.slice(1).map((tr, k) => {
          const y = info(tr);
          return el("li", { class: y.dead ? "dead" : "", "data-k": `${th.id}:${k + 1}` },
            el("button", { class: "play month-play", onclick: () => play(th, k + 1), "aria-label": `Play ${y.title}` }, img(y.thumb, "mini"), el("span", { class: "tr-title" }, y.title)));
        })) : null);
    })));
}
/* the genre index: the biggest 40, "all 263 genres" shows the rest */
function genreIndex(items, limit) {
  const box = el("div", { class: "genre-index" },
    items.slice(0, limit).flatMap((g) => [el("button", { class: "when-link", onclick: () => jumpTo(g.id) }, g.name, el("span", { class: "gi-n" }, g.tracks.length)), " "]),
    items.length > limit ? el("button", { class: "more-toggle gi-all", onclick: () => box.replaceWith(genreIndex(items, Infinity)) }, `all ${items.length} genres`) : null);
  return box;
}
function drawViewHead() {
  const head = $("#viewHead");
  head.className = "view-head view-" + view;
  if (view === "genres") {
    head.replaceChildren(genrePicker(true)); // on a computer the cursor waits in the genre field
  } else if (view === "genreboxes") {
    const items = shown.map((x) => x.t);
    head.replaceChildren(
      genreIndex(items, 40));
  } else if (view === "mixes") {
    if (!shown.length) { head.hidden = true; return; }
    head.replaceChildren(el("p", { class: "view-note" }, "Tracks ticked as Mix in the edit card, grouped by their other tags."));
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
    const size = (d) => { thumbSize = Math.max(0, Math.min(THUMB_SIZES.length - 1, thumbSize + d)); setThumbSize(); };
    const thumbsBtn = el("span", { class: "hist-size" },
      el("button", { class: "when-link", title: "Smaller thumbnails", onclick: () => size(-1) }, "−"),
      el("button", { class: "when-link", title: "Bigger thumbnails", onclick: () => size(1) }, "+"));
    head.replaceChildren(
      el("div", { class: "hist-years" }, years.map((y) => el("button", { class: "when-link", onclick: () => { pickYear(y); jumpTo(months.find((m) => m.month.startsWith(y)).id); } }, y))),
      el("div", { class: "hist-months-row" }, monthRow, thumbsBtn));
    head._pickYear = pickYear;
    if (years.length) pickYear(years[0]);
  } else if (view === "tags") {
    head.hidden = true; return;
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
  holdAt(node, () => contentTop() + 8);
}
/* uBlock Origin Lite for this browser (iPhone/iPad and Safari: the App Store app) */
function ublockUrl() {
  const ua = navigator.userAgent, apple = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const url = /Firefox|FxiOS/.test(ua) && !apple ? "https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/"
    : apple || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) ? "https://apps.apple.com/de/app/ublock-origin-lite/id6745342698"
    : "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh?hl=en";
  return url;
}
const openUblock = () => open(ublockUrl(), "_blank", "noopener");
$('#menu [data-view="ublock"]').href = ublockUrl();
function setView(v, keepHash) {
  setTimeout(() => (document.body.dataset.view = view), 0);
  if (v === "ublock") { // first press: "Confirm"; the second opens the store
    const b = $('#menu [data-view="ublock"]');
    if (b.dataset.confirm) { clearTimeout(b._t); delete b.dataset.confirm; b.textContent = "uBlock Origin Lite"; openUblock(); }
    else { b.style.minWidth = b.getBoundingClientRect().width + "px"; b.dataset.confirm = "1"; b.textContent = "Confirm"; b._t = setTimeout(() => { delete b.dataset.confirm; b.textContent = "uBlock Origin Lite"; }, 5000); }
    return;
  }
  if (v === "random") { // a random thread, at the top of the page with the divider above it still in view
    const b = $('#menu [data-view="random"]'); b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 350);
    const menuH = $("#menu").hidden ? 0 : $("#menu").getBoundingClientRect().height; // the open menu covers the top
    const base = threads.filter(isBase); goToThread(base[Math.floor(Math.random() * base.length)], 22 + menuH); return;
  }
  view = VIEW_NAMES[v] ? v : "threads";
  if (!keepHash) history.replaceState(null, "", view === "threads" ? location.pathname : "#/" + view);
  document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view)));
  $("#q").value = ""; syncClear();
  runSearch(); pageScrollTo(0);
}
function toggleMenu(open = $("#menu").hidden) {
  if (open && !$("#addPanel").hidden) closeAddForm($("#addPanel").querySelector("form"));
  $("#menu").hidden = !open; $("#home").setAttribute("aria-expanded", String(open));
  document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px");
}
addEventListener("hashchange", () => { // back/forward and links between pages
  const page = location.hash.match(/^#\/(\w+)/);
  if (page && VIEW_NAMES[page[1]] && page[1] !== view) setView(page[1], true);
  else if (!location.hash && view !== "threads") setView("threads", true);
});
$("#menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (!b) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; // Ctrl/Cmd+click: the browser opens it in a new tab
  e.preventDefault();
  if (VIEW_NAMES[b.dataset.view] || (phone() && b.dataset.view === "random")) toggleMenu(false); // a page closes the menu (phone: Random too)
  setView(b.dataset.view);
});
/* scrolling the page closes the menu; the page is moved back by the menu's height, so nothing jumps */
function closeMenuByScroll() {
  if ($("#menu").hidden) return;
  const h = $(".top").getBoundingClientRect().height;
  toggleMenu(false);
  const dh = h - $(".top").getBoundingClientRect().height;
  if (dh > 0) pageScrollBy(-dh);
}
addEventListener("wheel", (e) => { if (!e.target.closest(".top")) closeMenuByScroll(); }, { passive: true });
addEventListener("touchmove", (e) => { if (!e.target.closest(".top")) closeMenuByScroll(); }, { passive: true });

/* ---------- rendering: every thread is shown open ---------- */
const img = (src, cls) => src
  ? el("img", { class: cls, src, alt: "", loading: "lazy", decoding: "async", onerror: (e) => e.target.classList.add("broken") })
  : el("span", { class: cls + " empty" });

/* tags under a title; clicking one searches for it */
const HIDDEN_TAGS = new Set(); // (none now: "mix" is an ordinary tag again)
const shownTags = (tr) => Object.keys(tr.tags || {}).filter((g) => !HIDDEN_TAGS.has(g));
function tagLine(tr, extra, list) {
  const tags = list || shownTags(tr);
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
      el("span", { class: "tr-sub" }, tagLine(tr, x.recovered ? RECOVERED : null, t.mix ? genresOf(tr) : null))),
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
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) document.documentElement.classList.add("ios");
if (window.matchMedia("(max-width: 400px)").matches) $("#q").placeholder = "Artist, title or tag"; // small phones: it all fits
const scroller = () => (INNER_SCROLL ? document.body : window);
const pageScrollBy = (y, smooth) => scroller().scrollBy({ top: y, behavior: smooth ? "smooth" : "auto" });
const pageScrollTo = (y) => scroller().scrollTo({ top: y, behavior: "auto" });
const pageY = () => (INNER_SCROLL ? document.body.scrollTop : scrollY);
/* keep a node at a spot under the header while things above it settle: the position is set absolutely each frame
   (never added to), and it stops once it has stayed put for a few frames */
function holdAt(node, offset) {
  let frames = 0, still = 0;
  const step = () => {
    if (!node.isConnected) return;
    const dy = node.getBoundingClientRect().top - offset();
    if (Math.abs(dy) > 1) { pageScrollTo(pageY() + dy); still = 0; } else still++;
    if (++frames < 90 && still < 8) requestAnimationFrame(step);
  };
  step();
}
/* bring an element fully into view (between the header and the player), moving as little as possible */
function revealWhole(node, smooth = true) {
  const r = node.getBoundingClientRect(), top = headerBottom() + 8;
  const bottom = innerHeight - (dockH()) - 8;
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
    // the first track on screen stays where it is when the box starts scrolling (no jump)
    const oldTop = old ? old.getBoundingClientRect().top : 0;
    const first = old && [...old.querySelectorAll(":scope > li.track")].find((r) => r.getBoundingClientRect().bottom > oldTop + 2);
    const firstK = first && first.dataset.k, firstAt = first ? first.getBoundingClientRect().top - oldTop : 0;
    const fresh = rerenderKeep(entry.t, entry.hits);
    if (fresh) fitList(fresh);
    const same = x === id && firstK && fresh && fresh.querySelector(`.scroll-list [data-k="${CSS.escape(firstK)}"]`);
    if (same) { const box = same.closest(".scroll-list"); box.dataset.centred = "1"; box.scrollTop += same.getBoundingClientRect().top - box.getBoundingClientRect().top - firstAt; }
    const row = x === id && clickedK && fresh && fresh.querySelector(`.scroll-list [data-k="${CSS.escape(clickedK)}"]`);
    if (row) { const box = row.closest(".scroll-list"); if (row.offsetTop < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop; }
  }  requestAnimationFrame(fadeAll); // the fades come back when a result is unselected again
}
const selectable = (th) => !th.classList.contains("genre-mix") && (th.querySelector(".scroll-list") || (th.classList.contains("searching") && th.querySelector(".tracks")));
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
  if (!box || box.closest(".thread").classList.contains("active") || box.querySelector(".edit-wrap") || box.closest(".genre-mix")) return; // selected, editing in it, or the Genres playlist
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
  if (!wasOpen && hits && phone()) { // phone search: the whole thread, its main track at the top
    pageScrollBy(fresh.getBoundingClientRect().top - headerBottom() - 8);
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
  const at = (h) => h.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop; // inside the box
  const cur = +(list.dataset.match ?? -1);
  const k = cur >= 0 && cur < hs.length - 1 ? cur + 1 : 0; // each press: the next match, then round again
  const next = hs[k];
  if (!next) return;
  list.dataset.match = k;
  list.scrollTo({ top: Math.max(0, at(next) - (list.clientHeight - next.offsetHeight) / 2), behavior: "smooth" }); // in the middle of the box
  hs.forEach((h) => h.classList.toggle("match-now", h === next));
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
  requestAnimationFrame(() => updateFade(list));
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
  const dock = dockH();
  const below = () => node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom; // Collapse, Add a track…
  const size = () => {
    const h = Math.max(200, innerHeight - dock - GAP - list.getBoundingClientRect().top - below()) + "px";
    list.style.maxHeight = h;
    if (node.classList.contains("tag-thread")) list.style.minHeight = h; // a playlist fills the screen even with few tracks
  };
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
new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", $(".top").getBoundingClientRect().height + "px")).observe($(".top"));

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
  if (t.mix) return genreMixNode(t);
  if (t.kind === "tag") return tagThreadNode({ t, hits });
  const n = t.tracks.length, limit = threadLimit(), mobile = phone();
  const long = n > limit, open = expanded.has(t.id) && (long || !!hits);
  const searching = !!hits && !open && n - 1 > SEARCH_AROUND; // results: hits with a few tracks around them
  const scrolling = searching && activeId === t.id; // selected: the whole thread in a box that scrolls
  const peek = new Set();
  let idx, listCls = "tracks", show = long ? TAG_PREVIEW : limit - 1; // long threads show 5, like tags
  const addingHere = addingId === t.id && !hits && !long && n - 1 > TAG_PREVIEW; // adding a track here: 5 replies in a box
  if (addingHere) { idx = range(1, n); listCls += " scroll-list"; show = TAG_PREVIEW; }
  else if (open && hits && mobile) { idx = range(1, n); }                     // phone search: the whole thread
  else if (open && long) { idx = range(1, n); listCls += " scroll-list open"; } // fills the window, scrolls inside
  else if (open) { idx = range(1, n); }                                 // short thread: simply all of it
  else if (scrolling) { idx = range(1, n); listCls += " scroll-list"; show = SEARCH_AROUND; }
  else if (searching) { // a slice of the track before and after peeks out under the fades: there is more
    idx = searchRows(t, hits);
  }
  else if (searching) { idx = fixedRows.get(t.id) || searchRows(t, hits); }
  else if (long && !mobile) { idx = range(1, n); listCls += " scroll-list"; }
  else if (long) { idx = range(1, 1 + TAG_PREVIEW); }
  else { idx = range(1, n); }
  const head = t.tracks[0], hi = info(head);
  const core = idx.filter((i) => !peek.has(i)); // the peeking slices don't count
  const lo = core.length ? core[0] + 1 : 1, hiIdx = core.length ? core[core.length - 1] + 1 : 1;
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
    if (searching) foot = el("div", { class: "search-foot" }, pos(),
      el("button", { class: "more-toggle scroll-link" + (scrolling ? " on" : ""), onclick: (e) => { e.stopPropagation(); setActive(scrolling ? null : t.id); } }, "Scroll"),
      expandBtn("foot-right"));
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
    n > 1 ? el("ol", { class: listCls, "data-show": show }, idx.map((i) => { const row = trackRow(t, t.tracks[i], i, hits); if (peek.has(i)) row.classList.add("peek"); return row; })) : null,
    foot, after,
    // search results (computer): "3 of 17" under the thumbnail, level with the middle of the tracks (placed by placeMidPos)
    hits && !mobile && (searching || scrolling) ? el("span", { class: "more-pos mid-pos" }, posText) : null,
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
function goToThread(t, gap = 8) {
  $("#q").value = ""; syncClear(); $("#q").blur(); // (phone: the keyboard goes away first, so the page doesn't shift afterwards)
  if (view !== "threads") { view = "threads"; history.replaceState(null, "", location.pathname); document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === "threads"))); }
  expanded.delete(t.id);
  runSearch();
  const at = shown.findIndex((x) => x.t === t);
  if (at < 0) return;
  while (rendered <= at && rendered < shown.length) renderMore();
  const node = document.getElementById("th-" + t.id);
  if (!node) return;
  holdAt(node, () => headerBottom() + gap); // boxes above size themselves a moment later
}

function markPlaying() {
  document.querySelectorAll(".playing").forEach((n) => n.classList.remove("playing"));
  if (playing) document.querySelectorAll(`[data-k="${playing.thread.id}:${playing.index}"]`).forEach((n) => n.classList.add("playing"));
}

function renderMore(count = PAGE) {
  const frag = document.createDocumentFragment();
  const end = Math.min(shown.length, rendered + count);
  for (; rendered < end; rendered++) frag.append(threadNode(shown[rendered]));
  $("#threads").append(frag);
  markPlaying();
  requestAnimationFrame(fadeAll);
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
    setVolume: (v) => { if (yt.ready) { yt.player.setVolume(v); v > 0 ? yt.player.unMute() : yt.player.mute(); } },
    destroy: () => { yt.active = false; try { yt.ready && yt.player.pauseVideo(); } catch {} ytSlot().hidden = true; },
  };
  if (yt.ready) {
    // load straight away, inside the click, so the browser still counts it as the person's action
    yt.player.loadVideoById(tr.yt);
    try { yt.player.setVolume(volume); volume ? yt.player.unMute() : yt.player.mute(); } catch {}
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
          try { yt.player.setVolume(volume); if (!volume) yt.player.mute(); } catch {}
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
  if (t.mix && !autoplay) { autoplay = true; $("#autoBtn").setAttribute("aria-pressed", "true"); $("#autoBtn").textContent = "Autoplay on"; } // a Genres playlist plays on
  const pn = document.getElementById("th-" + t.id);
  // the thread you play from gets the selected frame (in search results only the ones that scroll)
  if (pn && activeId !== t.id && !addingId && selectable(pn)) setActive(t.id, `${t.id}:${i}`); // only boxes that scroll
  const token = ++loadToken;
  const tr = t.tracks[i], x = info(tr), m = meta[tr.url] || {};
  if (adapter) adapter.destroy();
  adapter = null;
  const box = $("#otherSlot"); box.replaceChildren();
  const dock = $("#dock"); dock.hidden = false; dock.classList.remove("idle");
  $("#infoBtn").disabled = $("#copyBtn").disabled = false;
  if (!lockPlayerWidths.done) { lockPlayerWidths(); lockPlayerWidths.done = true; }
  $("#nowTitle").textContent = x.title;
  $("#dock").classList.remove("wide"); // a new track: the buttons come back
  showFlag();
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
      ? "This track was deleted."
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
    box.append(el("p", { class: "nolink" }, `${PLATFORM[tr.platform] || "These"} links can't play in the player.`));
  }
  $("#media").dataset.kind = kind;
  const controllable = !!(adapter && adapter.controllable);
  $("#dock").classList.toggle("no-transport", !controllable);
  $("#playBtn").disabled = !controllable; $("#seek").disabled = !controllable; $("#volBtn").disabled = !controllable;
  if (!controllable) closeVol();
  if (adapter) adapter.ready.catch(() => {
    if (token !== loadToken) return;
    ytSlot().hidden = true;
    box.replaceChildren(el("p", { class: "nolink" }, "The player didn't load."));
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
function closeVol() { $("#volWrap").classList.remove("open"); $("#volBtn").setAttribute("aria-expanded", "false"); }
const speaker = (v) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  n.setAttribute("viewBox", "0 0 16 16"); n.setAttribute("class", "spk"); n.setAttribute("aria-hidden", "true");
  n.innerHTML = '<path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor"/>' +
    (v === 0 ? '<path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.4" fill="none"/>'
      : '<path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.4" fill="none"/>' + (v > 50 ? '<path d="M12.8 3.5a6 6 0 0 1 0 9" stroke="currentColor" stroke-width="1.4" fill="none"/>' : ""));
  return n;
};
function showVolume() {
  $("#vol").value = volume; $("#volVal").textContent = volume;
  $("#vol").style.setProperty("--p", volume + "%");
  $("#volBtn").replaceChildren(speaker(volume), el("span", { class: "vol-n" }, volume)); // the button shows the volume
  $("#volBtn").classList.toggle("muted", volume === 0);
}
showVolume();
$("#volBtn").onclick = (e) => {
  e.stopPropagation();
  const open = !$("#volWrap").classList.contains("open"); // the slider slides out to the left of the number
  $("#volWrap").classList.toggle("open", open); $("#volBtn").setAttribute("aria-expanded", open ? "true" : "false");
};
$("#volPop").addEventListener("click", (e) => e.stopPropagation());
/* computer: resting the pointer on the volume opens the slider. Opened that way, it stays open while the pointer
   is on the volume or the slider and closes 0.5 s after the pointer leaves them (Nielsen Norman Group's advice for
   content shown on hover: wait about 0.5 s after the pointer leaves, so a slightly wobbly move doesn't close it). */
if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
  let volTimer = 0, byHover = false;
  const wrap = $("#volWrap");
  wrap.addEventListener("mouseenter", () => {
    clearTimeout(volTimer);
    if ($("#volBtn").disabled || wrap.classList.contains("open")) return;
    byHover = true; wrap.classList.add("open"); $("#volBtn").setAttribute("aria-expanded", "true");
  });
  const later = () => { clearTimeout(volTimer); volTimer = setTimeout(() => { byHover = false; closeVol(); }, 500); };
  wrap.addEventListener("mouseleave", (e) => { if (byHover && wrap.classList.contains("open") && !e.buttons) later(); }); // not while dragging the slider
  document.addEventListener("mouseup", (e) => { if (byHover && wrap.classList.contains("open") && !wrap.contains(e.target) && !wrap.matches(":hover")) later(); });
  $("#volBtn").addEventListener("click", (e) => { // a click while it is open from hovering keeps it open (no timer)
    if (!byHover) return;
    byHover = false; clearTimeout(volTimer); e.stopImmediatePropagation();
  }, true);
}
$("#volNum").onclick = (e) => $("#volBtn").onclick(e);
document.addEventListener("click", closeVol);
$("#vol").addEventListener("input", () => {
  volume = +$("#vol").value; showVolume();
  adapter && adapter.setVolume(volume);
  try { localStorage.setItem("nrgfm-volume", String(volume)); } catch {}
});

/* buttons whose text changes keep the width of their longest text, so the row doesn't move */
function lockWidth(btn, texts) {
  const was = btn.textContent;
  btn.style.minWidth = Math.ceil(Math.max(...texts.map((t) => { btn.textContent = t; return btn.getBoundingClientRect().width; }))) + "px";
  btn.textContent = was;
}
const lockPlayerWidths = () => {
  lockWidth($("#autoBtn"), ["Autoplay off", "Autoplay on"]);
  lockWidth($("#infoBtn"), ["Copy info", "Copied"]); lockWidth($("#copyBtn"), ["Copy link", "Copied"]);
};
/* a title too long for the player: click it and Autoplay and the Copy buttons step aside to make room
   (click again, or the next track, brings them back) */
$("#nowTitle").onclick = () => {
  const t = $("#nowTitle"), d = $("#dock");
  if (d.classList.contains("wide") || t.scrollWidth > t.clientWidth + 1) d.classList.toggle("wide");
};
$("#autoBtn").onclick = () => {
  autoplay = !autoplay;
  $("#autoBtn").setAttribute("aria-pressed", autoplay ? "true" : "false");
  $("#autoBtn").textContent = autoplay ? "Autoplay on" : "Autoplay off";
};



/* keep the end of the list reachable above the dock */
/* The × first unloads the track (the video goes, the bar stays, empty); pressed again on the empty bar it closes
   the bar. On a computer the empty bar is there from the start, so the volume can be set before anything plays. */
function idleDock() {
  const d = $("#dock");
  d.hidden = false; d.classList.add("idle"); d.classList.remove("wide", "no-transport");
  $("#media").dataset.kind = "";
  $("#nowTitle").textContent = ""; closeThread();
  setPlayState(false); setTime(0, 0);
  for (const b of ["#prevBtn", "#playBtn", "#nextBtn", "#seek", "#infoBtn", "#copyBtn"]) $(b).disabled = true;
  $("#volBtn").disabled = false;
  if (!lockPlayerWidths.done) { lockPlayerWidths(); lockPlayerWidths.done = true; }
  syncDockSpace();
}
function closeDock() {
  const loaded = !!playing;
  try { adapter && adapter.pause(); } catch {}
  if (adapter) adapter.destroy();
  adapter = null;
  ytSlot().hidden = true;
  $("#otherSlot").replaceChildren();
  playing = null;
  setPlayState(false);
  markPlaying();
  if (loaded) { idleDock(); return; }
  closeVol();
  $("#dock").hidden = true;
  syncDockSpace();
}
$("#closeBtn").onclick = closeDock;

function syncDockSpace() {
  const d = $("#dock");
  document.body.style.setProperty("--dock-h", d.hidden ? "0px" : d.offsetHeight + "px");
  fitMix();
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
/* The tag field: added tags sit inside the field as small boxes (× removes one); typing shows matching tags,
   and suggested tags (the main track's) show with a dotted outline, in a list that opens over the page below
   the field, so nothing moves. */
function tagEditor(initial, suggested = []) {
  const chosen = [...initial];
  const input = el("input", { type: "text", class: "tag-input", placeholder: "Add tag", autocomplete: "off", spellcheck: "false", "aria-label": "Add tag" });
  const chips = el("span", { class: "tag-chips-in" });
  const field = el("span", { class: "tag-field", onmousedown: (e) => { if (e.target === field || e.target === chips) { e.preventDefault(); input.focus(); } } }, chips, input);
  const drop = el("div", { class: "tag-drop", hidden: true });
  let opts = [], active = 0;
  const remove = (g) => { chosen.splice(chosen.indexOf(g), 1); drawChips(); drawDrop(); input.focus(); };
  const drawChips = () => {
    chips.replaceChildren(...chosen.map((g) => el("button", { type: "button", class: "tag-chip in", title: "Remove tag",
      onmousedown: (e) => e.preventDefault(), onclick: () => remove(g) }, g, el("span", { class: "x", "aria-hidden": "true" }, " ×"))));
    input.placeholder = chosen.length ? "" : "Add tag";
    field.scrollLeft = field.scrollWidth;
  };
  const drawDrop = () => {
    const q = fold(input.value);
    const sug = suggested.filter((g) => !chosen.includes(g) && (!q || fold(g).includes(q)));
    opts = q ? allTags().filter((g) => !chosen.includes(g) && !sug.includes(g) && fold(g).includes(q))
      .sort((a, b) => fold(b).startsWith(q) - fold(a).startsWith(q)).slice(0, 6) : [];
    active = 0;
    const parts = [];
    if (sug.length) parts.push(el("div", { class: "drop-sug" }, sug.map((g) => el("button", { type: "button", class: "tag-chip suggest", title: "Use this tag",
      onmousedown: (e) => { e.preventDefault(); add(g); } }, "+ " + g))));
    if (opts.length) parts.push(el("ul", { class: "drop-list" }, opts.map((g, k) => el("li", { class: k === active ? "on" : "", onmousedown: (e) => { e.preventDefault(); add(g); } }, g))));
    drop.replaceChildren(...parts);
    drop.hidden = !parts.length || document.activeElement !== input;
  };
  const add = (g) => { g = normTag(g); if (g && !chosen.includes(g)) chosen.push(g); input.value = ""; drawChips(); drawDrop(); input.focus(); };
  input.addEventListener("input", drawDrop);
  input.addEventListener("focus", drawDrop);
  input.addEventListener("blur", () => setTimeout(() => (drop.hidden = true), 100));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.shiftKey) return; // Shift+Enter saves the card (handled by the form)
    const items = [...drop.querySelectorAll(".drop-list li")];
    if (e.key === "Enter" || (e.key === "," && input.value.trim())) {
      e.preventDefault();
      if (!drop.hidden && opts[active] && input.value.trim()) add(opts[active]); else if (input.value.trim()) add(input.value);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (drop.hidden || !items.length) return; e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
      items.forEach((li, k) => li.classList.toggle("on", k === active));
    } else if (e.key === "Escape" && !drop.hidden) { e.stopPropagation(); drop.hidden = true; }
    else if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); drawChips(); drawDrop(); }
  });
  drawChips();
  return {
    box: el("span", { class: "tag-area" }, el("span", { class: "tag-box" }, field, drop)),
    input,
    use: (g) => { g = normTag(g); if (g && !chosen.includes(g)) { chosen.push(g); drawChips(); } },
    has: (g) => chosen.includes(normTag(g)),
    drop: (g) => { const k = chosen.indexOf(normTag(g)); if (k > -1) { chosen.splice(k, 1); drawChips(); } },
    get: () => { if (input.value.trim()) add(input.value); return [...chosen]; }, // a typed but not yet added tag counts too
    restore: () => {},
  };
}

function addForm(thread, edit, row) {
  // edit = { t, i } when editing an existing track; row = that track's row (its tags become removable)
  const tr = edit ? edit.t.tracks[edit.i] : null;
  const host = row ? row.querySelector(".tag-wrap") : null;
  const tags = tagEditor(tr ? shownTags(tr) : [], !tr && thread ? shownTags(thread.tracks[0]) : []);
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
    el("div", { class: "af-field" },
      el("input", { name: "title", type: "text", "aria-label": "Title", placeholder: "Artist – Track (optional, filled in automatically)" })),
    el("div", { class: "af-field" },
      el("input", { name: "url", type: "url", required: true, "aria-label": "Link", placeholder: "YouTube, SoundCloud, Bandcamp or Vimeo link" })),
    el("div", { class: "af-actions" },
      tags.box,
      el("span", { class: "af-gap" }),

      edit ? arrow : null,
      el("span", { class: "af-msg hint", role: "status" }),
      edit ? el("button", { type: "button", class: "btn ghost danger", onclick: (e) => deleteTrack(form, edit, e.currentTarget) }, "Delete") : null,
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
    el("div", { class: "af-field" }, el("span", {}, "Notes"),
      el("div", { class: "notes-row" }, notes, edit && edit.t.tracks.length > 1 ? el("div", { class: "order-btns" },
        orderBtn(true, () => reorderTrack(box.closest("form"), edit, -1), edit.i === 0),
        orderBtn(false, () => reorderTrack(box.closest("form"), edit, 1), edit.i === edit.t.tracks.length - 1)) : null)),
    edit ? movePanel(() => box.closest("form"), edit) : null);
  if (edit && edit.i === 0) {
    const date = el("input", { name: "date", type: "hidden" }); // YYYY-MM-DD, sent with Save
    date.value = tr.shown_date || tr.date;
    const shown = el("button", { type: "button", class: "rel-name date-name" });
    const showDate = () => shown.replaceChildren(fmtDay(date.value));
    const typeDate = () => { // the date in numbers: 18.10.2026 (or 2026-10-18)
      const [y, m, d] = date.value.split("-");
      const input = el("input", { type: "text", class: "rel-input", value: `${+d}.${+m}.${y}`, size: 11, inputmode: "numeric", "aria-label": "Posted" });
      let finished = false;
      const done = (keep) => {
        if (finished) return; finished = true;
        if (keep) {
          const v = input.value.trim(), a = v.match(/^(\d{1,2})[.\/ -](\d{1,2})[.\/ -](\d{4})$/), b = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
          const [yy, mm, dd] = a ? [a[3], a[2], a[1]] : b ? [b[1], b[2], b[3]] : [];
          const iso = yy && `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
          if (iso && !isNaN(Date.parse(iso + "T12:00:00Z"))) { date.value = iso; pos = null; note.textContent = ""; }
        }
        input.replaceWith(shown); showDate();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      input.addEventListener("blur", () => done(true));
      shown.replaceWith(input); input.focus(); input.select();
    };
    shown.onclick = typeDate;
    showDate();
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
      date.value = new Date(pos * 1000).toISOString().slice(0, 10); showDate();
      note.textContent = (up ? "above " : "below ") + info(next.tracks[0]).title;
    };
    box.feedPos = () => pos;
    box.append(el("div", { class: "af-sug af-date" }, el("span", { class: "af-label" }, "Posted"), date, shown,
      tr.shown_date ? el("span", { class: "hint" }, `(originally ${fmtDay(tr.date)})`) : null,
      stepBtn(true, step), stepBtn(false, step), note));
  }
  if (tr) {
    const sug = el("div", { class: "af-sug" });
    const chips = () => sug.replaceChildren(
      el("span", { class: "af-label" }, "Suggested genres"),
      ...(x.g && x.g.length
        ? x.g.map((g) => tags.has(g) ? null : el("button", { type: "button", class: "tag-chip suggest", onclick: () => { tags.use(g); chips(); } }, "+ " + g))
        : [el("span", { class: "hint" }, x.chk ? "none found" : "not looked up yet")]).filter(Boolean));
    chips();
    box.append(sug,
      el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested release"), releaseEditor(tr, x, box)),
      el("div", { class: "af-sug" }, el("span", { class: "af-label" }, "Suggested year"),
        yearEditor(tr, x, box),
        x.ys && x.ys.length ? el("span", { class: "hint" }, "(also " + x.ys.join(", ") + ")") : null,
        x.src ? el("span", { class: "hint" }, "from " + x.src.split("+").join(", ") + (x.conf ? ", " + x.conf + " confidence" : "")) : null));
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
const mixTags = (form) => form.tags.get(); // ("mix" is an ordinary tag: the Mixes page shows tracks tagged "mix")
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
  if (!$("#menu").hidden) toggleMenu(false); // stays on this page
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
  const box = wrap.closest(".scroll-list");
  form.title.focus({ preventScroll: true }); // start in the title
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
  const fromThread = form.closest(".thread") ? form.closest(".thread").id.slice(3) : t.id; // where the track was edited (a tag thread or its own)
  const url = form.url.value.trim(), title = form.title.value.trim();
  if (!LINK_RE.test(url)) {
    form.url.setCustomValidity("Use a YouTube, SoundCloud, Bandcamp, Vimeo or Mixcloud link.");
    form.url.reportValidity();
    return;
  }
  const item = { action: "edit", thread: t.id, id: tr.id, title, url, tags: mixTags(form), ts: Math.floor(Date.now() / 1000) };
  if (url !== tr.url) item.tags = item.tags.filter((g) => g !== "broken link" && g !== "plays on youtube only"); // a new link: those tags go
  const notes = form.notes.value.trim();
  if (notes !== (tr.notes || "")) item.notes = notes;
  const rel = form.querySelector(".af-more")?.releaseChanged?.();
  if (rel) item.release = rel;
  const yr = form.querySelector(".af-more")?.yearChanged?.();
  if (yr !== undefined) item.year = yr;
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
  if (item.release) tr.release = item.release;
  if ("year" in item) { tr.year = item.year; setYear(tr); }
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
  refreshHistory();
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

/* up / down in the thread (from the second place, up makes it the main post) */
function orderBtn(up, fn, disabled) {
  const b = el("button", { type: "button", class: "btn ghost order-btn", "aria-label": up ? "Up in the thread" : "Down in the thread", disabled: disabled || null, onclick: fn });
  b.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${up ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  return b;
}
async function reorderTrack(form, { t, i }, d) {
  const to = i + d, tr = t.tracks[i], playTr = playing && playing.thread === t ? t.tracks[playing.index] : null;
  if (to < 0 || to >= t.tracks.length) return;
  const msg = form.querySelector(".af-msg");
  try { await writeInbox({ action: "reorder", thread: t.id, id: tr.id, to, ts: Math.floor(Date.now() / 1000) }, "reorder"); }
  catch (e) { msg.textContent = netMsg(e); return; }
  t.tracks.splice(i, 1); t.tracks.splice(to, 0, tr);
  t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  if (playTr) playing.index = t.tracks.indexOf(playTr);
  closeAddForm(form, { quiet: true });
  rerenderThread(t, to); markPlaying();
  // the card opens again on the track, with the extended part open
  const row = document.querySelector(`.track[data-k="${CSS.escape(t.id)}:${to}"], .head-row[data-k="${CSS.escape(t.id)}:${to}"]`);
  if (row) { toggleEditForm(t, to, row); row.nextElementSibling?.querySelector(".more-info-btn")?.click(); }
}
/* small thin arrows (one place up / down in the feed) */
function stepBtn(up, step) {
  const b = el("button", { type: "button", class: "date-step", "aria-label": up ? "Move up in the feed" : "Move down in the feed", onclick: () => step(up) });
  b.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${up ? "M6 10V2M2.5 5.5 6 2l3.5 3.5" : "M6 2v8M2.5 6.5 6 10l3.5-3.5"}" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
  return b;
}
/* the suggested releases, each with a dotted underline: click one to correct it (× deletes it); saved with the card */
function releaseEditor(tr, x, box) {
  const start = tr.release || x.rl || [], rel = [...start];
  const wrap = el("span", { class: "rel-list" });
  const draw = () => wrap.replaceChildren(...(rel.length ? rel.map((r, k) => {
    const item = el("span", { class: "rel-item" + (k ? " rel-other" : "") });
    const edit = () => {
      const input = el("input", { type: "text", class: "rel-input", value: r, size: Math.max(8, r.length + 2), "aria-label": "Release" });
      let finished = false;
      const done = (keep) => { if (finished) return; finished = true; if (keep) { const v = input.value.trim(); if (v) rel[k] = v; else rel.splice(k, 1); } draw(); };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
      input.addEventListener("blur", () => done(true));
      item.replaceChildren(input, el("button", { type: "button", class: "rel-x", "aria-label": "Delete this release",
        onmousedown: (e) => { e.preventDefault(); rel.splice(k, 1); draw(); } }, "×"));
      input.focus(); input.select();
    };
    item.append(el("button", { type: "button", class: "rel-name", onclick: edit }, r));
    return item;
  }) : [el("span", { class: "hint" }, start.length || tr.release ? "none" : x.chk && x.v >= 3 ? "none found" : "not looked up yet")]));
  draw();
  box.releaseChanged = () => (JSON.stringify(rel) !== JSON.stringify(start) ? [...rel] : undefined);
  return wrap;
}
/* the suggested year, clicked to change it (like the release); emptied it means "no year" */
function yearEditor(tr, x, box) {
  const start = x.y || 0;
  let year = start;
  const wrap = el("span", { class: "rel-list" });
  const draw = () => wrap.replaceChildren(el("span", { class: "rel-item" }, year
    ? el("button", { type: "button", class: "rel-name", onclick: edit }, String(year))
    : el("button", { type: "button", class: "rel-name rel-none", onclick: edit }, tr.year === 0 ? "none" : x.chk ? "none found" : "not looked up yet")));
  function edit() {
    const input = el("input", { type: "text", class: "rel-input", value: year || "", size: 6, inputmode: "numeric", maxlength: 4, "aria-label": "Year" });
    let finished = false;
    const done = (keep) => {
      if (finished) return; finished = true;
      if (keep) { const v = input.value.trim(), n = parseInt(v, 10); if (!v) year = 0; else if (/^\d{4}$/.test(v) && n >= 1900 && n <= new Date().getFullYear()) year = n; }
      draw();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.stopPropagation(); done(false); } });
    input.addEventListener("blur", () => done(true));
    wrap.replaceChildren(el("span", { class: "rel-item" }, input));
    input.focus(); input.select();
  }
  draw();
  box.yearChanged = () => (year !== start ? year : undefined);
  return wrap;
}
/* a year set by hand replaces the suggested one everywhere (search, decades, Genres); the suggestion stays as "also" */
function setYear(tr) {
  if (tr.year === undefined) return;
  const x = extra[tr.url] || (extra[tr.url] = {});
  if (x.y0 === undefined) x.y0 = x.y || null;
  x.y = tr.year || null;
  x.ys = [x.y0, ...(x.ys || [])].filter((y, k, all) => y && y !== x.y && all.indexOf(y) === k);
  tr._hay = null; gIndex = null;
}
function movePanel(formOf, edit) {
  const input = el("input", { type: "search", placeholder: "Search a track in the thread you want to move it to", autocomplete: "off", spellcheck: "false" });
  const list = el("ul", { class: "move-results" });
  // Promote (replies only): the track becomes its own thread, at the top of the feed or at its own date
  const promote = edit.i > 0 ? el("span", { class: "promote" }) : null;
  const drawPromote = (ask) => promote && promote.replaceChildren(
    ...(ask ? [] : [el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => drawPromote(true) }, "Promote")]),
    ...(ask ? [
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "main") }, "To the top"),
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "top") }, "Own thread (new)"),
      el("button", { type: "button", class: "btn ghost promote-btn", onclick: () => promoteTrack(formOf(), edit, "original") }, "Own thread (dated)")] : []));
  drawPromote(false);
  const panel = el("div", { class: "move-panel" }, el("span", { class: "af-label-line" }, "Move to the thread of…"),
    el("div", { class: "move-row" }, input, promote), list);
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
      if (found.length >= 3) break;
    }
    if (!found.length) { list.appendChild(el("li", { class: "move-none hint" }, "No other thread has a track like that.")); return; }
    for (const { t, k } of found) {
      const x = info(t.tracks[k]);
      list.appendChild(el("li", {},
        el("button", { type: "button", class: "move-hit", onclick: () => moveTrack(formOf(), edit, t) },
          el("span", { class: "mh-thumb" }, img(x.thumb, "thumb-img")),
          el("span", { class: "mh-text" },
            el("span", { class: "mh-title" }, x.title),
            el("span", { class: "mh-thread" }, "Thread: " + threadLabel(t) + ` (${t.tracks.length} ${t.tracks.length === 1 ? "track" : "tracks"})`)))));
    }
  });
  return panel;
}

async function promoteTrack(form, { t, i }, to) {
  const tr = t.tracks[i], ts = Math.floor(Date.now() / 1000);
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Promoting…";
  try { await writeInbox({ action: "promote", thread: t.id, id: tr.id, to, ts }, "promote"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (to === "main") { // the main post of its thread; the old one becomes the first reply
    t.tracks.unshift(t.tracks.splice(i, 1)[0]);
    t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
    closeAddForm(form, { quiet: true }); rerenderThread(t, 0); refreshHistory(); return;
  }
  // on screen right away: its own thread
  t.tracks.splice(i, 1);
  tr.main = true;
  const nt = { id: "x" + tr.id, kind: "thread", tracks: [tr], date: tr.date, ts: tr.ts };
  if (to === "top") { tr.shown_date = new Date(ts * 1000).toISOString().slice(0, 10); nt.pos_ts = ts; nt.pos_set = ts; }
  threads.push(nt); sortThreads();
  closeAddForm(form, { quiet: true });
  rerenderThread(t, null);
  if (view === "threads" && !$("#q").value.trim() && to === "top") { $("#threads").prepend(threadNode({ t: nt, hits: null })); shown.unshift({ t: nt, hits: null }); rendered++; }
  refreshHistory();
}
async function moveTrack(form, { t, i }, dest) {
  const tr = t.tracks[i];
  const msg = form.querySelector(".af-msg"), btns = form.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true)); msg.textContent = "Moving…"; msg.textContent = "";
  try { await writeInbox({ action: "move", thread: t.id, id: tr.id, to: dest.id, ts: Math.floor(Date.now() / 1000) }, "move"); }
  catch (e) { msg.textContent = netMsg(e); btns.forEach((b) => (b.disabled = false)); return; }
  if (playing && playing.thread === t) playing = null;
  t.tracks.splice(i, 1);
  t.tracks.forEach((x, k) => { if (k === 0) x.main = true; else delete x.main; });
  delete tr.main;
  dest.tracks.push(tr); // the newest reply of its new thread, like "Add a track here"
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
  refreshHistory();
}
/* History: draw the months on screen again after an edit (fold-outs that were open stay open) */
function refreshHistory() {
  if (view !== "history" || $("#q").value.trim()) return;
  const open = new Set([...document.querySelectorAll(".month-tracks:not([hidden])")].map((o) => o.closest(".month-row").querySelector(".month-line").dataset.k));
  const items = new Map(historyMonths().map((m) => [m.id, m]));
  shown.forEach((x) => {
    const nm = items.get(x.t.id), node = document.getElementById("th-" + x.t.id);
    if (nm) { x.t = nm; if (node) node.replaceWith(monthNode({ t: nm })); } else if (node) node.remove();
  });
  document.querySelectorAll(".month-line").forEach((l) => { if (open.has(l.dataset.k)) l.querySelector(".month-n")?.click(); });
  markPlaying();
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
  const cards = document.querySelectorAll(".add-form");
  if (cards.length) { cards.forEach((f) => closeAddForm(f)); return; } // an open card closes first, nothing else
  if (view === "genres" && gSel.length && !$("#q").value) { setGenres([]); return; } // Genres: Esc empties the field
  if (activeId) setActive(null);
  if (!$("#menu").hidden) toggleMenu(false);
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
  const top = headerBottom(), dock = dockH();
  const under = contentTop();
  const y = at === "top" ? under + 8 : top + (innerHeight - dock - top) / 3; // right under the header (and History's bar), or a third of the way down
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
/* "flag" in the player (phone): tags the playing track "flagged" (again: takes it off) */
function showFlag() { const tr = playing && playing.thread.tracks[playing.index]; $("#flagBtn").classList.toggle("on", !!(tr && tr.tags && tr.tags.flagged)); }
$("#flagBtn").onclick = async () => {
  if (!playing) return;
  if (!getToken()) { openSetup(); return; }
  const tr = playing.thread.tracks[playing.index], on = !(tr.tags && tr.tags.flagged), ts = Math.floor(Date.now() / 1000);
  try { await writeInbox({ action: "tag", ids: [tr.id], add: on ? ["flagged"] : [], remove: on ? [] : ["flagged"], ts }, "tag"); } catch { return; }
  applyTags(tr, on ? [...Object.keys(tr.tags || {}), "flagged"] : Object.keys(tr.tags || {}).filter((g) => g !== "flagged"), ts);
  tr._hay = null; showFlag(); refreshTags();
};
/* "edit" in the player: the playing track's edit card */
$("#editBtn").onclick = () => editPlaying(false);
/* Cmd+Enter (Ctrl+Enter on Windows) while a track plays: open its edit card (on a device with a key) */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !playing || !getToken()) return;
  const t = e.target;
  if (t.closest && t.closest("input, textarea, select, [contenteditable]") && !t.closest(".edit-form")) return;
  e.preventDefault();
  editPlaying(true);
});
/* the playing track's edit card: where it shows on this page, otherwise in its own thread;
   already open: Cmd+Enter opens (or closes) its More info, the player's "edit" closes it */
function editPlaying(more) {
  if (!playing) return;
  if (!getToken()) { openSetup(); return; }
  const tr = playing.thread.tracks[playing.index], home = homeOf(tr);
  if (!home) return;
  const i = home.tracks.indexOf(tr);
  let t = playing.thread, k = playing.index;
  const rowOf = (id, n) => document.querySelector(view === "history" && !$("#q").value.trim()
    ? `.month-line[data-k="${CSS.escape(id)}:${n}"], .month-tracks li[data-k="${CSS.escape(id)}:${n}"]`
    : `.track[data-k="${CSS.escape(id)}:${n}"], .head-row[data-k="${CSS.escape(id)}:${n}"]`);
  let row = rowOf(t.id, k);
  if (!row) { t = home; k = i; row = rowOf(home.id, i); }
  if (!row) { goToThread(home); row = rowOf(home.id, i); }
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains("edit-wrap")) {
    if (more) next.querySelector(".more-info-btn")?.click(); else closeAddForm(next.querySelector(".add-form"));
    return;
  }
  toggleEditForm(t, k, row);
}

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
$("#q").addEventListener("input", () => { if (!$("#menu").hidden) toggleMenu(false); syncClear(); clearTimeout(timer); timer = setTimeout(runSearch, 70); });
$("#clearQ").onclick = () => { $("#q").value = ""; syncClear(); runSearch(); if (phone()) $("#q").blur(); else $("#q").focus(); };
// phones: Enter, or touching anywhere outside the search field, puts the keyboard away
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); runSearch(); $("#q").blur(); } });
document.addEventListener("touchstart", (e) => { if (document.activeElement === $("#q") && !e.target.closest(".search")) $("#q").blur(); }, { passive: true });
$("#home").onclick = (e) => { e.preventDefault(); HOVER_MENU ? toggleMenu(true) : toggleMenu(); };
/* laptop: the menu opens as soon as the pointer is on the logo and stays open while the pointer is anywhere in
   the header (search, Add track, the menu itself); it closes ~0.4 s after leaving the header. A click on the
   logo only opens it. */
const HOVER_MENU = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
if (HOVER_MENU) {
  let tClose;
  $("#home").addEventListener("mouseenter", () => { clearTimeout(tClose); if ($("#menu").hidden) toggleMenu(true); });
  // it stays open while the pointer is anywhere in the header or the menu's row (also on the way from a menu
  // item to the search bar); it closes ~0.4 s after the pointer goes down into the page or leaves the window
  addEventListener("mousemove", (e) => {
    if ($("#menu").hidden) return;
    const bottom = Math.max($(".top").getBoundingClientRect().bottom, $("#menu").getBoundingClientRect().bottom) + 12;
    if (e.clientY <= bottom) { clearTimeout(tClose); tClose = null; }
    else if (!tClose) tClose = setTimeout(() => { tClose = null; toggleMenu(false); }, 400);
  }, { passive: true });
  document.documentElement.addEventListener("mouseleave", () => { if (!$("#menu").hidden && !tClose) tClose = setTimeout(() => { tClose = null; toggleMenu(false); }, 400); });
}
$("#q").addEventListener("mousedown", () => { if (!$("#menu").hidden) toggleMenu(false); }); // clicking in the search closes the menu
$("#home").ondblclick = (e) => { e.preventDefault(); toggleMenu(false); setView("threads"); }; // back to Threads

/* Gemini's decision (from what the lookups found, or its own web search) replaces the lookups' suggested
   release, year and genres; the years the lookups found stay as "also" */
function withGemini(x, ai) {
  for (const [u, a] of Object.entries(ai || {})) {
    const o = x[u] || {};
    const ys = [o.y, ...(o.ys || [])].filter((y, k, all) => y && y !== a.y && all.indexOf(y) === k);
    const gs = [...new Set((a.g || []).map(sameGenre))]; // "synth-pop" → "synth pop", as the site writes it
    x[u] = { ...o, g: gs, gm: gs, y: a.y || null, ys, rl: a.rl ? [a.rl] : [],
      src: "Gemini" + (a.how === "search" ? " (web search)" : o.src ? " (checked " + o.src.split("+").join(", ") + ")" : ""), conf: a.conf, chk: o.chk || 1, v: Math.max(o.v || 0, 3) };
  }
  return x;
}
(async function boot() {
  try {
    const [d, m, x, ai] = await Promise.all([
      fetch("data/tracks.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/extra.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/ai.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    threads = d.threads; meta = m; extra = withGemini(x, ai);
    for (const t of threads) for (const tr of t.tracks) setYear(tr);
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
  if (page && page[1] === "random") setTimeout(() => setView("random"), 0); // Random opened in a new tab
  const gq = location.hash.match(/^#\/genres\?g=(.+)$/);
  if (gq) gSel = gq[1].split(",").map(decodeURIComponent).filter(Boolean);
  document.querySelectorAll("#menu [data-view]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.view === view)));
  document.body.dataset.view = view;
  if (!phone()) idleDock(); // the empty player bar is there from the start on a computer
  runSearch();
  watchHistory();
  checkSetupHash();
})();
