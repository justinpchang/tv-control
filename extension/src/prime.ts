import type {
  Command,
  PrimeContext,
  PrimeDetail,
  PrimeEpisode,
  PrimeNowPlaying,
  PrimeTitle,
} from "@tv-control/shared";
import { PRIME_CSS } from "./primeStyles.js";
import {
  PRIME_ORIGIN,
  chunk,
  detailUrl,
  formatTime,
  moveRowFocus,
  newAdClock,
  parseClock,
  screenForPath,
  searchUrl,
  tickAdClock,
  titleIdFromHref,
  type AdClock,
  type PrimeScreen,
  type RowFocus,
} from "./pvLib.js";

// Prime Video site adapter: a 10-foot row overlay (home rows, search grid,
// detail page with seasons/episodes) plus a mini bar over Prime's own player.
// Scrapes Prime's rendered DOM. The player is driven through its own keyboard
// shortcuts (untrusted events work as long as keyCode is set): space, arrows,
// C (captions), F (fullscreen), and Tab, which shows the controls with no
// side effects so the seek bar can be read.

type Tile =
  | { kind: "title"; item: PrimeTitle }
  | { kind: "episode"; item: PrimeEpisode; href: string }
  | { kind: "play"; label: string; href: string }
  | { kind: "season"; label: string; titleId: string; current: boolean };

interface Row {
  title: string;
  tiles: Tile[];
  // Episode/search rows: fewer, larger cards.
  wide?: boolean;
}

interface AdapterState {
  screen: PrimeScreen;
  url: string;
  query: string;
  rows: Row[];
  rowsSig: string;
  focus: RowFocus;
  tvMode: boolean;
  results: PrimeTitle[];
  detail: PrimeDetail | null;
  continueWatching: PrimeTitle[];
  // Play links seen on the page (episodes, play button) keyed by title id;
  // they carry Prime's resume position (t=).
  playHrefs: Map<string, string>;
  clock: AdClock;
  playerTitle: string;
  playerEpisode: string;
  scrubSec: number | null;
  lastReport: string;
}

const state: AdapterState = {
  screen: "browse",
  url: "",
  query: "",
  rows: [],
  rowsSig: "",
  focus: { row: 0, cols: [] },
  tvMode: true,
  results: [],
  detail: null,
  continueWatching: [],
  playHrefs: new Map(),
  clock: newAdClock(),
  playerTitle: "",
  playerEpisode: "",
  scrubSec: null,
  lastReport: "",
};

const CONTINUE_KEY = "tvpv.continue";
// Prime keeps the last subtitle track here only while subtitles are on.
const CAPTIONS_KEY = "atvwebplayersdk_html5_previous_captions";

// --- Bridge to the background service worker ---

function postToBackground(payload: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch {
    /* extension reloaded under us */
  }
}

function reportContext(force = false): void {
  const nowPlaying = readNowPlaying();
  const context: PrimeContext = {
    app: "prime",
    screen: state.screen,
    query: state.query,
    nowPlaying,
    continueWatching: state.continueWatching,
    results: state.screen === "search" ? state.results.slice(0, 60) : [],
    detail: state.screen === "detail" || state.screen === "watch" ? state.detail : null,
  };
  const key = JSON.stringify({
    ...context,
    nowPlaying: nowPlaying && { ...nowPlaying, currentTimeSec: Math.floor(nowPlaying.currentTimeSec) },
  });
  if (!force && key === state.lastReport) return;
  state.lastReport = key;
  postToBackground({ kind: "tvContext", context });
}

// --- DOM scraping ---

function clean(s: string | null | undefined, cap: number): string {
  return (s ?? "").trim().replace(/\s+/g, " ").slice(0, cap);
}

// Lazy images may not have a usable src yet; fall back to the srcset.
function imgOf(el: Element | null): string {
  if (!el) return "";
  const img = el.querySelector("img");
  const src = img?.currentSrc || img?.getAttribute("src") || "";
  if (src.startsWith("https://")) return src;
  const set = el.querySelector("source[srcset], img[srcset]")?.getAttribute("srcset") ?? "";
  const first = set.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
  return first.startsWith("https://") ? first : "";
}

function progressOf(el: Element): number | null {
  const v = Number(el.querySelector("[data-testid=progress-bar]")?.getAttribute("aria-valuenow"));
  return Number.isFinite(v) && v > 0 ? Math.min(100, v) : null;
}

