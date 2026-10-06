import type { Command, HistoryEntry, NowPlaying, VideoItem, YoutubeContext } from "@tv-control/shared";
import { OVERLAY_CSS } from "./overlayStyles.js";
import {
  formatTime,
  mergeHistory,
  moveFocus,
  screenForPath,
  videoIdFromHref,
  watchUrl,
} from "./ytLib.js";

// YouTube site adapter: a readable 10-foot overlay (grid + mini player bar)
// driven by phone commands relayed through the background service worker.
// It scrapes YouTube's own rendered DOM — no API key, works signed-in with
// the household account.

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
  history: HistoryEntry[];
  lastReport: string;
  lastHistoryId: string;
  lastHistoryAt: number;
}

const state: AdapterState = {
  screen: "browse",
  query: "",
  items: [],
  focusIndex: 0,
  expanded: false,
  tvMode: true,
  history: [],
  lastReport: "",
  lastHistoryId: "",
  lastHistoryAt: 0,
};

const HISTORY_KEY = "tvyt.history";

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
  maybeRecordHistory(nowPlaying);
  const context: YoutubeContext = {
    app: "youtube",
    screen: state.screen,
    query: state.query,
    items: state.items.map(({ videoId, title, channel, thumbnail }) => ({ videoId, title, channel, thumbnail })),
    focusIndex: state.focusIndex,
    nowPlaying,
    history: state.history,
  };
  // Round playback time so timeupdate doesn't spam the socket every frame.
  const key = JSON.stringify({ ...context, nowPlaying: nowPlaying && { ...nowPlaying, currentTimeSec: Math.floor(nowPlaying.currentTimeSec) } });
  if (!force && key === state.lastReport) return;
  state.lastReport = key;
  postToBackground({ kind: "tvContext", context });
}

// --- DOM scraping (YouTube's own renderers; tolerant of layout changes) ---

// Current YouTube renders every video lockup (home, results, related) as
// yt-lockup-view-model; the legacy ytd-*-renderer tags below are a fallback.
const LOCKUP_SELECTOR = "yt-lockup-view-model";
const LEGACY_SELECTORS = ["ytd-rich-item-renderer", "ytd-video-renderer", "ytd-compact-video-renderer"];

function clean(s: string | null | undefined, cap: number): string {
  return (s ?? "").trim().replace(/\s+/g, " ").slice(0, cap);
}

function parseLockup(el: Element): CardItem | null {
  if (el.closest("ytd-ad-slot-renderer")) return null;
  const host = el.querySelector(".ytLockupViewModelHost");
  const idFromClass = /content-id-([A-Za-z0-9_-]{11})/.exec(host?.className ?? "")?.[1] ?? null;
  const thumbAnchor = el.querySelector<HTMLAnchorElement>('a.ytLockupViewModelContentImage[href*="/watch"]');
  const anyLink = el.querySelector<HTMLAnchorElement>('a[href*="/watch?v="]');
  const videoId = idFromClass ?? videoIdFromHref(thumbAnchor?.getAttribute("href") ?? anyLink?.getAttribute("href"));
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
  const duration = clean(el.querySelector(".ytBadgeShapeText")?.textContent, 20);
  const img = el.querySelector<HTMLImageElement>("img.ytCoreImageHost")
    ?? el.querySelector<HTMLImageElement>("img");
  const src = img?.getAttribute("src") ?? "";
  return {
    videoId,
    title,
    channel: clean(channelAnchor?.textContent, 200),
    thumbnail: src.startsWith("http") ? src : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    duration,
    meta: lockupMeta(el),
  };
}

