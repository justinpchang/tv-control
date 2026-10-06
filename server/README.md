# Server (Windows control service)

WebSocket + `/home.html` on the same `PORT` (default 8080).

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