function parseCard(el: Element): PrimeTitle | null {
  const link = el.querySelector<HTMLAnchorElement>('a[href*="/detail/"]');
  const titleId = titleIdFromHref(link?.getAttribute("href"));
  if (!titleId) return null;
  // data-card-title is sometimes just "Season 2"; the packshot label is the show.
  const title = clean(el.querySelector("[data-testid=packshot] button[aria-label]")?.getAttribute("aria-label"), 300)
    || clean(el.querySelector("[aria-label]")?.getAttribute("aria-label"), 300)
    || clean(el.getAttribute("data-card-title"), 300)
    || clean(link?.textContent, 300);
  if (!title) return null;
  const meta = [
    clean(el.getAttribute("data-card-entity-type"), 30),
    clean(el.querySelector("[data-testid=metadata-badge]")?.textContent, 30),
  ].filter(Boolean).join(" · ");
  return {
    titleId,
    title,
    meta,
    image: imgOf(el),
    entitled: el.getAttribute("data-card-entitlement") !== "Unentitled",
    progress: progressOf(el),
  };
}

const CARD_SELECTOR = "article[data-testid=card], [data-testid=super-carousel-card]";

// Row title: the nearest ancestor holding exactly one carousel title.
function rowTitleFor(list: Element): string {
  let el: Element | null = list.parentElement;
  for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
    const titles = el.querySelectorAll("[data-testid=carousel-title]");
    if (titles.length === 1) return clean(titles[0].textContent, 120);
    if (titles.length > 1) break;
  }
  return "";
}

function scrapeRows(root: ParentNode): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const list of root.querySelectorAll("[data-testid=card-container-list], [data-testid=super-carousel]")) {
    if (rows.length >= 20) break;
    const items: PrimeTitle[] = [];
    const ids = new Set<string>();
    for (const el of list.querySelectorAll(CARD_SELECTOR)) {
      const item = parseCard(el);
      if (!item || ids.has(item.titleId)) continue;
      ids.add(item.titleId);
      items.push(item);
      if (items.length >= 40) break;
    }
    const sig = [...ids].join(",");
    if (items.length === 0 || seen.has(sig)) continue;
    seen.add(sig);
    rows.push({ title: rowTitleFor(list), tiles: items.map((item) => ({ kind: "title", item })) });
  }
  return rows;
}

function scrapeSearch(): PrimeTitle[] {
  const out: PrimeTitle[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll(CARD_SELECTOR)) {
    const item = parseCard(el);
    if (!item || seen.has(item.titleId)) continue;
    seen.add(item.titleId);
    out.push(item);
    if (out.length >= 60) break;
  }
  return out;
}

// Deepest text of the play button: "Resume Episode 1" (outer spans repeat it).
function buttonLabel(el: Element): string {
  const leaves = [...el.querySelectorAll("span")].filter((s) => !s.querySelector("span"));
  const texts = leaves.map((s) => clean(s.textContent, 80)).filter(Boolean);
  return texts.sort((a, b) => b.length - a.length)[0] ?? clean(el.textContent, 80);
}

function scrapeDetail(): PrimeDetail | null {
  const titleId = titleIdFromHref(location.pathname);
  if (!titleId) return null;
  state.playHrefs.clear();
  const titleArt = document.querySelector("[data-testid=title-art]");
  const title = clean(titleArt?.querySelector("img")?.getAttribute("alt"), 300)
    || clean(titleArt?.textContent, 300)
    || clean(document.title.replace(/^Prime Video:\s*/, ""), 300);

  let playLabel = "";
  const play = document.querySelector("[data-testid=dp-atf-play-button]");
  const playHref = play?.getAttribute("href") ?? "";
  if (play && playHref.includes("autoplay=1")) {
    playLabel = buttonLabel(play);
    state.playHrefs.set(titleId, playHref);
  }

  // Episode pages (where the player closes to) carry the season list too;
  // the selector's own label names the selected season.
  const seasons: PrimeDetail["seasons"] = [];
  const selector = document.querySelector("[data-testid=dp-season-selector]");
  const selected = clean(selector?.querySelector("label")?.textContent, 40);
  for (const a of selector?.querySelectorAll("a[href*='/detail/']") ?? []) {
    const id = titleIdFromHref(a.getAttribute("href"));
    if (!id || seasons.some((s) => s.titleId === id)) continue;
    const label = clean(a.textContent, 40);
    seasons.push({ titleId: id, label, current: id === titleId || label === selected });
  }

  const episodes: PrimeEpisode[] = [];
  for (const li of document.querySelectorAll("[data-testid=episode-list-item]")) {
    const href = li.querySelector("a[data-testid=episodes-playbutton][href]")?.getAttribute("href") ?? "";
    const id = titleIdFromHref(href);
    const epTitle = clean(li.querySelector("h3")?.textContent, 300);
    if (!id || !epTitle) continue;
    state.playHrefs.set(id, href);
    const left = clean(li.querySelector("[data-automation-id=dv-progress-resume-text]")?.textContent, 40);
    const meta = left || [
      clean(li.querySelector("[data-testid=episode-runtime]")?.textContent, 20),
      clean(li.querySelector("[data-testid=episode-release-date]")?.textContent, 30),
    ].filter(Boolean).join(" · ");
    episodes.push({
      titleId: id,
      title: epTitle,
      meta,
      image: imgOf(li.querySelector("[data-testid=episode-packshot]") ?? li),
      progress: progressOf(li),
    });
  }

  return {
    titleId,
    title,
    synopsis: clean(document.querySelector("[data-testid=dp-atf-synopsis]")?.textContent, 1000),
    entitlement: clean(document.querySelector("[data-testid=entitlement-message]")?.textContent, 120),
    playLabel,
    seasons,
    episodes,
  };
}

