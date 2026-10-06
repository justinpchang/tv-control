import { parseCommand, type AppId } from "@tv-control/shared";

// MV3 background bridge: the control service speaks WebSocket, and only the
// service worker holds that socket (page CSPs must not matter, and content
// scripts stay dumb). Content scripts register with tvHello, forward state
// with tvContext, and receive { kind: "tvCommand", command }.

const DEFAULT_SERVER_URL = "ws://127.0.0.1:8080";
const SERVER_URL_KEY = "tvServerUrl";

let serverUrl = DEFAULT_SERVER_URL;
let ws: WebSocket | null = null;
let retryMs = 1000;
let retryTimer = 0;

// Adapter tabs that have introduced themselves.
const tabs = new Map<number, AppId>();

function log(...args: unknown[]): void {
  console.log("[tv-control]", ...args);
}

function sendHello(app: AppId): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "adapterHello", app }));
  }
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  log("connecting to", serverUrl);
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    scheduleRetry();
    return;
  }
  ws.onopen = () => {
    log("connected");
    retryMs = 1000;
    for (const app of new Set(tabs.values())) sendHello(app);
    // Ask adapters for fresh state; anything they sent while we were away
    // was dropped.
    for (const tabId of tabs.keys()) {
      chrome.tabs.sendMessage(tabId, { kind: "tvRefresh" }).catch(() => {});
    }
  };
  ws.onmessage = (ev) => {
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
  ws.onclose = () => {
    log("disconnected, retrying");
    ws = null;
    scheduleRetry();
  };
  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleRetry(): void {
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => {
    retryMs = Math.min(retryMs * 2, 30_000);
    connect();
  }, retryMs);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (msg?.kind === "tvHello" && typeof msg.app === "string" && tabId !== undefined) {
    tabs.set(tabId, msg.app as AppId);
    connect();
    sendHello(msg.app as AppId);
  } else if (msg?.kind === "tvContext" && msg.context !== undefined) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "adapterContext", context: msg.context }));
    }
    // Offline: dropped. Reconnect broadcasts tvRefresh so the tab reports.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

// MV3 suspends this worker ~30s after its last event, which drops the
// socket. A minute-tick alarm wakes it so connect() can redial.
chrome.alarms.create("keepalive", { periodInMinutes: 1 });
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
