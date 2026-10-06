// Living Room remote: launcher buttons plus a context-aware YouTube panel.
// The panel appears when YouTube is active (or reporting) and renders the
// adapter context pushed by the server: now playing, grid, history.

import type { AppContext, Command, ServerMessage, ServerState, YoutubeContext } from "@tv-control/shared";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const stateEl = document.querySelector<HTMLElement>("#state")!;
const ytSection = document.querySelector<HTMLElement>("#yt")!;
const ytConn = document.querySelector<HTMLElement>("#yt-conn")!;
const ytNow = document.querySelector<HTMLElement>("#yt-now")!;
const ytScreen = document.querySelector<HTMLElement>("#yt-screen")!;
const ytItems = document.querySelector<HTMLElement>("#yt-items")!;
const ytHistory = document.querySelector<HTMLElement>("#yt-history")!;
const ytSearch = document.querySelector<HTMLFormElement>("#yt-search")!;
const ytQuery = document.querySelector<HTMLInputElement>("#yt-q")!;

function serverUrl(): string {
  const host = window.location.hostname || "localhost";
  return `ws://${host}:8080`;
}

let ws: WebSocket | null = null;
let latestState: ServerState | null = null;
let latestYt: YoutubeContext | null = null;

function send(cmd: Command): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  } else {
    statusEl.textContent = "not connected — retrying…";
    connect();
  }
}

function connect(): void {
  statusEl.textContent = `connecting to ${serverUrl()}…`;
  ws = new WebSocket(serverUrl());
  ws.onopen = () => { statusEl.textContent = "connected"; };
  ws.onclose = () => {
    statusEl.textContent = "disconnected — retrying…";
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { ws?.close(); };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === "state") {
        latestState = msg.state;
        renderState();
      } else if (msg.type === "context") {
        onContext(msg.context);
      }
    } catch { /* ignore */ }
  };
}

function renderState(): void {
  if (!latestState) return;
  stateEl.textContent = JSON.stringify(latestState);
  renderYtSection();
}

function onContext(context: AppContext): void {
  if (context.app === "youtube") {
    latestYt = context;
    renderYtSection();
  }
}

// The YouTube panel shows when YouTube is the active app or the last context
// seen is YouTube's — either way the buttons below have something to drive.
function renderYtSection(): void {
  const active = latestState?.activeApp === "youtube" || latestYt !== null;
  ytSection.hidden = !active;
  if (!active) return;

  const live = latestState?.adapters.includes("youtube") ?? false;
  ytConn.textContent = live ? "YouTube remote live" : "YouTube remote not connected — launch YouTube on the TV";

  const np = latestYt?.nowPlaying ?? null;
  ytNow.hidden = np === null;
  if (np) {
    const time = np.durationSec > 0 ? ` · ${fmtTime(np.currentTimeSec)} / ${fmtTime(np.durationSec)}` : "";
    ytNow.textContent = `${np.paused ? "❚❚" : "▶"} ${np.title}${np.channel ? ` — ${np.channel}` : ""}${time}`;
  }

  if (latestYt) {
    const screen = latestYt.screen === "search" && latestYt.query ? `search: “${latestYt.query}”` : latestYt.screen;
    ytScreen.textContent = `· ${screen}`;
    renderList(ytItems, latestYt.items.slice(0, 20), latestYt.focusIndex);
    renderList(ytHistory, latestYt.history.slice(0, 20), -1);
  }
}

function renderList(el: HTMLElement, items: { videoId: string; title: string; channel: string }[], focus: number): void {
  el.innerHTML = "";
  if (items.length === 0) {
    el.innerHTML = `<p class="dim">Nothing here yet.</p>`;
    return;
  }
  items.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row" + (i === focus ? " focused" : "");
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = item.title || "(untitled)";
    btn.appendChild(title);
    if (item.channel) {
      const ch = document.createElement("span");
      ch.className = "row-sub";
      ch.textContent = item.channel;
      btn.appendChild(ch);
    }
    btn.addEventListener("click", () => send({ type: "openVideo", videoId: item.videoId }));
    el.appendChild(btn);
  });
}

function fmtTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

document.querySelectorAll<HTMLButtonElement>("button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    send(JSON.parse(btn.dataset.cmd!) as Command);
  });
});

ytSearch.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ytQuery.value.trim();
  if (text) {
    send({ type: "search", text });
    ytQuery.blur();
  }
});

connect();