// --- Player ---

function playerEl(): HTMLElement | null {
  const p = document.getElementById("dv-web-player");
  if (!p || !p.classList.contains("dv-player-fullscreen")) return null;
  return getComputedStyle(p).display === "none" ? null : p;
}

function currentVideo(): HTMLVideoElement | null {
  const p = playerEl();
  if (!p) return null;
  const videos = [...p.querySelectorAll("video")].filter((v) => v.src);
  return videos.find((v) => !v.paused) ?? videos[0] ?? null;
}

// Prime reads e.keyCode and doesn't check isTrusted. Arrows/Tab act on
// keydown, letters and space on keyup; sending both is harmless.
function playerKey(key: string, code: string, keyCode: number): boolean {
  const p = playerEl();
  if (!p) return false;
  for (const type of ["keydown", "keyup"]) {
    p.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
  }
  return true;
}

let lastReveal = 0;

function revealControls(): void {
  lastReveal = Date.now();
  playerKey("Tab", "Tab", 9);
}

function adShowing(p: HTMLElement): boolean {
  return p.querySelector("[class*=ad-timer]") !== null;
}

// Prime's seek bar, only mounted while its controls are up: current time in
// aria-valuetext, then elapsed/remaining clocks.
function readSeekBar(p: HTMLElement): { currentSec: number; durationSec: number } | null {
  const seek = p.querySelector("input[type=range][aria-valuetext]");
  if (!seek) return null;
  const currentSec = parseClock(seek.getAttribute("aria-valuetext") ?? "");
  if (!Number.isFinite(currentSec)) return null;
  const clocks = [...p.querySelectorAll("div, span")]
    .filter((el) => el.children.length === 0 && !el.closest("[class*=ad-timer]"))
    .map((el) => parseClock(el.textContent ?? ""))
    .filter((n) => Number.isFinite(n));
  const remaining = clocks.length >= 2 ? clocks[1] : NaN;
  return { currentSec, durationSec: currentSec + remaining };
}

function updateClock(): void {
  const p = playerEl();
  const v = currentVideo();
  if (!p || !v) return;
  const ad = adShowing(p);
  state.clock = tickAdClock(state.clock, v.currentTime, ad, readSeekBar(p));
  // One look at the seek bar per playback pins the ad offset.
  if (!state.clock.calibrated && !ad && v.currentTime > 0 && Date.now() - lastReveal > 5000) revealControls();
  const title = clean(p.querySelector(".atvwebplayersdk-title-text")?.textContent, 300);
  const episode = clean(p.querySelector(".atvwebplayersdk-episode-info")?.textContent, 300);
  if (episode && state.playerEpisode && episode !== state.playerEpisode) resetClock();
  if (title) state.playerTitle = title;
  if (episode) state.playerEpisode = episode;
}

function resetClock(): void {
  state.clock = newAdClock();
  state.playerTitle = "";
  state.playerEpisode = "";
}

function captionsOn(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== null;
  } catch {
    return false;
  }
}

function skipButton(): HTMLElement | null {
  const p = playerEl();
  if (!p) return null;
  for (const b of p.querySelectorAll<HTMLElement>("button, [role=button]")) {
    const label = clean(b.textContent, 40) || clean(b.getAttribute("aria-label"), 40);
    if (/^skip\b/i.test(label) && !/seconds/i.test(label) && b.getClientRects().length > 0) return b;
  }
  return null;
}

