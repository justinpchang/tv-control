import { parseCommand, type AppId } from "@tv-control/shared";

// MV3 background bridge: the control service speaks WebSocket, and only the
// service worker holds that socket (page CSPs must not matter, and content
// scripts stay dumb). Content scripts register with tvHello, forward state
// with tvContext, and receive { kind: "tvCommand", command }.
//
// Staying connected: Edge suspends this worker after ~30s without events,
// which kills the socket and wipes in-memory state. Adapter tabs re-send
// tvHello every 20s; that wakes/keeps the worker alive, re-registers the tab
// after a restart, and is forwarded as adapterPing so the socket stays busy.

const DEFAULT_SERVER_URL = "ws://127.0.0.1:8080";
const SERVER_URL_KEY = "tvServerUrl";

let serverUrl = DEFAULT_SERVER_URL;
let ws: WebSocket | null = null;
let retryMs = 500;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// Adapter tabs that have introduced themselves.
const tabs = new Map<number, AppId>();

function log(...args: unknown[]): void {
  console.log("[tv-control]", ...args);
}

function wsSend(msg: Record<string, unknown>): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  log("connecting to", serverUrl);
  let socket: WebSocket;
  try {
    socket = new WebSocket(serverUrl);
  } catch {
    scheduleRetry();
    return;
  }
  ws = socket;
  socket.onopen = () => {
    log("connected");
    retryMs = 500;
    for (const app of new Set(tabs.values())) wsSend({ type: "adapterHello", app });
    // Ask adapters for fresh state; anything they sent while we were away
    // was dropped.
    for (const tabId of tabs.keys()) {
      chrome.tabs.sendMessage(tabId, { kind: "tvRefresh" }).catch(() => tabs.delete(tabId));
    }
  };
  socket.onmessage = (ev) => {
    let command: ReturnType<typeof parseCommand>;
    try {
      command = parseCommand(JSON.parse(String(ev.data)));
    } catch {
      return; // state/ack/context traffic for phones, not us
    }
    for (const tabId of tabs.keys()) {
      chrome.tabs.sendMessage(tabId, { kind: "tvCommand", command }).catch(() => {
        tabs.delete(tabId);
      });
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    log("disconnected, retrying");
    ws = null;
    scheduleRetry();
  };
  socket.onerror = () => socket.close();
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 5_000);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (msg?.kind === "tvHello" && typeof msg.app === "string" && tabId !== undefined) {
    const app = msg.app as AppId;
    const isNew = tabs.get(tabId) !== app;
    tabs.set(tabId, app);
    connect();
    // The server dedupes hellos per socket; a ping keeps traffic flowing.
    wsSend(isNew ? { type: "adapterHello", app } : { type: "adapterPing" });
  } else if (msg?.kind === "tvContext" && msg.context !== undefined) {
    if (!wsSend({ type: "adapterContext", context: msg.context })) connect();
    // Offline: dropped. Reconnect broadcasts tvRefresh so the tab reports.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

// Backstop when no adapter tab is open to keep us awake.
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") connect();
});

chrome.runtime.onStartup.addListener(connect);
async function boot(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get([SERVER_URL_KEY]);
    if (typeof stored[SERVER_URL_KEY] === "string" && stored[SERVER_URL_KEY]) {
      serverUrl = stored[SERVER_URL_KEY] as string;
    }
  } catch {
    /* defaults stand */
  }
  connect();
}
void boot();
