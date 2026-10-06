// Focused test for the remote-debug surface: service endpoints plus the
// supervisor's crash-restart. Run from server/ after build:
//   npm run build && npm test
// Uses LAUNCHER=mock so it runs anywhere (Mac CI included).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
  console.log("FAIL build first: npm run build");
  process.exit(1);
}

async function json(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function waitFor(url, pred, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    try {
      const r = await json(url);
      last = r.body;
      if (pred(r)) return r;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${url} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
}

// --- Part 1: service endpoints (mock launcher) ---
const SVC = 18080;
const svc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, PORT: String(SVC), LAUNCHER: "mock" },
  stdio: "ignore",
});
try {
  const health = await waitFor(`http://localhost:${SVC}/health`, (r) => r.status === 200 && r.body.ok);
  check("health", health.body.launcher === "mock", JSON.stringify(health.body));

  const cmd = await json(`http://localhost:${SVC}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "launch", app: "geforce" }),
  });
  check("POST command", cmd.status === 200 && cmd.body.state.activeApp === "geforce");

  const logs = await json(`http://localhost:${SVC}/logs?limit=50`);
  check("logs capture launch", logs.body.logs?.some((e) => e.msg.includes("launch geforce")));

  const state = await json(`http://localhost:${SVC}/api/state`);
  check("state diagnose", state.body.diagnose?.mode === "mock", JSON.stringify(state.body.diagnose));

  const bad = await json(`http://localhost:${SVC}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "bogus" }),
  });
  check("bad command rejected", bad.status === 400 && bad.body.ok === false);

  const shot = await fetch(`http://localhost:${SVC}/screenshot`);
  check("screenshot 501 on mock", shot.status === 501);
} finally {
  svc.kill("SIGTERM");
}

// --- Part 2: supervisor restarts a killed child ---
const CHILD_PORT = 18081;
const SUP_PORT = 18082;
const sup = spawn("node", ["supervisor.mjs"], {
  env: { ...process.env, PORT: String(CHILD_PORT), SUPERVISOR_PORT: String(SUP_PORT), LAUNCHER: "mock" },
  stdio: "ignore",
});
try {
  const s1 = await waitFor(`http://localhost:${SUP_PORT}/status`, (r) => r.body.child?.alive === true);
  const pid1 = s1.body.child.pid;
  check("supervisor boots child", Number.isInteger(pid1), `pid=${pid1}`);

  process.kill(pid1, "SIGKILL");
  const s2 = await waitFor(
    `http://localhost:${SUP_PORT}/status`,
    (r) => r.body.restarts >= 1 && r.body.child?.alive === true && r.body.child?.pid !== pid1,
    40000,
  );
  check("supervisor restarts killed child", true, `pid=${pid1} -> ${s2.body.child.pid}`);

  const slog = await json(`http://localhost:${SUP_PORT}/logs?limit=50`);
  check("supervisor logs the exit", slog.body.logs?.some((e) => String(e.line).includes("restart #1")));
} finally {
  sup.kill("SIGTERM");
}

// --- Part 3: adapter relay (extension bridge + context broadcast) ---
const ADAPTER_PORT = 18083;
const asvc = spawn("node", ["dist/index.js"], {
  env: { ...process.env, PORT: String(ADAPTER_PORT), LAUNCHER: "mock" },
  stdio: "ignore",
});
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", (e) => reject(e), { once: true });
  });
}
function wsNext(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error("timed out waiting for ws message"));
    }, timeoutMs);
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (pred(msg)) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          resolve(msg);
        }
      } catch { /* ignore unparsable */ }
    };
    ws.addEventListener("message", onMsg);
  });
}
try {
  await waitFor(`http://localhost:${ADAPTER_PORT}/health`, (r) => r.status === 200 && r.body.ok);
  const phone = await wsConnect(ADAPTER_PORT);
  const adapter = await wsConnect(ADAPTER_PORT);
  try {
    adapter.send(JSON.stringify({ type: "adapterHello", app: "youtube" }));
    const helloState = await waitFor(
      `http://localhost:${ADAPTER_PORT}/api/state`,
      (r) => r.body.state?.adapters?.includes("youtube"),
    );
    check("adapter hello registers", true, JSON.stringify(helloState.body.state.adapters));

    // Launch youtube first so relay scoping has an active app, then drive it.
    await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "launch", app: "youtube" }),
    });
    const navSeen = wsNext(adapter, (m) => m.type === "navigate" && m.direction === "right");
    phone.send(JSON.stringify({ type: "navigate", direction: "right" }));
    check("navigate relayed to adapter", (await navSeen).direction === "right");

    const ctxSeen = wsNext(phone, (m) => m.type === "context" && m.context?.app === "youtube");
    adapter.send(JSON.stringify({
      type: "adapterContext",
      context: {
        app: "youtube", screen: "browse", query: "", nowPlaying: null,
        recent: [{ videoId: "dQw4w9WgXcQ", title: "t", channel: "c", thumbnail: "" }, { videoId: "bad id!" }],
      },
    }));
    check("context broadcast to phone", (await ctxSeen).context.screen === "browse");

    const withCtx = await json(`http://localhost:${ADAPTER_PORT}/api/state`);
    check("context in /api/state", withCtx.body.contexts?.youtube?.screen === "browse");
    check("recent keeps valid items only", withCtx.body.contexts?.youtube?.recent?.length === 1);

    const badSeek = await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "seek", seconds: "lots" }),
    });
    check("bad seek rejected", badSeek.status === 400 && badSeek.body.ok === false);

    const badOpen = await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "openVideo", videoId: "not a video id!!" }),
    });
    check("bad openVideo rejected", badOpen.status === 400 && badOpen.body.ok === false);

    const goodSeek = await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "seek", seconds: -10 }),
    });
    check("good seek accepted", goodSeek.status === 200 && goodSeek.body.ok === true);

    // Fullscreen is a server-side keypress; it must not also toggle in-page.
    const fsAck = wsNext(phone, (m) => m.type === "ack" && m.command?.type === "fullscreen");
    const fsLeak = wsNext(adapter, (m) => m.type === "fullscreen", 500).then(() => true, () => false);
    phone.send(JSON.stringify({ type: "fullscreen" }));
    await fsAck;
    check("fullscreen handled server-side", !(await fsLeak));

    for (const cmd of [
      { type: "seekTo", seconds: 42 }, { type: "captions" }, { type: "quality", level: "hd1080" },
      { type: "speed", rate: 1.5 }, { type: "scrub", seconds: 90 },
    ]) {
      const seen = wsNext(adapter, (m) => m.type === cmd.type);
      phone.send(JSON.stringify(cmd));
      check(`${cmd.type} relayed to adapter`, JSON.stringify(await seen) === JSON.stringify(cmd));
    }

    const badQuality = await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "quality", level: "'; rm -rf" }),
    });
    check("bad quality rejected", badQuality.status === 400);

    const badSpeed = await json(`http://localhost:${ADAPTER_PORT}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "speed", rate: 16 }),
    });
    check("bad speed rejected", badSpeed.status === 400);

    // Keepalive pings are accepted silently (no error back).
    const pingErr = wsNext(adapter, (m) => m.type === "error", 500).then(() => true, () => false);
    adapter.send(JSON.stringify({ type: "adapterPing" }));
    check("adapterPing accepted", !(await pingErr));

    const bogusAdapter = wsNext(adapter, (m) => m.type === "error");
    adapter.send(JSON.stringify({ type: "adapterContext", context: { app: "vimeo" } }));
    check("bad adapter context errors", (await bogusAdapter).type === "error");

    adapter.close();
    const gone = await waitFor(
      `http://localhost:${ADAPTER_PORT}/api/state`,
      (r) => Array.isArray(r.body.state?.adapters) && r.body.state.adapters.length === 0,
    );
    check("adapter disconnect unregisters", true, JSON.stringify(gone.body.state.adapters));
  } finally {
    phone.close();
    adapter.close();
  }
} finally {
  asvc.kill("SIGTERM");
}

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? "REMOTE TEST OK" : `REMOTE TEST FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
