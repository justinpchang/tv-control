import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  isAdapterCommand,
  parseAdapterMessage,
  parseCommand,
  type AdapterMessage,
  type AppContext,
  type AppId,
  type Command,
  type ServerMessage,
  type ServerState,
} from "@tv-control/shared";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { HomeStore } from "./home.js";
import type { Launcher } from "./launcher.js";
import { MockLauncher } from "./mockLauncher.js";
import { getLogs, log } from "./log.js";

const PORT = Number(process.env.PORT ?? 8080);
const startedAt = Date.now();

async function createLauncher(): Promise<Launcher> {
  const which = (process.env.LAUNCHER ?? (process.platform === "win32" ? "windows" : "mock")).toLowerCase();
  if (which === "windows") {
    if (process.platform !== "win32") throw new Error("windows launcher requires Windows");
    const { WindowsLauncher } = await import("./windowsLauncher.js");
    return new WindowsLauncher();
  }
  return new MockLauncher();
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(wss: WebSocketServer, msg: ServerMessage): void {
  for (const client of wss.clients) send(client as WebSocket, msg);
}

function readBody(req: import("node:http").IncomingMessage, limit = 65536): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const launcher = await createLauncher();
log.info(`launcher: ${launcher.name}`);

// Extension adapters (Phase 2): socket -> app registration from adapterHello,
// plus the latest context reported per app (adapterContext).
const adapters = new Map<WebSocket, AppId>();
const contexts = new Map<AppId, AppContext>();

// Home feed + screensaver. The screensaver starts after idle minutes on the
// home screen; any phone command (except liveness pings) wakes it.
const home = new HomeStore(process.env.DATA_DIR ?? resolve(process.cwd(), "data"), () => broadcastHome());
let screensaverActive = false;
let lastActivityAt = Date.now();

function currentState(): ServerState {
  return {
    ...launcher.getState(),
    adapters: [...new Set(adapters.values())],
    screensaver: { mode: home.screensaver, active: screensaverActive },
  };
}

function broadcastHome(): void {
  broadcast(wss, { type: "home", home: home.feed() });
}

const RESUME_URLS = {
  youtube: (id: string) => `https://www.youtube.com/watch?v=${id}`,
  prime: (id: string) => `https://www.primevideo.com/detail/${id}?autoplay=1`,
};

function relayTargets(): WebSocket[] {
  const active = launcher.getState().activeApp;
  const all = [...adapters.entries()];
  const scoped = all.filter(([, app]) => app === active);
  // Route to the active app's adapters; when nothing is active (home/unknown)
  // fall back to all adapters so a fresh adapter still responds.
  return (scoped.length > 0 ? scoped : all)
    .map(([ws]) => ws)
    .filter((ws) => ws.readyState === WebSocket.OPEN);
}

// Raw command JSON goes straight to the extension; the caller still acks
// and broadcasts state to phones.
function relayCommand(command: Command): void {
  const raw = JSON.stringify(command);
  for (const ws of relayTargets()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

async function handleCommand(wss: WebSocketServer, command: Command): Promise<void> {
  if (command.type !== "ping") {
    lastActivityAt = Date.now();
    screensaverActive = command.type === "screensaver" && command.mode !== "off";
  }
  switch (command.type) {
    case "launch": await launcher.launch(command.app); break;
    case "resume":
      await launcher.launch(command.app, RESUME_URLS[command.app](command.id));
      break;
    case "home":
      await launcher.home();
      contexts.clear();
      break;
    case "screensaver": home.screensaver = command.mode; break;
    case "volume": await launcher.volume(command.action); break;
    case "fullscreen": await launcher.fullscreen(); break;
    case "ping": break;
    default:
      // Adapter-routed media commands: forward to the extension. Unknown
      // commands never reach here — parseCommand rejects them first.
      if (isAdapterCommand(command)) relayCommand(command);
      break;
  }
}

function handleAdapterMessage(wss: WebSocketServer, ws: WebSocket, msg: AdapterMessage): void {
  if (msg.type === "adapterPing") return;
  if (msg.type === "adapterHello") {
    // Extensions re-hello on every reconnect; only announce real changes.
    if (adapters.get(ws) === msg.app) return;
    adapters.set(ws, msg.app);
    log.info(`adapter hello: ${msg.app}`);
    broadcast(wss, { type: "state", state: currentState() });
    return;
  }
  contexts.set(msg.context.app, msg.context);
  home.observe(msg.context);
  broadcast(wss, { type: "context", context: msg.context });
}

// Read per request: edits to the home page show up on reload, no restart.
const homeHtmlPath = new URL("../public/home.html", import.meta.url);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if ((req.url === "/home.html" || req.url === "/") && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(readFileSync(homeHtmlPath, "utf8"));
    return;
  }
  if (url.pathname === "/api/home" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: currentState(), home: home.feed() }));
    return;
  }
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, launcher: launcher.name }));
    return;
  }
  if (url.pathname === "/logs" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 200);
    const since = Number(url.searchParams.get("since") ?? 0);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ logs: getLogs(limit, since) }));
    return;
  }
  if (url.pathname === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      launcher: launcher.name,
      state: currentState(),
      contexts: Object.fromEntries(contexts),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      diagnose: await launcher.diagnose(),
    }));
    return;
  }
  if (url.pathname === "/screenshot" && req.method === "GET") {
    try {
      const png = await launcher.screenshot();
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
      res.end(png);
    } catch (e) {
      res.writeHead(501, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "screenshot failed" }));
    }
    return;
  }
  if (url.pathname === "/api/command" && req.method === "POST") {
    try {
      const command = parseCommand(JSON.parse(await readBody(req)));
      await handleCommand(wss, command);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: currentState() }));
      // Same fan-out as a phone command, so curl drives the TV home too.
      if (command.type !== "ping") broadcast(wss, { type: "state", state: currentState() });
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad command" }));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

