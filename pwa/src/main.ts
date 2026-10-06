// Living Room remote: app launchers, Home + volume, and a YouTube panel that
// appears only while YouTube is the active app. The panel renders the adapter
// context pushed by the server (now playing, captions, quality).

import {
  storyboardFrame,
  type AppContext,
  type Command,
  type NowPlaying,
  type ServerMessage,
  type ServerState,
  type YoutubeContext,
} from "@tv-control/shared";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const statusEl = $("#status");
const statusText = statusEl.querySelector("span")!;
const muteBtn = $("#mute");
const ytSection = $("#yt");
const ytConn = $("#yt-conn");
const npBox = $("#yt-now");
const npThumb = $<HTMLImageElement>("#np-thumb");
const npTitle = $("#np-title");
const npChannel = $("#np-channel");
const npScrub = $<HTMLInputElement>("#np-scrub");
const npCur = $("#np-cur");
const npDur = $("#np-dur");
const npPlay = $("#np-play");
const npCc = $<HTMLButtonElement>("#np-cc");
const npQuality = $<HTMLSelectElement>("#np-quality");
const npQualityLabel = $("#np-quality-label");
const npSpeed = $<HTMLSelectElement>("#np-speed");
const npSpeedLabel = $("#np-speed-label");
const npPreview = $("#np-preview");
const resultsBox = $("#yt-results-box");
const resultsTitle = $("#yt-results-title");
const resultsList = $("#yt-results");
const recentBox = $("#yt-recent-box");
const recentRow = $("#yt-recent");
const searchForm = $<HTMLFormElement>("#yt-search");
const searchInput = $<HTMLInputElement>("#yt-q");

// --- Connection ---

function serverUrl(): string {
  return `ws://${window.location.hostname || "localhost"}:8080`;
}

let ws: WebSocket | null = null;
let retryTimer = 0;
let lastMessageAt = 0;
let latestState: ServerState | null = null;
let latestYt: YoutubeContext | null = null;
let npReceivedAt = 0;

function setStatus(kind: "ok" | "wait" | "down", text: string): void {
  statusEl.dataset.kind = kind;
  statusText.textContent = text;
}

function send(cmd: Command): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  } else {
    setStatus("wait", "reconnecting…");
    connect();
  }
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  window.clearTimeout(retryTimer);
  setStatus("wait", "connecting…");
  const socket = new WebSocket(serverUrl());
  ws = socket;
  socket.onopen = () => {
    lastMessageAt = Date.now();
    setStatus("ok", "connected");
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setStatus("down", "offline — retrying");
    retryTimer = window.setTimeout(connect, 1500);
  };
  socket.onerror = () => socket.close();
  socket.onmessage = (ev) => {
    lastMessageAt = Date.now();
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "state") {
        latestState = msg.state;
        render();
      } else if (msg.type === "context") {
        onContext(msg.context);
      }
    } catch { /* ignore */ }
  };
}

// iOS freezes the page when the phone locks and the socket can come back as a
// zombie that still reads OPEN. Ping on wake (and periodically); no reply
// within a few seconds means drop it and redial.
function checkAlive(): void {
  if (document.visibilityState !== "visible") return;
  if (ws?.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }
  const sentAt = Date.now();
  send({ type: "ping" });
  window.setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN && lastMessageAt < sentAt) ws.close();
  }, 3000);
}

document.addEventListener("visibilitychange", checkAlive);
window.addEventListener("pageshow", checkAlive);
window.setInterval(checkAlive, 15_000);

// --- Rendering ---

function onContext(context: AppContext): void {
  if (context.app !== "youtube") return;
  latestYt = context;
  npReceivedAt = Date.now();
  render();
}

function render(): void {
  const active = latestState?.activeApp ?? "unknown";
  document.querySelectorAll<HTMLElement>(".app").forEach((el) => {
    el.classList.toggle("active", el.dataset.app === active);
  });
  muteBtn.classList.toggle("on", latestState?.volumeMuted ?? false);

  const live = latestState?.adapters.includes("youtube") ?? false;
  // After a server restart activeApp is unknown; a live adapter still means
  // YouTube is what's on screen.
  const showYt = active === "youtube" || (active === "unknown" && live);
  ytSection.hidden = !showYt;
  if (!showYt) return;

  ytSection.classList.toggle("offline", !live);
  ytConn.textContent = live ? "" : "Waiting for TV…";
  ytConn.hidden = live;
  renderNowPlaying(latestYt?.nowPlaying ?? null);
  renderRecent();
  renderResults();
}

