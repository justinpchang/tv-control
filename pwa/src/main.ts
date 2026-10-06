// Living Room remote: app launchers, Home + volume, and a per-app panel
// (YouTube, Prime Video) that appears only while that app is active. Panels
// render the adapter context pushed by the server.

import {
  storyboardFrame,
  type AppContext,
  type Command,
  type NowPlaying,
  type PrimeContext,
  type PrimeTitle,
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
const npPlay = $("#np-play");
const npCc = $<HTMLButtonElement>("#np-cc");
const npQuality = $<HTMLSelectElement>("#np-quality");
const npQualityLabel = $("#np-quality-label");
const npSpeed = $<HTMLSelectElement>("#np-speed");
const npSpeedLabel = $("#np-speed-label");
const resultsBox = $("#yt-results-box");
const resultsTitle = $("#yt-results-title");
const resultsList = $("#yt-results");
const recentBox = $("#yt-recent-box");
const recentRow = $("#yt-recent");
const searchForm = $<HTMLFormElement>("#yt-search");
const searchInput = $<HTMLInputElement>("#yt-q");

const pvSection = $("#pv");
const pvConn = $("#pv-conn");
const pvNow = $("#pv-now");
const pvNpTitle = $("#pv-np-title");
const pvNpEpisode = $("#pv-np-episode");
const pvAd = $("#pv-ad");
const pvPlay = $("#pv-play");
const pvCc = $("#pv-cc");
const pvSkip = $("#pv-skip");
const pvSpeed = $<HTMLSelectElement>("#pv-speed");
const pvSpeedLabel = $("#pv-speed-label");
const pvResultsBox = $("#pv-results-box");
const pvResultsTitle = $("#pv-results-title");
const pvResults = $("#pv-results");
const pvDetail = $("#pv-detail");
const pvDTitle = $("#pv-d-title");
const pvDEnt = $("#pv-d-ent");
const pvDPlay = $<HTMLButtonElement>("#pv-d-play");
const pvDSeasons = $("#pv-d-seasons");
const pvDEpisodes = $("#pv-d-episodes");
const pvContinueBox = $("#pv-continue-box");
const pvContinue = $("#pv-continue");
const pvSearchForm = $<HTMLFormElement>("#pv-search");
const pvSearchInput = $<HTMLInputElement>("#pv-q");

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
let latestPv: PrimeContext | null = null;
let pvReceivedAt = 0;

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
  if (context.app === "youtube") {
    latestYt = context;
    npReceivedAt = Date.now();
  } else {
    latestPv = context;
    pvReceivedAt = Date.now();
  }
  render();
}