// "1.2M views · 3 days ago" from the lockup metadata. Regexes stay narrow so
// title words never match; metadata node preferred, whole card as fallback.
function lockupMeta(el: Element): string {
  const scopes = [
    el.querySelector("yt-lockup-metadata-view-model")?.textContent,
    el.textContent,
  ];
  for (const scope of scopes) {
    const text = (scope ?? "").replace(/\s+/g, " ");
    const views = /([\d.,]+\s*[KMB]?\s*views?)\b/i.exec(text)?.[1];
    const age = /(\d[\d,]*\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i.exec(text)?.[1];
    if (views || age) return [views, age].filter(Boolean).join(" · ");
  }
  return "";
}

function scrapeItems(): CardItem[] {
  const out: CardItem[] = [];
  const seen = new Set<string>();
  try {
    const lockups = [...document.querySelectorAll(LOCKUP_SELECTOR)];
    if (lockups.length > 0) {
      for (const el of lockups) {
        if (out.length >= 60) break;
        const item = parseLockup(el);
        if (!item || seen.has(item.videoId)) continue;
        seen.add(item.videoId);
        out.push(item);
      }
      return out;
    }
    for (const el of document.querySelectorAll(LEGACY_SELECTORS.join(","))) {
      if (out.length >= 60) break;
      const link = el.querySelector<HTMLAnchorElement>('a[href*="/watch?v="]');
      const videoId = videoIdFromHref(link?.getAttribute("href"));
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      const title = clean(el.querySelector("#video-title")?.textContent, 300)
        || clean(el.querySelector("#video-title-link")?.textContent, 300)
        || clean(link?.getAttribute("title"), 300);
      if (!title) continue;
      const channel = clean(el.querySelector("ytd-channel-name")?.textContent, 200);
      const duration = clean(el.querySelector("ytd-thumbnail-overlay-time-status-renderer")?.textContent, 20);
      out.push({
        videoId,
        title,
        channel,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        duration,
        meta: lockupMeta(el),
      });
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
  const channel = rawChannel.replace(/^(.+?)\s+\1$/, "$1");
  return {
    videoId,
    title: rawTitle.replace(/ - YouTube$/, "").slice(0, 300) || videoId,
    channel,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    currentTimeSec: v ? v.currentTime : 0,
    durationSec: v && Number.isFinite(v.duration) ? v.duration : 0,
    paused: v ? v.paused : true,
  };
}

// --- TV overlay ---

let rootEl: HTMLElement | null = null;
let gridEl: HTMLElement | null = null;
let headQueryEl: HTMLElement | null = null;
let headHintsEl: HTMLElement | null = null;
let historyRowEl: HTMLElement | null = null;
let historyLabelEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let toastTimer = 0;
let miniEl: HTMLElement | null = null;
let miniTitleEl: HTMLElement | null = null;
let miniSubEl: HTMLElement | null = null;
let miniFillEl: HTMLElement | null = null;
let boundVideo: HTMLVideoElement | null = null;

function ensureOverlay(): void {
  if (rootEl) return;
  if (!document.head || !document.body) return;
  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);

  rootEl = document.createElement("div");
  rootEl.id = "tvyt-root";
  rootEl.innerHTML = `
    <div class="tvyt-head">
      <div class="tvyt-brand">YouTube<span>TV</span></div>
      <div class="tvyt-query"></div>
      <div class="tvyt-hints"></div>
      <button class="tvyt-exit" type="button">Exit TV mode</button>
    </div>
    <div class="tvyt-rowlabel" hidden></div>
    <div class="tvyt-hrow" hidden></div>
    <div class="tvyt-grid"></div>
    <div class="tvyt-empty" hidden>No videos found on this page yet.</div>
    <div class="tvyt-toast"></div>`;
  document.body.appendChild(rootEl);
  headQueryEl = rootEl.querySelector(".tvyt-query");
  headHintsEl = rootEl.querySelector(".tvyt-hints");
  historyLabelEl = rootEl.querySelector(".tvyt-rowlabel");
  historyRowEl = rootEl.querySelector(".tvyt-hrow");
  gridEl = rootEl.querySelector(".tvyt-grid");
  emptyEl = rootEl.querySelector(".tvyt-empty");
  toastEl = rootEl.querySelector(".tvyt-toast");
  rootEl.querySelector(".tvyt-exit")?.addEventListener("click", () => setTvMode(false));

  miniEl = document.createElement("div");
  miniEl.id = "tvyt-minibar";
  miniEl.innerHTML = `
    <div class="tvyt-mini-title"></div>
    <div class="tvyt-mini-sub"></div>
    <div class="tvyt-mini-track"><div class="tvyt-mini-fill"></div></div>
    <div class="tvyt-mini-hints"></div>`;
  document.body.appendChild(miniEl);
  miniTitleEl = miniEl.querySelector(".tvyt-mini-title");
  miniSubEl = miniEl.querySelector(".tvyt-mini-sub");
  miniFillEl = miniEl.querySelector(".tvyt-mini-fill");
}

function toast(msg: string): void {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), 2200);
}