const wss = new WebSocketServer({ server: httpServer });

// Drop sockets that stop answering pings (phone locked, PC slept, worker
// killed) so the adapter list never shows a dead extension as live.
const alive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as WebSocket;
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 15_000);
wss.on("close", () => clearInterval(heartbeat));

// Idle check for the screensaver.
const idleTimer = setInterval(() => {
  if (screensaverActive || home.screensaver === "off") return;
  if (launcher.getState().activeApp !== "home") return;
  if (Date.now() - lastActivityAt < loadConfig().screensaverIdleMin * 60_000) return;
  screensaverActive = true;
  log.info(`screensaver: ${home.screensaver} (idle)`);
  broadcast(wss, { type: "state", state: currentState() });
}, 10_000);
wss.on("close", () => clearInterval(idleTimer));

wss.on("connection", (ws) => {
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
  send(ws, { type: "state", state: currentState() });
  send(ws, { type: "home", home: home.feed() });
  // A fresh phone that connects mid-session also needs the latest context.
  for (const context of contexts.values()) send(ws, { type: "context", context });
  ws.on("message", async (raw) => {
    let text: string;
    try {
      text = raw.toString();
      const command = parseCommand(JSON.parse(text));
      await handleCommand(wss, command);
      send(ws, { type: "ack", command });
      // Phones ping as a liveness check; no need to fan out state for it.
      if (command.type !== "ping") broadcast(wss, { type: "state", state: currentState() });
      return;
    } catch (e) {
      // Not a phone command — may be an adapter message; fall through.
      void e;
    }
    try {
      handleAdapterMessage(wss, ws, parseAdapterMessage(JSON.parse(text!)));
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "bad command" });
    }
  });
  ws.on("close", () => {
    if (adapters.delete(ws)) {
      log.info("adapter disconnected");
      broadcast(wss, { type: "state", state: currentState() });
    }
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    home.flush();
    process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  log.info(`tv-control server on http://localhost:${PORT} (ws on same port)`);
});