function nextEpisodeButton(): HTMLElement | null {
  const p = playerEl();
  if (!p) return null;
  return [...p.querySelectorAll<HTMLElement>("button")]
    .find((b) => /next episode/i.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) ?? null;
}

function readNowPlaying(): PrimeNowPlaying | null {
  if (state.screen !== "watch") return null;
  const p = playerEl();
  const v = currentVideo();
  if (!p || !v) return null;
  const c = state.clock;
  const videoDuration = Number.isFinite(v.duration) ? v.duration : 0;
  const skip = skipButton();
  return {
    title: state.playerTitle || state.detail?.title || "",
    episode: state.playerEpisode,
    currentTimeSec: c.contentSec,
    durationSec: c.durationSec || Math.max(0, videoDuration - c.offset),
    paused: v.paused,
    ad: adShowing(p),
    captions: captionsOn(),
    rate: v.playbackRate,
    skip: skip ? clean(skip.textContent, 40) || "Skip" : "",
  };
}

// --- Continue watching (persisted, so the phone has it on any screen) ---

function loadContinue(): void {
  try {
    chrome.storage.local.get([CONTINUE_KEY], (res) => {
      const raw = res[CONTINUE_KEY];
      if (!Array.isArray(raw) || state.continueWatching.length > 0) return;
      state.continueWatching = raw.filter((t): t is PrimeTitle => typeof t?.titleId === "string").slice(0, 20);
      reportContext(true);
    });
  } catch {
    /* storage unavailable */
  }
}

function saveContinue(items: PrimeTitle[]): void {
  const sig = (list: PrimeTitle[]): string => list.map((t) => `${t.titleId}:${Math.round(t.progress ?? 0)}`).join(",");
  if (sig(items) === sig(state.continueWatching)) return;
  state.continueWatching = items.slice(0, 20);
  try {
    chrome.storage.local.set({ [CONTINUE_KEY]: state.continueWatching });
  } catch {
    /* ignore */
  }
}

// --- TV overlay ---

let styleEl: HTMLStyleElement | null = null;
let rootEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let heroEl: HTMLElement | null = null;
let rowsEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let headQueryEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
let miniEl: HTMLElement | null = null;

function ensureStyle(): void {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.textContent = PRIME_CSS;
  (document.head ?? document.documentElement).appendChild(styleEl);
}

function ensureOverlay(): void {
  ensureStyle();
  if (rootEl || !document.body) return;
  rootEl = document.createElement("div");
  rootEl.id = "tvpv-root";
  rootEl.innerHTML = `
    <div class="tvpv-head">
      <div class="tvpv-brand">prime video<span> TV</span></div>
      <div class="tvpv-query"></div>
      <div class="tvpv-hints">D-pad: move · OK: open · ◀ Back</div>
      <button class="tvpv-exit" type="button">Exit TV mode</button>
    </div>
    <div class="tvpv-body">
      <div class="tvpv-hero" hidden><h1></h1><div class="tvpv-ent"></div><p></p></div>
      <div class="tvpv-rows"></div>
      <div class="tvpv-empty" hidden>Loading…</div>
    </div>`;
  document.body.appendChild(rootEl);
  bodyEl = rootEl.querySelector(".tvpv-body");
  heroEl = rootEl.querySelector(".tvpv-hero");
  rowsEl = rootEl.querySelector(".tvpv-rows");
  emptyEl = rootEl.querySelector(".tvpv-empty");
  headQueryEl = rootEl.querySelector(".tvpv-query");
  rootEl.querySelector(".tvpv-exit")?.addEventListener("click", () => setTvMode(false));

  miniEl = document.createElement("div");
  miniEl.id = "tvpv-minibar";
  miniEl.hidden = true;
  miniEl.innerHTML = `
    <div class="tvpv-mini-title"></div>
    <div class="tvpv-mini-sub"></div>
    <div class="tvpv-mini-track"><div class="tvpv-mini-fill"></div><div class="tvpv-mini-preview" hidden></div></div>
    <div class="tvpv-mini-hints">◀ ▶ seek 10s · OK play/pause · ▲ ▼ player controls · Back closes</div>`;
  document.body.appendChild(miniEl);

  toastEl = document.createElement("div");
  toastEl.id = "tvpv-toast";
  document.body.appendChild(toastEl);
  rehostOverlay();
}