function cardHtml(item: CardItem): string {
  const safe = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<div class="tvyt-thumb"><img loading="lazy" alt="" src="${item.thumbnail}" />` +
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
  if (miniEl) miniEl.hidden = false;
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
  try {
    document.documentElement.classList.toggle(
      "tvyt-cinema", state.tvMode && state.screen === "watch" && !state.expanded);
  } catch {
    /* document not ready */
  }
  if (!rootEl || !gridEl) return;
  const showGrid = state.tvMode && (state.screen !== "watch" || state.expanded);
  rootEl.hidden = !showGrid;
  if (miniEl) miniEl.hidden = !(state.tvMode && state.screen === "watch" && !state.expanded && miniLit);

  if (showGrid) {
    if (headQueryEl) headQueryEl.textContent = state.screen === "search" ? `“${state.query}”` : "";
    if (headHintsEl) headHintsEl.textContent = "D-pad: move · OK: play · ◀ Back";
    renderHistoryRow();
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

function renderHistoryRow(): void {
  if (!historyRowEl || !historyLabelEl) return;
  const show = state.history.length > 0 && state.screen !== "watch";
  historyLabelEl.hidden = !show;
  historyRowEl.hidden = !show;
  if (!show) return;
  historyLabelEl.textContent = "Continue watching";
  historyRowEl.innerHTML = "";
  state.history.slice(0, 12).forEach((h) => {
    const card = document.createElement("div");
    card.className = "tvyt-card tvyt-hcard";
    card.innerHTML = cardHtml({ ...h, duration: "", meta: "" });
    card.addEventListener("click", () => openVideoId(h.videoId));
    historyRowEl!.appendChild(card);
  });
}

function renderMini(): void {
  if (!miniEl || !miniTitleEl || !miniSubEl || !miniFillEl) return;
  const np = readNowPlaying();
  if (!np) return;
  miniTitleEl.textContent = np.title;
  const time = np.durationSec > 0 ? `${formatTime(np.currentTimeSec)} / ${formatTime(np.durationSec)}` : "";
  miniSubEl.textContent = [np.channel, np.paused ? "Paused" : "Playing", time].filter(Boolean).join(" · ");
  miniFillEl.style.width = np.durationSec > 0 ? `${(np.currentTimeSec / np.durationSec) * 100}%` : "0%";
  const hints = miniEl.querySelector(".tvyt-mini-hints");
  if (hints) hints.textContent = "▲▼ OK: related videos · ◀▶: seek 10s · ❚❚: play/pause";
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

// Fullscreen the whole page (not just the video) so the TV overlay and mini
// bar keep rendering on top. Needs a user gesture chain; when the browser
// refuses, say so instead of failing silently.
function toggleFullscreen(): void {
  try {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => toast("Couldn't leave fullscreen"));
    } else {
      void document.documentElement.requestFullscreen().catch(() =>
        toast("Fullscreen blocked — use the player's ⛶ button"));
    }
  } catch {
    toast("Fullscreen unavailable here");
  }
}

function seekBy(seconds: number): void {
  const v = currentVideo();
  if (!v || !Number.isFinite(v.duration)) return;
  v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + seconds));
}

function runSearch(text: string): void {
  state.query = text;
  const input = document.querySelector<HTMLInputElement>('input[name="search_query"]');
  const before = location.href;
  if (input) {
    try {
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form")?.requestSubmit();
    } catch {
      /* fall through to hard navigation */
    }
  }
  // YouTube's SPA usually navigates on submit; if it didn't, go directly.
  window.setTimeout(() => {
    if (location.href === before) {
      location.href = `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
    }
  }, 1500);
  toast(`Searching “${text}”…`);
}

