import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseCommand, type ServerMessage } from "@tv-control/shared";
import type { Launcher } from "./launcher.js";
import { MockLauncher } from "./mockLauncher.js";

const PORT = Number(process.env.PORT ?? 8080);

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

const launcher = await createLauncher();
console.log(`launcher: ${launcher.name}`);

const homeHtml = readFileSync(new URL("../public/home.html", import.meta.url), "utf8");

const httpServer = createServer((req, res) => {
  if (req.url === "/home.html" || req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(homeHtml);
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, launcher: launcher.name }));
    return;
  }
  res.writeHead(404).end("not found");
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  send(ws, { type: "state", state: launcher.getState() });
  ws.on("message", async (raw) => {
    let command: ReturnType<typeof parseCommand>;
    try {
      command = parseCommand(JSON.parse(raw.toString()));
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "bad command" });
      return;
    }
    try {
      switch (command.type) {
        case "launch": await launcher.launch(command.app); break;
        case "home": await launcher.home(); break;
        case "volume": await launcher.volume(command.action); break;
        case "ping": break;
        // Phase 2 (extension navigate/select/back/playPause/search): ack for now.
        default: break;
      }
      send(ws, { type: "ack", command });
      broadcast(wss, { type: "state", state: launcher.getState() });
    } catch (e) {
      send(ws, { type: "error", message: e instanceof Error ? e.message : "action failed" });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`tv-control server on http://localhost:${PORT} (ws on same port)`);
});