// Only the fullscreen element's subtree renders in fullscreen.
function rehostOverlay(): void {
  const host = document.fullscreenElement ?? document.body;
  if (!host) return;
  for (const el of [rootEl, miniEl, toastEl]) {
    if (el && el.parentElement !== host) host.appendChild(el);
  }
}

function toast(msg: string): void {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), 2200);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function tileHtml(tile: Tile): string {
  if (tile.kind === "play") return esc(tile.label);
  if (tile.kind === "season") return esc(tile.label);
  const item = tile.item;
  const lock = tile.kind === "title" && !tile.item.entitled ? `<span class="tvpv-lock">$</span>` : "";
  const prog = item.progress !== null ? `<div class="tvpv-prog"><i style="width:${item.progress}%"></i></div>` : "";
  const img = item.image ? `<img loading="lazy" alt="" src="${esc(item.image)}" />` : "";
  return `<div class="tvpv-thumb">${img}${lock}${prog}</div>` +
    `<div class="tvpv-title">${esc(item.title) || "(untitled)"}</div>` +
    (item.meta ? `<div class="tvpv-meta">${esc(item.meta)}</div>` : "");
}

function tileClass(tile: Tile): string {
  if (tile.kind === "play") return "tvpv-btn primary";
  if (tile.kind === "season") return "tvpv-btn" + (tile.current ? " current" : "");
  return "tvpv-card";
}

function rowsSignature(rows: Row[]): string {
  return rows.map((r) => r.title + ":" + r.tiles.map((t) =>
    t.kind === "title" || t.kind === "episode" ? `${t.item.titleId}/${t.item.image ? 1 : 0}/${t.item.progress ?? ""}` : t.label,
  ).join(",")).join("|");
}

let miniLit = false;
let miniTimer = 0;
const MINI_IDLE_MS = 4000;

function pokeMini(): void {
  miniLit = true;
  if (miniEl) miniEl.hidden = !(state.tvMode && state.screen === "watch");
  window.clearTimeout(miniTimer);
  miniTimer = window.setTimeout(() => {
    miniLit = false;
    if (miniEl) miniEl.hidden = true;
  }, MINI_IDLE_MS);
}

function renderAll(): void {
  ensureOverlay();
  if (!rootEl || !rowsEl) return;
  const showRows = state.tvMode && state.screen !== "watch";
  rootEl.hidden = !showRows;
  if (miniEl) miniEl.hidden = !(state.tvMode && state.screen === "watch" && miniLit);
  if (showRows) {
    if (headQueryEl) headQueryEl.textContent = state.screen === "search" ? `“${state.query}”` : "";
    renderHero();
    const sig = rowsSignature(state.rows);
    if (sig !== state.rowsSig) {
      state.rowsSig = sig;
      rowsEl.innerHTML = "";
      state.rows.forEach((row, r) => {
        const rowEl = document.createElement("section");
        rowEl.className = "tvpv-row" + (row.wide ? " wide" : "");
        if (row.title) {
          const h = document.createElement("h2");
          h.textContent = row.title;
          rowEl.appendChild(h);
        }
        const strip = document.createElement("div");
        strip.className = "tvpv-strip";
        row.tiles.forEach((tile, c) => {
          const el = document.createElement("div");
          el.className = tileClass(tile);
          el.dataset.row = String(r);
          el.dataset.col = String(c);
          el.innerHTML = tileHtml(tile);
          el.addEventListener("click", () => activate(tile));
          strip.appendChild(el);
        });
        rowEl.appendChild(strip);
        rowsEl!.appendChild(rowEl);
      });
    }
    if (emptyEl) emptyEl.hidden = state.rows.length > 0;
    updateFocus();
  }
  renderMini();
}

function renderHero(): void {
  if (!heroEl) return;
  const d = state.screen === "detail" ? state.detail : null;
  heroEl.hidden = !d;
  if (!d) return;
  heroEl.querySelector("h1")!.textContent = d.title;
  heroEl.querySelector(".tvpv-ent")!.textContent = d.entitlement;
  heroEl.querySelector("p")!.textContent = d.synopsis;
}

