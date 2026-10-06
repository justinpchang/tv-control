import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseCommand, type Command, type ServerMessage } from "@tv-control/shared";
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

function readBody(req: import("node:http").IncomingMessage, limit = 4096): Promise<string> {
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

async function handleCommand(command: Command): Promise<void> {
  switch (command.type) {
    case "launch": await launcher.launch(command.app); break;
    case "home": await launcher.home(); break;
    case "volume": await launcher.volume(command.action); break;
    case "ping": break;
    // Phase 2 (extension navigate/select/back/playPause/search): ack for now.
    default: break;
  }
}

const homeHtml = readFileSync(new URL("../public/home.html", import.meta.url), "utf8");

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if ((req.url === "/home.html" || req.url === "/") && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(homeHtml);
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
      state: launcher.getState(),
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
      await handleCommand(command);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: launcher.getState() }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "bad command" }));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  send(ws, { type: "state", state: launcher.getState() });
  ws.on("message", async (raw) => {
    let command: Command;
    try {
      command = parseCommand(JSON.parse(raw.toString()));
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "bad command" });
      return;
    }
    try {
      await handleCommand(command);
      send(ws, { type: "ack", command });
      broadcast(wss, { type: "state", state: launcher.getState() });
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "action failed" });
    }
  });
});

httpServer.listen(PORT, () => {
  log.info(`tv-control server on http://localhost:${PORT} (ws on same port)`);
});
