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

const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? "REMOTE TEST OK" : `REMOTE TEST FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