function renderMini(): void {
  if (!miniEl) return;
  const np = readNowPlaying();
  if (!np) return;
  miniEl.querySelector(".tvpv-mini-title")!.textContent = [np.title, np.episode].filter(Boolean).join(" — ");
  const time = np.durationSec > 0 ? `${formatTime(np.currentTimeSec)} / ${formatTime(np.durationSec)}` : "";
  const rate = np.rate !== 1 ? `${np.rate}×` : "";
  miniEl.querySelector(".tvpv-mini-sub")!.textContent =
    [np.ad ? "Ad" : np.paused ? "Paused" : "Playing", time, rate, np.captions ? "CC" : ""].filter(Boolean).join(" · ");
  const fill = miniEl.querySelector<HTMLElement>(".tvpv-mini-fill")!;
  fill.style.width = np.durationSec > 0 ? `${Math.min(100, (np.currentTimeSec / np.durationSec) * 100)}%` : "0%";
  const preview = miniEl.querySelector<HTMLElement>(".tvpv-mini-preview")!;
  const t = state.scrubSec;
  preview.hidden = t === null || np.durationSec <= 0;
  if (t !== null && np.durationSec > 0) {
    preview.style.left = `clamp(2vw, ${Math.min(100, (t / np.durationSec) * 100)}%, calc(100% - 2vw))`;
    preview.textContent = formatTime(t);
  }
}

let scrubTimer = 0;

function scrubPreview(seconds: number | null): void {
  state.scrubSec = seconds;
  window.clearTimeout(scrubTimer);
  if (seconds !== null) scrubTimer = window.setTimeout(() => scrubPreview(null), 2000);
  renderMini();
}

function updateFocus(): void {
  if (!rowsEl) return;
  rowsEl.querySelectorAll(".focused").forEach((el) => el.classList.remove("focused"));
  const col = state.focus.cols[state.focus.row] ?? 0;
  const target = rowsEl.querySelector<HTMLElement>(`[data-row="${state.focus.row}"][data-col="${col}"]`);
  if (!target) return;
  target.classList.add("focused");
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
  // Keep the detail hero in view while on the first row.
  if (state.focus.row === 0 && bodyEl) bodyEl.scrollTop = 0;
}

function setTvMode(on: boolean): void {
  state.tvMode = on;
  renderAll();
  reportContext(true);
}

// --- Actions ---

function go(href: string): void {
  location.href = href.startsWith("http") ? href : PRIME_ORIGIN + href;
}

function playHref(titleId: string): string {
  return state.playHrefs.get(titleId) ?? `${detailUrl(titleId)}?autoplay=1`;
}

function activate(tile: Tile): void {
  switch (tile.kind) {
    case "title": go(detailUrl(tile.item.titleId)); break;
    case "episode": go(tile.href); break;
    case "play": go(tile.href); break;
    case "season": if (!tile.current) go(detailUrl(tile.titleId)); break;
  }
}

function focusedTile(): Tile | null {
  const row = state.rows[state.focus.row];
  return row?.tiles[state.focus.cols[state.focus.row] ?? 0] ?? null;
}

function contentSeekTo(seconds: number): void {
  const v = currentVideo();
  if (!v) return;
  const dur = state.clock.durationSec || (Number.isFinite(v.duration) ? v.duration - state.clock.offset : 0);
  const target = Math.max(0, Math.min(dur > 0 ? dur - 1 : seconds, seconds));
  v.currentTime = target + state.clock.offset;
  state.clock = { ...state.clock, contentSec: target };
}

function closePlayer(): void {
  revealControls();
  window.setTimeout(() => {
    const close = playerEl()?.querySelector<HTMLElement>('button[aria-label="Close player"]');
    if (close) close.click();
    else history.back();
  }, 250);
}

// Fullscreen: the service sends a real F13 to the Edge window (see
// WindowsLauncher.fullscreen); its user activation lets Prime's own "f"
// hotkey call requestFullscreen.
function onFullscreenKey(e: KeyboardEvent): void {
  if (!e.isTrusted || e.key !== "F13") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (state.screen === "watch") playerKey("f", "KeyF", 70);
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else toast("Start playing to go fullscreen");
}