function render(): void {
  const active = latestState?.activeApp ?? "unknown";
  document.querySelectorAll<HTMLElement>(".app").forEach((el) => {
    el.classList.toggle("active", el.dataset.app === active);
  });
  muteBtn.classList.toggle("on", latestState?.volumeMuted ?? false);

  renderPrime(active);
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

// --- Prime panel ---

function renderPrime(active: string): void {
  const live = latestState?.adapters.includes("prime") ?? false;
  const show = active === "prime" || (active === "unknown" && live && !latestState?.adapters.includes("youtube"));
  pvSection.hidden = !show;
  if (!show) return;
  pvSection.classList.toggle("offline", !live);
  pvConn.textContent = live ? "" : "Waiting for TV…";
  pvConn.hidden = live;
  const pv = latestPv;
  const np = pv?.screen === "watch" ? pv.nowPlaying : null;

  pvNow.hidden = np === null;
  if (np) {
    pvNpTitle.textContent = np.title;
    pvNpEpisode.textContent = np.episode;
    pvAd.hidden = !np.ad;
    pvPlay.classList.toggle("paused", np.paused);
    pvCc.classList.toggle("on", np.captions);
    // Skip Intro/Recap when Prime offers it; otherwise next episode (shows only).
    pvSkip.textContent = np.skip || "Next ep";
    pvSkip.hidden = !np.skip && !np.episode;
    pvSpeed.value = String(np.rate);
    pvSpeedLabel.textContent = `${np.rate}×`;
    pvTimeline.tick();
  }

  renderPvResults(pv?.screen === "search" ? pv.results : [], pv?.query ?? "");
  renderPvDetail(pv?.screen === "detail" ? pv : null);
  renderPvContinue(pv?.screen === "watch" ? [] : pv?.continueWatching ?? []);
}

function thumbButton(className: string, image: string, progress: number | null): { btn: HTMLButtonElement; thumb: HTMLElement } {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  const thumb = document.createElement("div");
  thumb.className = className === "rc" ? "rc-thumb" : "res-thumb";
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  if (image) img.src = image;
  thumb.appendChild(img);
  if (progress !== null) {
    const bar = document.createElement("div");
    bar.className = "prog";
    const fill = document.createElement("i");
    fill.style.width = `${progress}%`;
    bar.appendChild(fill);
    thumb.appendChild(bar);
  }
  btn.appendChild(thumb);
  return { btn, thumb };
}

function resRow(image: string, progress: number | null, title: string, sub: string, onTap: () => void): HTMLButtonElement {
  const { btn } = thumbButton("res", image, progress);
  const text = document.createElement("div");
  text.className = "res-text";
  const t = document.createElement("span");
  t.className = "res-title";
  t.textContent = title;
  const s = document.createElement("span");
  s.className = "res-sub";
  s.textContent = sub;
  text.append(t, s);
  btn.appendChild(text);
  btn.addEventListener("click", onTap);
  return btn;
}

let pvResultsSig = "";

function renderPvResults(items: PrimeTitle[], query: string): void {
  pvResultsBox.hidden = items.length === 0;
  pvResultsTitle.textContent = query ? `Results for “${query}”` : "Results";
  const sig = items.map((r) => r.titleId).join(",");
  if (sig === pvResultsSig) return;
  pvResultsSig = sig;
  pvResults.innerHTML = "";
  pvResults.scrollTop = 0;
  for (const item of items) {
    const sub = [item.meta, item.entitled ? "" : "Paid add-on"].filter(Boolean).join(" · ");
    pvResults.appendChild(resRow(item.image, item.progress, item.title, sub,
      () => send({ type: "openTitle", titleId: item.titleId, play: false })));
  }
}

let pvDetailSig = "";

function renderPvDetail(pv: PrimeContext | null): void {
  const d = pv?.detail ?? null;
  pvDetail.hidden = d === null;
  if (!d) return;
  const sig = JSON.stringify(d);
  if (sig === pvDetailSig) return;
  pvDetailSig = sig;
  pvDTitle.textContent = d.title;
  pvDEnt.textContent = d.entitlement;
  pvDPlay.hidden = !d.playLabel;
  pvDPlay.querySelector("span")!.textContent = d.playLabel;
  pvDPlay.onclick = () => send({ type: "openTitle", titleId: d.titleId, play: true });
  pvDSeasons.innerHTML = "";
  pvDSeasons.hidden = d.seasons.length < 2;
  for (const season of d.seasons) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = season.label;
    b.classList.toggle("on", season.current);
    b.addEventListener("click", () => { if (!season.current) send({ type: "openTitle", titleId: season.titleId, play: false }); });
    pvDSeasons.appendChild(b);
  }
  pvDEpisodes.innerHTML = "";
  pvDEpisodes.hidden = d.episodes.length === 0;
  for (const ep of d.episodes) {
    pvDEpisodes.appendChild(resRow(ep.image, ep.progress, ep.title, ep.meta,
      () => send({ type: "openTitle", titleId: ep.titleId, play: true })));
  }
}

let pvContinueSig = "";

function renderPvContinue(items: PrimeTitle[]): void {
  pvContinueBox.hidden = items.length === 0;
  const sig = items.map((r) => `${r.titleId}:${r.progress}`).join(",");
  if (sig === pvContinueSig) return;
  pvContinueSig = sig;
  pvContinue.innerHTML = "";
  for (const item of items) {
    const { btn } = thumbButton("rc", item.image, item.progress);
    const title = document.createElement("span");
    title.textContent = item.title;
    btn.appendChild(title);
    btn.addEventListener("click", () => send({ type: "openTitle", titleId: item.titleId, play: false }));
    pvContinue.appendChild(btn);
  }
}

pvSpeed.addEventListener("change", () => {
  const rate = Number(pvSpeed.value);
  if (rate > 0) send({ type: "speed", rate });
});

// --- Timeline: interpolated between context updates, draggable to seek ---

interface TimelineClock {
  currentTimeSec: number;
  durationSec: number;
  paused: boolean;
}

interface Timeline {
  tick: () => void;
}

