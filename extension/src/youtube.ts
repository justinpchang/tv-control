import {
  storyboardFrame,
  type Command,
  type NowPlaying,
  type Storyboard,
  type VideoItem,
  type YoutubeContext,
} from "@tv-control/shared";
import { OVERLAY_CSS } from "./overlayStyles.js";
import { formatTime, moveFocus, parseStoryboardSpec, screenForPath, videoIdFromHref, watchUrl } from "./ytLib.js";

// YouTube site adapter: a readable 10-foot overlay (grid + mini player bar)
// driven by phone commands relayed through the background service worker.
// It scrapes YouTube's own rendered DOM — no API key, works signed-in with
// the household account. Player-API bits (quality) go through ytMain.ts,
// which runs in the page's MAIN world.

interface CardItem extends VideoItem {
  duration: string;
  meta: string;
}

interface AdapterState {
  screen: "browse" | "search" | "watch";
  query: string;
  items: CardItem[];
  focusIndex: number;
  expanded: boolean;
  tvMode: boolean;
  qualities: string[];
  quality: string;
  recent: VideoItem[];
  lastRecorded: string;
  storyboard: Storyboard | null;
  // Phone timeline drag in progress: preview this second on the mini bar.
  scrubSec: number | null;
  lastReport: string;
}

const state: AdapterState = {
  screen: "browse",
  query: "",
  items: [],
  focusIndex: 0,
  expanded: false,
  tvMode: true,
  qualities: [],
  quality: "",
  recent: [],
  lastRecorded: "",
  storyboard: null,
  scrubSec: null,
  lastReport: "",
};

// Same key the old history used, so earlier entries carry over.
const RECENT_KEY = "tvyt.history";
const RECENT_CAP = 12;

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
  const context: YoutubeContext = {
    app: "youtube",
    screen: state.screen,
    query: state.query,
    nowPlaying,
    recent: state.recent,
    results: state.screen === "search"
      ? state.items.slice(0, 40).map(({ videoId, title, channel, thumbnail, duration, meta }) =>
        ({ videoId, title, channel, thumbnail, duration, meta }))
      : [],
  };
  // Round playback time so timeupdate doesn't spam the socket every frame.
  const key = JSON.stringify({ ...context, nowPlaying: nowPlaying && { ...nowPlaying, currentTimeSec: Math.floor(nowPlaying.currentTimeSec) } });
  if (!force && key === state.lastReport) return;
  state.lastReport = key;
  postToBackground({ kind: "tvContext", context });
}

// --- DOM scraping (YouTube's own renderers; tolerant of layout changes) ---

// Current YouTube renders home/related lockups as yt-lockup-view-model, but
// search results still mix legacy ytd-video-renderer (videos) with lockups
// (playlists/mixes), so both are scraped in document order.
const LOCKUP_TAG = "YT-LOCKUP-VIEW-MODEL";
const CARD_SELECTOR = [
  "yt-lockup-view-model",
  "ytd-video-renderer",
  "ytd-rich-item-renderer",
  "ytd-compact-video-renderer",
].join(",");

// The SPA keeps previously visited pages mounted but hidden; scrape only the
// page for the current screen.
const PAGE_FOR_SCREEN = { browse: "ytd-browse", search: "ytd-search", watch: "ytd-watch-flexy" } as const;

function clean(s: string | null | undefined, cap: number): string {
  return (s ?? "").trim().replace(/\s+/g, " ").slice(0, cap);
}

// Legacy renderers repeat text in hidden duplicates ("Sickos Sickos",
// "24:19 24:19"); collapse an exact doubling.
function dedupe(s: string): string {
  return s.replace(/^(.+?)\s+\1$/, "$1");
}

