# Server (Windows control service)

WebSocket + `/home.html` on the same `PORT` (default 8080).

## Remote debugging (from another machine)

- `GET /logs` — recent log tail (also appended to `logs/service.log`, gitignored).
- `GET /api/state` — state plus `diagnose()` (launcher mode, last error,
  GeForce NOW targets checked with on-disk existence).
- `POST /api/command` — same commands as the WebSocket, drivable with curl.
- `node supervisor.mjs` — runs the service as a child, restarts it with
  backoff on crash, and serves `GET /status` + `GET /logs` on
  `SUPERVISOR_PORT` (default 8081) so a dead service is still readable.
  On the PC, allow inbound TCP on both ports in Defender Firewall.

## App targets

Copy `apps.json.example` to `apps.json` and edit paths/URLs there.
Reloaded on every launch call — no restart needed.

## Appliance checklist (OptiPlex, run once)

- Settings → Power: sleep `Never`, screen stays on for the TV.
- `netplwiz`: auto-login to a dedicated TV account.
- Startup: run `npm run start:server` at login (Task Scheduler).
- Edge: install ad blocker, sign into Netflix/Prime/YouTube once.
- GeForce NOW: install native app, sign in, pair controllers.
- `Home` recovery closes GeForce NOW + Edge and reopens `/home.html`
  fullscreen — the known usable state.

## Env

Copy `.env.example` to `.env`: `LAUNCHER=windows` on the PC.