// Search results mirrored from the TV grid; tap one to play it there.
let resultsSig = "";

function renderResults(): void {
  const yt = latestYt;
  const items = yt?.screen === "search" ? yt.results : [];
  resultsBox.hidden = items.length === 0;
  resultsTitle.textContent = yt?.query ? `Results for “${yt.query}”` : "Results";
  const sig = items.map((r) => r.videoId).join(",");
  if (sig === resultsSig) return;
  resultsSig = sig;
  resultsList.innerHTML = "";
  resultsList.scrollTop = 0;
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "res";
    const thumb = document.createElement("div");
    thumb.className = "res-thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = item.thumbnail;
    thumb.appendChild(img);
    if (item.duration) {
      const dur = document.createElement("b");
      dur.textContent = item.duration;
      thumb.appendChild(dur);
    }
    const text = document.createElement("div");
    text.className = "res-text";
    const title = document.createElement("span");
    title.className = "res-title";
    title.textContent = item.title;
    const sub = document.createElement("span");
    sub.className = "res-sub";
    sub.textContent = [item.channel, item.meta].filter(Boolean).join(" · ");
    text.append(title, sub);
    btn.append(thumb, text);
    btn.addEventListener("click", () => send({ type: "openVideo", videoId: item.videoId }));
    resultsList.appendChild(btn);
  }
}

// Horizontal strip of recently watched videos; tap to play on the TV. The
// video already on screen is left out.
let recentSig = "";

function renderRecent(): void {
  const playing = latestYt?.nowPlaying?.videoId;
  const items = (latestYt?.recent ?? []).filter((r) => r.videoId !== playing).slice(0, 10);
  recentBox.hidden = items.length === 0;
  const sig = items.map((r) => r.videoId).join(",");
  if (sig === recentSig) return;
  recentSig = sig;
  recentRow.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rc";
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = item.thumbnail || `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`;
    const title = document.createElement("span");
    title.textContent = item.title;
    btn.append(img, title);
    btn.addEventListener("click", () => send({ type: "openVideo", videoId: item.videoId }));
    recentRow.appendChild(btn);
  }
}

const QUALITY_LABELS: Record<string, string> = {
  auto: "Auto", highres: "4320p", hd2160: "2160p", hd1440: "1440p", hd1080: "1080p",
  hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p",
};
let qualitySig = "";

function renderNowPlaying(np: NowPlaying | null): void {
  npBox.hidden = np === null;
  if (!np) return;
  const thumb = np.thumbnail;
  if (npThumb.getAttribute("src") !== thumb) npThumb.src = thumb;
  npTitle.textContent = np.title;
  npChannel.textContent = np.channel;
  npPlay.classList.toggle("paused", np.paused);

  npCc.disabled = np.captions === null;
  npCc.classList.toggle("on", np.captions === true);

  const levels = np.qualities.includes("auto") || np.qualities.length === 0
    ? np.qualities
    : [...np.qualities, "auto"];
  const sig = levels.join(",");
  if (sig !== qualitySig) {
    qualitySig = sig;
    npQuality.innerHTML = "";
    for (const level of levels) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = QUALITY_LABELS[level] ?? level;
      npQuality.appendChild(opt);
    }
  }
  npQuality.disabled = levels.length === 0;
  npQuality.value = np.quality;
  npQualityLabel.textContent = levels.length === 0 ? "Quality" : QUALITY_LABELS[np.quality] ?? (np.quality || "Quality");
  npSpeed.value = String(np.rate);
  npSpeedLabel.textContent = `${np.rate}×`;
  tickTimeline();
}

// --- Timeline: interpolated between context updates, draggable to seek ---

let scrubbing = false;
let scrubHoldUntil = 0;

function currentTime(np: NowPlaying): number {
  const drift = np.paused ? 0 : (Date.now() - npReceivedAt) / 1000;
  return Math.min(np.durationSec, np.currentTimeSec + drift);
}

function tickTimeline(): void {
  const np = latestYt?.nowPlaying;
  if (!np || scrubbing || Date.now() < scrubHoldUntil) return;
  const t = currentTime(np);
  npScrub.value = String(np.durationSec > 0 ? Math.round((t / np.durationSec) * 1000) : 0);
  npScrub.style.setProperty("--pct", `${Number(npScrub.value) / 10}%`);
  npCur.textContent = fmtTime(t);
  npDur.textContent = np.durationSec > 0 ? fmtTime(np.durationSec) : "--:--";
}
window.setInterval(tickTimeline, 250);