function handleWatchCommand(command: Command): boolean {
  switch (command.type) {
    case "navigate":
      if (command.direction === "left") playerKey("ArrowLeft", "ArrowLeft", 37);
      else if (command.direction === "right") playerKey("ArrowRight", "ArrowRight", 39);
      else revealControls();
      return true;
    case "select":
    case "playPause":
      playerKey(" ", "Space", 32);
      return true;
    case "back":
      closePlayer();
      return true;
    case "seek":
      if (Math.abs(command.seconds) === 10) {
        playerKey(command.seconds < 0 ? "ArrowLeft" : "ArrowRight", command.seconds < 0 ? "ArrowLeft" : "ArrowRight",
          command.seconds < 0 ? 37 : 39);
      } else {
        contentSeekTo(state.clock.contentSec + command.seconds);
      }
      return true;
    case "seekTo":
      scrubPreview(null);
      contentSeekTo(command.seconds);
      return true;
    case "scrub":
      scrubPreview(command.seconds);
      return true;
    case "speed": {
      const v = currentVideo();
      if (v) v.playbackRate = command.rate;
      toast(`Speed ${command.rate}×`);
      return true;
    }
    case "captions":
      // Prime toasts the new subtitle state itself.
      playerKey("c", "KeyC", 67);
      return true;
    case "skip": {
      const btn = skipButton() ?? nextEpisodeButton();
      if (btn) {
        btn.click();
        return true;
      }
      // Next Episode lives in the controls bar; bring it up and retry.
      revealControls();
      window.setTimeout(() => {
        const next = skipButton() ?? nextEpisodeButton();
        if (next) next.click();
        else toast("Nothing to skip");
      }, 300);
      return true;
    }
    default:
      return false;
  }
}

export function handleCommand(command: Command): void {
  if (!state.tvMode) setTvMode(true);
  if (state.screen === "watch") pokeMini();
  if (state.screen === "watch" && handleWatchCommand(command)) {
    finishCommand();
    return;
  }
  switch (command.type) {
    case "navigate": {
      const next = moveRowFocus(state.focus, state.rows.map((r) => r.tiles.length), command.direction);
      state.focus = next;
      updateFocus();
      // Near the bottom: let Prime's infinite scroll fetch more rows.
      if (state.screen !== "detail" && next.row >= state.rows.length - 2) {
        document.querySelector("[data-testid=page-pagination-marker]")?.scrollIntoView();
      }
      break;
    }
    case "select": {
      const tile = focusedTile();
      if (tile) activate(tile);
      break;
    }
    case "back":
      if (state.screen === "detail" && history.length > 1) history.back();
      else if (state.screen !== "browse") go(`${PRIME_ORIGIN}/`);
      else toast("Press Home on the phone for TV Home");
      break;
    case "openTitle":
      go(command.play ? playHref(command.titleId) : detailUrl(command.titleId));
      break;
    case "search":
      state.query = command.text;
      go(searchUrl(command.text));
      break;
    case "playPause":
    case "seek":
    case "seekTo":
    case "captions":
    case "speed":
    case "skip":
      toast("Nothing playing");
      break;
    case "quality":
      toast("Prime picks quality automatically");
      break;
    default:
      break;
  }
  finishCommand();
}

function finishCommand(): void {
  reportContext(true);
  // Player state (captions, pause, skip) settles a beat after the key.
  window.setTimeout(() => {
    updateClock();
    renderMini();
    reportContext();
  }, 400);
}

// --- Page tracking ---

let boundVideo: HTMLVideoElement | null = null;

function bindVideo(): void {
  const v = currentVideo();
  if (v === boundVideo) return;
  boundVideo = v;
  if (!v) return;
  v.addEventListener("play", () => { pokeMini(); reportContext(true); });
  v.addEventListener("pause", () => { pokeMini(); reportContext(true); });
  v.addEventListener("seeked", () => { pokeMini(); updateClock(); renderMini(); reportContext(true); });
  v.addEventListener("timeupdate", () => { updateClock(); renderMini(); reportContext(); });
  v.addEventListener("ratechange", () => { renderMini(); reportContext(); });
  v.addEventListener("emptied", resetClock);
}

// Hero trailers autoplay behind the overlay; nobody is watching them.
function pauseBackgroundVideos(): void {
  const player = playerEl();
  for (const v of document.querySelectorAll("video")) {
    if (!v.paused && !(player && player.contains(v))) v.pause();
  }
}