// Scraped <img> srcs are often lazy placeholders (or a playlist's stack art);
// trust them only when they are this video's ytimg frame.
function thumbFor(el: Element, videoId: string): string {
  const src = el.querySelector("img")?.getAttribute("src") ?? "";
  return src.startsWith("https://") && src.includes(`/vi/${videoId}/`)
    ? src
    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function parseLockup(el: Element): CardItem | null {
  if (el.closest("ytd-ad-slot-renderer")) return null;
  const host = el.querySelector(".ytLockupViewModelHost");
  const idFromClass = /content-id-([A-Za-z0-9_-]{11})/.exec(host?.className ?? "")?.[1] ?? null;
  const thumbAnchor = el.querySelector<HTMLAnchorElement>('a.ytLockupViewModelContentImage[href*="/watch"]');
  const anyLink = el.querySelector<HTMLAnchorElement>('a[href*="/watch?v="]');
  const videoId = (idFromClass && /^[A-Za-z0-9_-]{11}$/.test(idFromClass) ? idFromClass : null)
    ?? videoIdFromHref(thumbAnchor?.getAttribute("href") ?? anyLink?.getAttribute("href"));
  if (!videoId) return null;
  // Title lives in the metadata anchor. The thumbnail anchor is aria-hidden
  // and its text is badge/duration junk — never use it.
  let title = "";
  for (const a of [...el.querySelectorAll<HTMLAnchorElement>('a[href*="/watch?v="]')]) {
    if (a === thumbAnchor) continue;
    title = clean(a.textContent, 300) || clean(a.getAttribute("title"), 300);
    if (title) break;
  }
  if (!title) return null;
  const channelAnchor = el.querySelector<HTMLAnchorElement>(
    'a[href^="/@"], a[href*="/channel/"], a[href*="/user/"], a[href*="/c/"]',
  );
  return {
    videoId,
    title,
    channel: clean(channelAnchor?.textContent, 200),
    thumbnail: thumbFor(el, videoId),
    duration: clean(el.querySelector(".ytBadgeShapeText")?.textContent, 20),
    meta: lockupMeta(el),
  };
}

function parseLegacy(el: Element): CardItem | null {
  if (el.closest("ytd-ad-slot-renderer")) return null;
  const link = el.querySelector<HTMLAnchorElement>('a#thumbnail[href*="/watch?v="], a[href*="/watch?v="]');
  const videoId = videoIdFromHref(link?.getAttribute("href"));
  if (!videoId) return null;
  const title = clean(el.querySelector("#video-title")?.textContent, 300)
    || clean(el.querySelector("#video-title-link")?.textContent, 300)
    || clean(link?.getAttribute("title"), 300);
  if (!title) return null;
  return {
    videoId,
    title,
    channel: dedupe(clean(el.querySelector("ytd-channel-name a, ytd-channel-name")?.textContent, 200)),
    thumbnail: thumbFor(el, videoId),
    duration: dedupe(clean(
      el.querySelector("ytd-thumbnail-overlay-time-status-renderer, .ytBadgeShapeText")?.textContent, 40)),
    meta: lockupMeta(el),
  };
}

// "1.2M views · 3 days ago" from the card metadata. Regexes stay narrow so
// title words never match; metadata node preferred, whole card as fallback.
function lockupMeta(el: Element): string {
  const scopes = [
    el.querySelector("yt-lockup-metadata-view-model, #metadata-line")?.textContent,
    el.textContent,
  ];
  for (const scope of scopes) {
    const text = (scope ?? "").replace(/\s+/g, " ");
    const views = /([\d.,]+\s*[KMB]?\s*views?)\b/i.exec(text)?.[1];
    const age = /(\d[\d,]*\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i.exec(text)?.[1];
    if (views || age) return [views, age].filter(Boolean).join(" · ");
    // Compact search-result form: "49M 2y ago".
    const compact = /([\d.,]+\s*[KMB]?)\s+(\d+\s*(?:mo|[smhdwy])\s+ago)/.exec(text);
    if (compact) return `${compact[1]} views · ${compact[2]}`;
  }
  return "";
}

function scrapeItems(): CardItem[] {
  const out: CardItem[] = [];
  const seen = new Set<string>();
  try {
    // Page not mounted yet: report nothing rather than another page's cards.
    const manager = document.querySelector("ytd-page-manager");
    const root = manager ? manager.querySelector(`${PAGE_FOR_SCREEN[state.screen]}:not([hidden])`) : document;
    if (!root) return out;
    for (const el of root.querySelectorAll(CARD_SELECTOR)) {
      if (out.length >= 60) break;
      let item: CardItem | null;
      if (el.tagName === LOCKUP_TAG) item = parseLockup(el);
      else if (el.querySelector("yt-lockup-view-model")) continue; // its lockup is visited on its own
      else item = parseLegacy(el);
      if (!item || seen.has(item.videoId)) continue;
      seen.add(item.videoId);
      out.push(item);
    }
  } catch {
    /* page mid-render; keep previous items */
  }
  return out;
}

function currentVideo(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("video.html5-main-video")
    ?? document.querySelector<HTMLVideoElement>("video");
}

function subtitlesButton(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ytp-subtitles-button");
}

// null = this video has no captions (button hidden or marked unavailable).
function readCaptions(): boolean | null {
  const btn = subtitlesButton();
  if (!btn || getComputedStyle(btn).display === "none") return null;
  const label = `${btn.getAttribute("title") ?? ""} ${btn.getAttribute("data-title-no-tooltip") ?? ""}`;
  if (btn.getAttribute("aria-disabled") === "true" || /unavailable/i.test(label)) return null;
  return btn.getAttribute("aria-pressed") === "true";
}

function readNowPlaying(): NowPlaying | null {
  if (state.screen !== "watch") return null;
  let videoId: string | null = null;
  try {
    videoId = new URLSearchParams(location.search).get("v");
  } catch {
    return null;
  }
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const v = currentVideo();
  const titleEl = document.querySelector("h1.ytd-watch-metadata yt-formatted-string")
    ?? document.querySelector("h1 yt-formatted-string");
  const rawTitle = (titleEl?.textContent ?? document.title).trim().replace(/\s+/g, " ");
  const rawChannel = (document.querySelector("#owner #channel-name a")?.textContent
    ?? document.querySelector("ytd-channel-name#channel-name")?.textContent ?? "")
    .trim().replace(/\s+/g, " ").slice(0, 200);
  // Owner markup often repeats the name ("Sickos Sickos"); collapse it.
  const channel = dedupe(rawChannel);
  return {
    videoId,
    title: rawTitle.replace(/ - YouTube$/, "").slice(0, 300) || videoId,
    channel,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    currentTimeSec: v ? v.currentTime : 0,
    durationSec: v && Number.isFinite(v.duration) ? v.duration : 0,
    paused: v ? v.paused : true,
    captions: readCaptions(),
    quality: state.quality,
    qualities: state.qualities,
    rate: v ? v.playbackRate : 1,
    // Spec urls embed the video id; drop a stale one from the last video.
    storyboard: state.storyboard?.urlTemplate.includes(`/${videoId}/`) ? state.storyboard : null,
  };
}

// --- Recently watched (chrome.storage.local, survives restarts) ---

function loadRecent(): void {
  try {
    chrome.storage.local.get([RECENT_KEY], (res) => {
      const raw = res[RECENT_KEY];
      if (!Array.isArray(raw)) return;
      state.recent = raw
        .filter((v): v is VideoItem => typeof v?.videoId === "string" && typeof v?.title === "string")
        .map(({ videoId, title, channel, thumbnail }) => ({ videoId, title, channel: channel ?? "", thumbnail: thumbnail ?? "" }))
        .slice(0, RECENT_CAP);
      reportContext(true);
    });
  } catch {
    /* storage unavailable */
  }
}

// Count a video once it has really played (10s, not an ad), once per visit.
function maybeRecordRecent(): void {
  const np = readNowPlaying();
  if (!np || np.videoId === state.lastRecorded || np.title === np.videoId) return;
  if (np.currentTimeSec < 10 || document.querySelector("#movie_player.ad-showing")) return;
  state.lastRecorded = np.videoId;
  const item: VideoItem = { videoId: np.videoId, title: np.title, channel: np.channel, thumbnail: np.thumbnail };
  state.recent = [item, ...state.recent.filter((r) => r.videoId !== item.videoId)].slice(0, RECENT_CAP);
  try {
    chrome.storage.local.set({ [RECENT_KEY]: state.recent });
  } catch {
    /* ignore */
  }
  reportContext(true);
}

// --- Player API via the MAIN-world bridge (ytMain.ts) ---

function requestPlayer(req: { set?: string; rate?: number } = {}): void {
  document.dispatchEvent(new CustomEvent("tvyt:playerReq", { detail: JSON.stringify(req) }));
}

function onPlayerInfo(e: Event): void {
  try {
    const info = JSON.parse(String((e as CustomEvent).detail)) as {
      levels?: unknown; preferred?: unknown; storyboardSpec?: unknown;
    };
    state.qualities = Array.isArray(info.levels)
      ? info.levels.filter((l): l is string => typeof l === "string")
      : [];
    state.quality = typeof info.preferred === "string" ? info.preferred : "";
    state.storyboard = typeof info.storyboardSpec === "string" && info.storyboardSpec
      ? parseStoryboardSpec(info.storyboardSpec)
      : null;
    reportContext();
  } catch {
    /* ignore */
  }
}

// --- TV overlay ---

let styleEl: HTMLStyleElement | null = null;
let rootEl: HTMLElement | null = null;
let gridEl: HTMLElement | null = null;
let headQueryEl: HTMLElement | null = null;
let headHintsEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
let miniEl: HTMLElement | null = null;
let miniTitleEl: HTMLElement | null = null;
let miniSubEl: HTMLElement | null = null;
let miniFillEl: HTMLElement | null = null;
let boundVideo: HTMLVideoElement | null = null;

// Styles go in at document_start (before <head> exists) so the page is dark
// from the first frame instead of flashing YouTube's layout.
function ensureStyle(): void {
  if (styleEl) return;
  styleEl = document.createElement("style");
  styleEl.textContent = OVERLAY_CSS;
  (document.head ?? document.documentElement).appendChild(styleEl);
}

function ensureOverlay(): void {
  ensureStyle();
  if (rootEl || !document.body) return;

  rootEl = document.createElement("div");
  rootEl.id = "tvyt-root";
  rootEl.innerHTML = `
    <div class="tvyt-head">
      <div class="tvyt-brand">YouTube<span>TV</span></div>
      <div class="tvyt-query"></div>
      <div class="tvyt-hints"></div>
      <button class="tvyt-exit" type="button">Exit TV mode</button>
    </div>
    <div class="tvyt-grid"></div>
    <div class="tvyt-empty" hidden>Loading…</div>`;
  document.body.appendChild(rootEl);
  headQueryEl = rootEl.querySelector(".tvyt-query");
  headHintsEl = rootEl.querySelector(".tvyt-hints");
  gridEl = rootEl.querySelector(".tvyt-grid");
  emptyEl = rootEl.querySelector(".tvyt-empty");
  rootEl.querySelector(".tvyt-exit")?.addEventListener("click", () => setTvMode(false));

  miniEl = document.createElement("div");
  miniEl.id = "tvyt-minibar";
  miniEl.innerHTML = `
    <div class="tvyt-mini-title"></div>
    <div class="tvyt-mini-sub"></div>
    <div class="tvyt-mini-track">
      <div class="tvyt-mini-fill"></div>
      <div class="tvyt-mini-preview" hidden><div class="tvyt-mini-frame"><div></div></div><span></span></div>
    </div>
    <div class="tvyt-mini-hints">◀ ▶ seek 10s · ▲ / OK related videos</div>`;
  document.body.appendChild(miniEl);
  miniTitleEl = miniEl.querySelector(".tvyt-mini-title");
  miniSubEl = miniEl.querySelector(".tvyt-mini-sub");
  miniFillEl = miniEl.querySelector(".tvyt-mini-fill");

  toastEl = document.createElement("div");
  toastEl.id = "tvyt-toast";
  document.body.appendChild(toastEl);
  rehostOverlay();
}

// Only the fullscreen element (and its subtree) renders in fullscreen, so
// follow it there or the grid/mini bar vanish behind the player.
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

function cardHtml(item: CardItem): string {
  const safe = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<div class="tvyt-thumb"><img loading="lazy" alt="" src="${safe(item.thumbnail)}" />` +
    (item.duration ? `<span class="tvyt-dur">${safe(item.duration)}</span>` : "") +
    `</div><div class="tvyt-title">${safe(item.title) || "(untitled)"}</div>` +
    (item.channel ? `<div class="tvyt-channel">${safe(item.channel)}</div>` : "") +
    (item.meta ? `<div class="tvyt-meta">${safe(item.meta)}</div>` : "");
}

// The mini bar is a momentary overlay, not a resident panel: it lights up on
// activity (commands, play/pause/seeks, entering a video) and gets out of the
// way after a few idle seconds so the video owns the screen.
let miniLit = false;
let miniTimer = 0;
const MINI_IDLE_MS = 4000;

function pokeMini(): void {
  miniLit = true;
  if (miniEl) miniEl.hidden = !(state.tvMode && state.screen === "watch" && !state.expanded);
  window.clearTimeout(miniTimer);
  miniTimer = window.setTimeout(() => {
    miniLit = false;
    if (miniEl) miniEl.hidden = true;
  }, MINI_IDLE_MS);
}

function renderAll(): void {
  ensureOverlay();
  // Cinema restyle only while the video itself is the screen: fullscreen
  // overlay (browse/search/expanded grid) covers the page anyway.
  document.documentElement.classList.toggle(
    "tvyt-cinema", state.tvMode && state.screen === "watch" && !state.expanded);
  if (!rootEl || !gridEl) return;
  const showGrid = state.tvMode && (state.screen !== "watch" || state.expanded);
  rootEl.hidden = !showGrid;
  if (miniEl) miniEl.hidden = !(state.tvMode && state.screen === "watch" && !state.expanded && miniLit);

  if (showGrid) {
    if (headQueryEl) headQueryEl.textContent = state.screen === "search" ? `“${state.query}”` : "";
    if (headHintsEl) headHintsEl.textContent = "D-pad: move · OK: play · ◀ Back";
    gridEl.innerHTML = "";
    state.items.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "tvyt-card" + (i === state.focusIndex ? " focused" : "");
      card.dataset.index = String(i);
      card.innerHTML = cardHtml(item);
      card.addEventListener("click", () => openItem(i));
      gridEl!.appendChild(card);
    });
    if (emptyEl) emptyEl.hidden = state.items.length > 0;
  }
  renderMini();
  updateFocus();
}

function renderMini(): void {
  if (!miniEl || !miniTitleEl || !miniSubEl || !miniFillEl) return;
  const np = readNowPlaying();
  if (!np) return;
  miniTitleEl.textContent = np.title;
  const time = np.durationSec > 0 ? `${formatTime(np.currentTimeSec)} / ${formatTime(np.durationSec)}` : "";
  const rate = np.rate !== 1 ? `${np.rate}×` : "";
  miniSubEl.textContent = [np.channel, np.paused ? "Paused" : "Playing", time, rate].filter(Boolean).join(" · ");
  miniFillEl.style.width = np.durationSec > 0 ? `${(np.currentTimeSec / np.durationSec) * 100}%` : "0%";
  renderScrubPreview(np);
}

// Frame + time floating over the track at the phone's drag position. The
// inner div is the sprite at native size, scaled to the frame box.
function renderScrubPreview(np: NowPlaying): void {
  const box = miniEl?.querySelector<HTMLElement>(".tvyt-mini-preview");
  if (!box) return;
  const t = state.scrubSec;
  box.hidden = t === null || np.durationSec <= 0;
  if (t === null || np.durationSec <= 0) return;
  const pct = Math.min(100, Math.max(0, (t / np.durationSec) * 100));
  box.style.left = `clamp(6vw, ${pct}%, calc(100% - 6vw))`;
  box.querySelector("span")!.textContent = formatTime(t);
  const frameBox = box.querySelector<HTMLElement>(".tvyt-mini-frame")!;
  const sprite = frameBox.firstElementChild as HTMLElement;
  frameBox.hidden = !np.storyboard;
  if (!np.storyboard) return;
  const sb = np.storyboard;
  const f = storyboardFrame(sb, t, np.durationSec);
  // Box height is fixed; width follows the frames (vertical videos too).
  frameBox.style.aspectRatio = `${sb.width} / ${sb.height}`;
  sprite.style.width = `${sb.width}px`;
  sprite.style.height = `${sb.height}px`;
  sprite.style.backgroundImage = `url("${f.url}")`;
  sprite.style.backgroundPosition = `-${f.x}px -${f.y}px`;
  sprite.style.transform = `scale(${frameBox.clientHeight / sb.height})`;
}

let scrubTimer = 0;

function scrubPreview(seconds: number | null): void {
  state.scrubSec = seconds;
  window.clearTimeout(scrubTimer);
  // A dropped connection mid-drag must not leave the preview up.
  if (seconds !== null) scrubTimer = window.setTimeout(() => scrubPreview(null), 2000);
  renderMini();
}

function updateFocus(): void {
  if (!gridEl) return;
  gridEl.querySelectorAll(".tvyt-card.focused").forEach((el) => el.classList.remove("focused"));
  const target = gridEl.querySelector(`[data-index="${state.focusIndex}"]`);
  if (target) {
    target.classList.add("focused");
    target.scrollIntoView({ block: "nearest" });
  }
}

function setTvMode(on: boolean): void {
  state.tvMode = on;
  renderAll();
  reportContext(true);
}

// --- Commands from the phone ---

function openVideoId(videoId: string): void {
  location.href = watchUrl(videoId);
}

function openItem(index: number): void {
  const item = state.items[index];
  if (item) openVideoId(item.videoId);
}

function togglePlay(): void {
  const v = currentVideo();
  if (!v) return;
  if (v.paused) void v.play().catch(() => {});
  else v.pause();
}

function seekTo(seconds: number): void {
  const v = currentVideo();
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = Math.max(0, Math.min(v.duration, seconds));
}

function toggleCaptions(): void {
  const btn = subtitlesButton();
  if (readCaptions() === null || !btn) {
    toast("No captions for this video");
    return;
  }
  btn.click();
  toast(readCaptions() ? "Captions on" : "Captions off");
}

// The service sends a real F13 keypress for "fullscreen" (see
// WindowsLauncher.fullscreen). Catching it in capture phase works wherever
// focus is, and the trusted key grants the activation the player's own
// requestFullscreen needs.
function onFullscreenKey(e: KeyboardEvent): void {
  if (!e.isTrusted || e.key !== "F13") return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const btn = document.querySelector<HTMLElement>(".ytp-fullscreen-button");
  if (state.screen === "watch" && btn) btn.click();
  else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else toast("Open a video to go fullscreen");
}

function setQuality(level: string): void {
  requestPlayer({ set: level });
  toast(level === "auto" ? "Quality: Auto" : `Quality: ${level}`);
}

function runSearch(text: string): void {
  state.query = text;
  // Plain navigation: doesn't depend on the masthead form being rendered.
  location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
}

// The grid is fixed at 4 columns by CSS; focus math must agree with it.
const GRID_COLUMNS = 4;

export function handleCommand(command: Command): void {
  if (!state.tvMode) setTvMode(true);
  pokeMini();
  switch (command.type) {
    case "navigate": {
      // On a playing video with the grid tucked away, arrows drive playback:
      // sideways seeks, anything else opens the related grid.
      if (state.screen === "watch" && !state.expanded) {
        if (command.direction === "left" || command.direction === "right") {
          const v = currentVideo();
          if (v) seekTo(v.currentTime + (command.direction === "left" ? -10 : 10));
        } else {
          state.expanded = true;
          renderAll();
        }
        break;
      }
      const next = moveFocus(state.focusIndex, state.items.length, GRID_COLUMNS, command.direction);
      if (next !== state.focusIndex) {
        state.focusIndex = next;
        updateFocus();
      }
      break;
    }
    case "select":
      if (state.screen === "watch" && !state.expanded) {
        state.expanded = true;
        renderAll();
      } else {
        openItem(state.focusIndex);
      }
      break;
    case "back":
      if (state.screen === "watch" && state.expanded) {
        state.expanded = false;
        renderAll();
      } else if (state.screen === "watch" && history.length > 1) {
        // Back to wherever the video was opened from (search results, home).
        history.back();
      } else if (state.screen === "watch" || state.screen === "search") {
        location.href = "https://www.youtube.com/";
      } else {
        toast("Press Home on the phone for TV Home");
      }
      break;
    case "playPause":
      togglePlay();
      break;
    case "seek": {
      const v = currentVideo();
      if (v) seekTo(v.currentTime + command.seconds);
      break;
    }
    case "seekTo":
      scrubPreview(null);
      seekTo(command.seconds);
      break;
    case "scrub":
      scrubPreview(command.seconds);
      break;
    case "speed":
      requestPlayer({ rate: command.rate });
      toast(`Speed ${command.rate}×`);
      break;
    case "captions":
      toggleCaptions();
      break;
    case "quality":
      setQuality(command.level);
      break;
    case "openVideo":
      openVideoId(command.videoId);
      break;
    case "search":
      runSearch(command.text);
      break;
    default:
      break;
  }
  reportContext(true);
  // Captions/quality settle a beat after the click/API call.
  window.setTimeout(() => reportContext(), 300);
}

// --- Page tracking ---

let scanTimer = 0;
let lastScan = 0;
const SCAN_EVERY_MS = 1000;

function refreshFromPage(resetFocus: boolean): void {
  const screen = screenForPath(location.pathname, location.search);
  const screenChanged = screen !== state.screen;
  if (screenChanged) {
    state.screen = screen;
    state.expanded = false;
    resetFocus = true;
    if (screen === "watch") pokeMini();
    if (screen === "search") {
      try {
        state.query = new URLSearchParams(location.search).get("search_query") ?? state.query;
      } catch {
        /* keep pending query */
      }
    } else if (screen === "browse") {
      state.query = "";
    }
  }
  const items = scrapeItems();
  // Mid-render scans come back empty; keep the grid unless the page changed.
  if (items.length > 0 || screenChanged) {
    const sig = items.map((i) => i.videoId).join(",");
    if (sig !== state.items.map((i) => i.videoId).join(",")) {
      state.items = items;
      resetFocus = true;
    }
  }
  if (resetFocus) state.focusIndex = 0;
  bindVideo();
  renderAll();
  reportContext();
}

// Throttled, not debounced: a playing page mutates constantly (progress,
// timestamps), which starves a debounce so grids stay empty forever.
function scheduleRefresh(): void {
  const now = Date.now();
  if (now - lastScan < SCAN_EVERY_MS) {
    if (!scanTimer) {
      scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        lastScan = Date.now();
        refreshFromPage(false);
      }, SCAN_EVERY_MS - (now - lastScan));
    }
    return;
  }
  lastScan = now;
  refreshFromPage(false);
}

function bindVideo(): void {
  const v = currentVideo();
  if (v === boundVideo) return;
  boundVideo = v;
  if (!v) return;
  v.addEventListener("play", () => { pokeMini(); reportContext(true); });
  v.addEventListener("pause", () => { pokeMini(); reportContext(true); });
  v.addEventListener("seeked", () => {
    pokeMini();
    renderMini();
    reportContext(true);
  });
  v.addEventListener("timeupdate", () => {
    renderMini();
    maybeRecordRecent();
    reportContext();
  });
  // New video loaded or the stream's resolution changed: re-read qualities.
  v.addEventListener("loadedmetadata", () => requestPlayer());
  v.addEventListener("resize", () => requestPlayer());
  v.addEventListener("ratechange", () => { renderMini(); reportContext(); });
  requestPlayer();
}

// --- Boot (document_start: body may not exist yet) ---

const HEARTBEAT_MS = 20_000;

export function startYoutubeAdapter(): void {
  ensureStyle();
  loadRecent();
  window.addEventListener("keydown", onFullscreenKey, true);
  document.addEventListener("tvyt:player", onPlayerInfo);
  document.addEventListener("fullscreenchange", rehostOverlay);
  postToBackground({ kind: "tvHello", app: "youtube" });
  // Keeps the background worker (and its socket) alive and re-registers
  // this tab if the worker was restarted.
  window.setInterval(() => postToBackground({ kind: "tvHello", app: "youtube" }), HEARTBEAT_MS);

  document.addEventListener("DOMContentLoaded", () => refreshFromPage(true));
  document.addEventListener("yt-navigate-finish", () => refreshFromPage(true));
  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  refreshFromPage(true);

  chrome.runtime.onMessage.addListener((msg: { kind?: string; command?: Command }) => {
    if (msg?.kind === "tvCommand" && msg.command) handleCommand(msg.command);
    else if (msg?.kind === "tvRefresh") reportContext(true);
  });

  // PC keyboard for desk debugging: arrows move, Enter selects, space plays.
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || !state.tvMode) return;
    const map: Record<string, Command> = {
      ArrowUp: { type: "navigate", direction: "up" },
      ArrowDown: { type: "navigate", direction: "down" },
      ArrowLeft: { type: "navigate", direction: "left" },
      ArrowRight: { type: "navigate", direction: "right" },
      Enter: { type: "select" },
      Backspace: { type: "back" },
      " ": { type: "playPause" },
    };
    const cmd = map[e.key];
    if (cmd) {
      e.preventDefault();
      handleCommand(cmd);
    }
  });
}