// Preview frame over the thumb while dragging (storyboard sprite at native
// size, scaled into the frame box), mirrored to the TV via throttled scrubs.
const SCRUB_SEND_MS = 120;
let lastScrubSent = 0;
let pendingScrub = 0;

function showPreview(np: NowPlaying, t: number): void {
  const pct = Number(npScrub.value) / 10;
  npPreview.hidden = false;
  npPreview.style.left = `clamp(52px, ${pct}%, calc(100% - 52px))`;
  npPreview.querySelector("span")!.textContent = fmtTime(t);
  const frameBox = npPreview.querySelector<HTMLElement>(".frame")!;
  const sprite = frameBox.firstElementChild as HTMLElement;
  const sb = np.storyboard;
  frameBox.hidden = !sb;
  if (!sb) return;
  const f = storyboardFrame(sb, t, np.durationSec);
  // Box height is fixed; width follows the frames (vertical videos too).
  frameBox.style.aspectRatio = `${sb.width} / ${sb.height}`;
  sprite.style.width = `${sb.width}px`;
  sprite.style.height = `${sb.height}px`;
  sprite.style.backgroundImage = `url("${f.url}")`;
  sprite.style.backgroundPosition = `-${f.x}px -${f.y}px`;
  sprite.style.transform = `scale(${frameBox.clientHeight / sb.height})`;
}

function sendScrub(seconds: number): void {
  window.clearTimeout(pendingScrub);
  const wait = SCRUB_SEND_MS - (Date.now() - lastScrubSent);
  if (wait <= 0) {
    lastScrubSent = Date.now();
    send({ type: "scrub", seconds });
  } else {
    pendingScrub = window.setTimeout(() => sendScrub(seconds), wait);
  }
}

npScrub.addEventListener("pointerdown", () => { scrubbing = true; });
npScrub.addEventListener("input", () => {
  scrubbing = true;
  const np = latestYt?.nowPlaying;
  npScrub.style.setProperty("--pct", `${Number(npScrub.value) / 10}%`);
  if (!np || np.durationSec <= 0) return;
  const t = (Number(npScrub.value) / 1000) * np.durationSec;
  npCur.textContent = fmtTime(t);
  showPreview(np, t);
  sendScrub(Math.round(t));
});
npScrub.addEventListener("change", () => {
  scrubbing = false;
  npPreview.hidden = true;
  window.clearTimeout(pendingScrub);
  const np = latestYt?.nowPlaying;
  if (!np || np.durationSec <= 0) return;
  // Hold the thumb where it was dropped until the TV reports the new spot.
  scrubHoldUntil = Date.now() + 1500;
  send({ type: "seekTo", seconds: Math.round((Number(npScrub.value) / 1000) * np.durationSec) });
});

npSpeed.addEventListener("change", () => {
  const rate = Number(npSpeed.value);
  if (rate > 0) send({ type: "speed", rate });
});

npQuality.addEventListener("change", () => {
  if (npQuality.value) send({ type: "quality", level: npQuality.value });
});

function fmtTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

// --- Buttons ---

// data-repeat buttons (d-pad, volume) fire on press and auto-repeat while
// held; everything else fires on click.
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 140;

document.querySelectorAll<HTMLButtonElement>("button[data-cmd]").forEach((btn) => {
  const cmd = JSON.parse(btn.dataset.cmd!) as Command;
  if (!btn.hasAttribute("data-repeat")) {
    btn.addEventListener("click", () => send(cmd));
    return;
  }
  let delay = 0;
  let every = 0;
  const stop = (): void => {
    window.clearTimeout(delay);
    window.clearInterval(every);
    btn.classList.remove("pressed");
  };
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stop();
    btn.classList.add("pressed");
    send(cmd);
    delay = window.setTimeout(() => {
      every = window.setInterval(() => send(cmd), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(ev, stop);
});

// --- Search ---

function closeSearch(): void {
  searchInput.blur();
  searchInput.value = "";
  searchForm.hidden = true;
}

$("#yt-search-open").addEventListener("click", () => {
  searchForm.hidden = false;
  // Must focus inside the tap handler or iOS won't raise the keyboard.
  searchInput.focus();
});
$("#yt-search-cancel").addEventListener("click", closeSearch);
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = searchInput.value.trim();
  if (!text) return;
  send({ type: "search", text });
  closeSearch();
});

// --- No zoom (iOS ignores user-scalable=no in Safari tabs) ---

document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());

connect();