// Drag-to-seek timeline shared by the YouTube and Prime panels. Position is
// interpolated between context updates; while dragging, the TV previews the
// spot via throttled scrubs and drawFrame paints an optional preview frame.
function createTimeline(
  root: HTMLElement,
  read: () => { clock: TimelineClock; receivedAt: number } | null,
  drawFrame: (frameBox: HTMLElement, t: number) => void,
): Timeline {
  const scrub = root.querySelector<HTMLInputElement>(".scrub")!;
  const cur = root.querySelector<HTMLElement>(".t-cur")!;
  const dur = root.querySelector<HTMLElement>(".t-dur")!;
  const preview = root.querySelector<HTMLElement>(".preview")!;
  let scrubbing = false;
  let holdUntil = 0;
  let lastSent = 0;
  let pending = 0;

  const now = (c: TimelineClock, receivedAt: number): number =>
    Math.min(c.durationSec, c.currentTimeSec + (c.paused ? 0 : (Date.now() - receivedAt) / 1000));

  function tick(): void {
    const r = read();
    if (!r || scrubbing || Date.now() < holdUntil) return;
    const t = now(r.clock, r.receivedAt);
    scrub.value = String(r.clock.durationSec > 0 ? Math.round((t / r.clock.durationSec) * 1000) : 0);
    scrub.style.setProperty("--pct", `${Number(scrub.value) / 10}%`);
    cur.textContent = fmtTime(t);
    dur.textContent = r.clock.durationSec > 0 ? fmtTime(r.clock.durationSec) : "--:--";
  }

  function sendScrub(seconds: number): void {
    window.clearTimeout(pending);
    const wait = SCRUB_SEND_MS - (Date.now() - lastSent);
    if (wait <= 0) {
      lastSent = Date.now();
      send({ type: "scrub", seconds });
    } else {
      pending = window.setTimeout(() => sendScrub(seconds), wait);
    }
  }

  scrub.addEventListener("pointerdown", () => { scrubbing = true; });
  scrub.addEventListener("input", () => {
    scrubbing = true;
    scrub.style.setProperty("--pct", `${Number(scrub.value) / 10}%`);
    const r = read();
    if (!r || r.clock.durationSec <= 0) return;
    const t = (Number(scrub.value) / 1000) * r.clock.durationSec;
    cur.textContent = fmtTime(t);
    preview.hidden = false;
    preview.style.left = `clamp(52px, ${Number(scrub.value) / 10}%, calc(100% - 52px))`;
    preview.querySelector("span")!.textContent = fmtTime(t);
    drawFrame(preview.querySelector<HTMLElement>(".frame")!, t);
    sendScrub(Math.round(t));
  });
  scrub.addEventListener("change", () => {
    scrubbing = false;
    preview.hidden = true;
    window.clearTimeout(pending);
    const r = read();
    if (!r || r.clock.durationSec <= 0) return;
    // Hold the thumb where it was dropped until the TV reports the new spot.
    holdUntil = Date.now() + 1500;
    send({ type: "seekTo", seconds: Math.round((Number(scrub.value) / 1000) * r.clock.durationSec) });
  });
  return { tick };
}

const SCRUB_SEND_MS = 120;

// YouTube preview: storyboard sprite at native size, scaled into the frame.
const ytTimeline = createTimeline(
  npBox,
  () => (latestYt?.nowPlaying ? { clock: latestYt.nowPlaying, receivedAt: npReceivedAt } : null),
  (frameBox, t) => {
    const np = latestYt?.nowPlaying;
    const sb = np?.storyboard;
    frameBox.hidden = !sb;
    if (!np || !sb) return;
    const f = storyboardFrame(sb, t, np.durationSec);
    const sprite = frameBox.firstElementChild as HTMLElement;
    // Box height is fixed; width follows the frames (vertical videos too).
    frameBox.style.aspectRatio = `${sb.width} / ${sb.height}`;
    sprite.style.width = `${sb.width}px`;
    sprite.style.height = `${sb.height}px`;
    sprite.style.backgroundImage = `url("${f.url}")`;
    sprite.style.backgroundPosition = `-${f.x}px -${f.y}px`;
    sprite.style.transform = `scale(${frameBox.clientHeight / sb.height})`;
  },
);

// Prime has no storyboard on the web: the preview is just the time.
const pvTimeline = createTimeline(
  pvNow,
  () => (latestPv?.nowPlaying ? { clock: latestPv.nowPlaying, receivedAt: pvReceivedAt } : null),
  (frameBox) => { frameBox.hidden = true; },
);

function tickTimeline(): void {
  ytTimeline.tick();
  pvTimeline.tick();
}
window.setInterval(tickTimeline, 250);

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

function closePvSearch(): void {
  pvSearchInput.blur();
  pvSearchInput.value = "";
  pvSearchForm.hidden = true;
}

$("#pv-search-open").addEventListener("click", () => {
  pvSearchForm.hidden = false;
  pvSearchInput.focus();
});
$("#pv-search-cancel").addEventListener("click", closePvSearch);
pvSearchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = pvSearchInput.value.trim();
  if (!text) return;
  send({ type: "search", text });
  closePvSearch();
});

// --- No zoom (iOS ignores user-scalable=no in Safari tabs) ---

document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());

connect();
