// Supervisor: owns the control service as a child process and stays up when it
// doesn't. Zero dependencies — runs with plain `node supervisor.mjs`.
//   GET /status — child alive/pid/uptime/restarts/last exit (readable mid-crash)
//   GET /logs   — combined supervisor + child output tail, also on disk
// Env: PORT (child service, default 8080), SUPERVISOR_PORT (default 8081),
//   LAUNCHER (passed through), LOG_FILE (default ./logs/service.log).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT ?? 8081);
const LOG_FILE = resolve(process.cwd(), process.env.LOG_FILE ?? "logs/service.log");
mkdirSync(dirname(LOG_FILE), { recursive: true });

const RING_MAX = 500;
const ring = [];
let restarts = 0;
let child = null;
let childSince = 0;
let lastExit = null;

function record(source, line) {
  const entry = { ts: new Date().toISOString(), source, line };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try { appendFileSync(LOG_FILE, `[${entry.ts}] ${source} ${line}\n`); } catch { /* best-effort */ }
}

const sup = (msg) => record("supervisor", msg);

function startChild() {
  child = spawn("node", [join(HERE, "dist", "index.js")], {
    cwd: HERE,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childSince = Date.now();
  sup(`started service pid=${child.pid} on port ${PORT}`);
  let pending = "";
  const onData = (buf) => {
    pending += buf.toString();
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) record("service", line.trim());
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, signal) => {
    lastExit = { code, signal, at: new Date().toISOString() };
    child = null;
    if (shuttingDown) return;
    restarts += 1;
    const backoffMs = Math.min(1000 * 2 ** Math.min(restarts, 5), 30000);
    sup(`service exited code=${code} signal=${signal}; restart #${restarts} in ${backoffMs}ms`);
    setTimeout(startChild, backoffMs);
  });
}

let shuttingDown = false;
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
  shuttingDown = true;
  sup("supervisor shutting down");
  try { child?.kill("SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => process.exit(0), 1000).unref();
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      supervisor: "ok",
      child: child
        ? { alive: true, pid: child.pid, uptimeSec: Math.floor((Date.now() - childSince) / 1000) }
        : { alive: false, lastExit },
      restarts,
      ports: { service: PORT, supervisor: SUPERVISOR_PORT },
      logFile: LOG_FILE,
    }));
    return;
  }
  if (url.pathname === "/logs") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200), 1), RING_MAX);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ logs: ring.slice(-limit) }));
    return;
  }
  res.writeHead(404).end("not found");
});

startChild();
server.listen(SUPERVISOR_PORT, () => sup(`listening on ${SUPERVISOR_PORT}`));