function buildRows(): Row[] {
  if (state.screen === "search") {
    state.results = scrapeSearch();
    return chunk(state.results, 4).map((items, i) => ({
      title: i === 0 ? `Results for “${state.query}”` : "",
      wide: true,
      tiles: items.map((item) => ({ kind: "title" as const, item })),
    }));
  }
  if (state.screen === "detail") {
    state.detail = scrapeDetail();
    const d = state.detail;
    if (!d) return [];
    const actions: Tile[] = [];
    const href = state.playHrefs.get(d.titleId);
    if (href && d.playLabel) actions.push({ kind: "play", label: d.playLabel, href });
    for (const s of d.seasons) actions.push({ kind: "season", label: s.label, titleId: s.titleId, current: s.current });
    const rows: Row[] = [];
    if (actions.length > 0) rows.push({ title: "", tiles: actions });
    if (d.episodes.length > 0) {
      rows.push({
        title: "Episodes",
        wide: true,
        tiles: d.episodes.map((item) => ({ kind: "episode", item, href: state.playHrefs.get(item.titleId) ?? "" })),
      });
    }
    const main = document.querySelector("[data-testid=detailpage-main]") ?? document;
    return rows.concat(scrapeRows(main));
  }
  const rows = scrapeRows(document);
  const cw = rows.find((r) => /continue watching/i.test(r.title));
  if (cw) saveContinue(cw.tiles.flatMap((t) => (t.kind === "title" ? [t.item] : [])));
  return rows;
}

function refreshFromPage(): void {
  const urlScreen = screenForPath(location.pathname, location.search);
  const screen: PrimeScreen = playerEl() ? "watch" : urlScreen;
  const urlChanged = location.href !== state.url;
  const screenChanged = screen !== state.screen;
  state.url = location.href;
  if (screenChanged) {
    state.screen = screen;
    if (screen === "watch") {
      resetClock();
      pokeMini();
    }
  }
  if (urlScreen === "search") {
    try {
      state.query = new URLSearchParams(location.search).get("phrase") ?? state.query;
    } catch {
      /* keep */
    }
  } else if (urlScreen === "browse") {
    state.query = "";
  }
  // The player sits on top of the detail page, which stays scrapeable.
  if (screen === "watch") {
    if (!state.detail || urlChanged) state.detail = scrapeDetail();
  } else {
    const rows = buildRows();
    // Mid-render scans come back empty; keep what we have unless we moved.
    if (rows.length > 0 || urlChanged || screenChanged) state.rows = rows;
    if (urlChanged || screenChanged) state.focus = { row: 0, cols: [] };
    pauseBackgroundVideos();
  }
  bindVideo();
  updateClock();
  renderAll();
  reportContext();
}

let scanTimer = 0;
let lastScan = 0;
const SCAN_EVERY_MS = 1000;

function scheduleRefresh(): void {
  const now = Date.now();
  if (now - lastScan < SCAN_EVERY_MS) {
    if (!scanTimer) {
      scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        lastScan = Date.now();
        refreshFromPage();
      }, SCAN_EVERY_MS - (now - lastScan));
    }
    return;
  }
  lastScan = now;
  refreshFromPage();
}

// --- Boot (document_start: body may not exist yet) ---

const HEARTBEAT_MS = 20_000;

export function startPrimeAdapter(): void {
  ensureStyle();
  loadContinue();
  window.addEventListener("keydown", onFullscreenKey, true);
  document.addEventListener("fullscreenchange", rehostOverlay);
  postToBackground({ kind: "tvHello", app: "prime" });
  window.setInterval(() => postToBackground({ kind: "tvHello", app: "prime" }), HEARTBEAT_MS);

  document.addEventListener("DOMContentLoaded", refreshFromPage);
  window.addEventListener("popstate", scheduleRefresh);
  new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
  refreshFromPage();

  chrome.runtime.onMessage.addListener((msg: { kind?: string; command?: Command }) => {
    if (msg?.kind === "tvCommand" && msg.command) handleCommand(msg.command);
    else if (msg?.kind === "tvRefresh") reportContext(true);
  });

  // PC keyboard for desk debugging. Capture phase so Prime's player never
  // sees the real key too; our own synthetic player keys are untrusted and
  // pass straight through.
  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted || !state.tvMode) return;
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    const cmd = DESK_KEYS[e.key];
    if (cmd) {
      e.preventDefault();
      e.stopImmediatePropagation();
      handleCommand(cmd);
    }
  }, true);
  // Prime acts on keyup for space/letters; swallow the real one too.
  window.addEventListener("keyup", (e) => {
    if (e.isTrusted && state.tvMode && DESK_KEYS[e.key]) e.stopImmediatePropagation();
  }, true);
}

const DESK_KEYS: Record<string, Command> = {
  ArrowUp: { type: "navigate", direction: "up" },
  ArrowDown: { type: "navigate", direction: "down" },
  ArrowLeft: { type: "navigate", direction: "left" },
  ArrowRight: { type: "navigate", direction: "right" },
  Enter: { type: "select" },
  Backspace: { type: "back" },
  " ": { type: "playPause" },
};