// The grid is fixed at 4 columns by CSS; focus math must agree with it.
function gridColumns(): number {
  return 4;
}

export function handleCommand(command: Command): void {
  if (!state.tvMode) setTvMode(true);
  pokeMini();
  switch (command.type) {
    case "navigate": {
      // On a playing video with the grid tucked away, arrows drive playback:
      // sideways seeks, anything else opens the related grid.
      if (state.screen === "watch" && !state.expanded) {
        if (command.direction === "left" || command.direction === "right") {
          seekBy(command.direction === "left" ? -10 : 10);
        } else {
          state.expanded = true;
          renderAll();
        }
        break;
      }
      const next = moveFocus(state.focusIndex, state.items.length, gridColumns(), command.direction);
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
      } else if (state.screen === "watch" || state.screen === "search") {
        location.href = "https://www.youtube.com/";
      } else {
        toast("Press Home on the phone for TV Home");
      }
      break;
    case "playPause":
      togglePlay();
      break;
    case "fullscreen":
      toggleFullscreen();
      break;
    case "seek":
      seekBy(command.seconds);
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
}

// --- History (local: survives restarts, no account API needed) ---

function loadHistory(): void {
  try {
    chrome.storage.local.get([HISTORY_KEY], (res) => {
      const raw = res[HISTORY_KEY];
      if (Array.isArray(raw)) {
        state.history = raw
          .filter((h): h is HistoryEntry =>
            typeof h === "object" && h !== null && typeof (h as HistoryEntry).videoId === "string")
          .slice(0, 50);
        renderAll();
        reportContext(true);
      }
    });
  } catch {
    /* storage unavailable */
  }
}

function saveHistory(): void {
  try {
    chrome.storage.local.set({ [HISTORY_KEY]: state.history });
  } catch {
    /* ignore */
  }
}

function maybeRecordHistory(np: NowPlaying | null): void {
  if (!np || !np.title || np.title === np.videoId) return;
  const now = Date.now();
  if (np.videoId === state.lastHistoryId && now - state.lastHistoryAt < 60_000) return;
  state.lastHistoryId = np.videoId;
  state.lastHistoryAt = now;
  state.history = mergeHistory(state.history, np, new Date().toISOString());
  saveHistory();
  renderHistoryRow();
}

// --- Page tracking ---

let scanTimer = 0;
let lastScan = 0;
const SCAN_EVERY_MS = 1500;

function refreshFromPage(resetFocus: boolean): void {
  const screen = screenForPath(location.pathname, location.search);
  if (screen !== state.screen) {
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
  if (screen !== "watch") {
    const items = scrapeItems();
    if (items.length > 0 || state.items.length === 0) {
      const sig = items.map((i) => i.videoId).join(",");
      const prev = state.items.map((i) => i.videoId).join(",");
      if (sig !== prev) {
        state.items = items;
        resetFocus = true;
      }
    }
  } else {
    const related = scrapeItems();
    if (related.length > 0) {
      const sig = related.map((i) => i.videoId).join(",");
      if (sig !== state.items.map((i) => i.videoId).join(",")) {
        state.items = related;
        resetFocus = true;
      }
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
      }, SCAN_EVERY_MS);
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
    reportContext();
  });
}

// --- Boot ---

export function startYoutubeAdapter(): void {
  loadHistory();
  ensureOverlay();
  postToBackground({ kind: "tvHello", app: "youtube" });
  refreshFromPage(true);

  document.addEventListener("yt-navigate-finish", () => refreshFromPage(true));
  window.addEventListener("yt-navigate-finish", () => refreshFromPage(true));
  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

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
