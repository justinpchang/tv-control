# TV Control — Phase 1: phone → PC loop

Proves the iPhone PWA can own the Windows PC experience once the TV is on the
right input. TV power/input stays on the TV remote for now.

## Layout

- `shared/` — WebSocket command/state types + validation.
- `server/` — Windows control service (mock on Mac, real on Windows).
- `pwa/` — minimal phone remote (GeForce NOW, Home, volume).
- `extension/` — Phase 2 placeholder (Edge MV3, not wired up yet).

## Quick start (Mac dev)

```sh
npm install
npm run build
npm run dev:server
```

Then in another shell:

```sh
cd pwa && npm install && npm run dev
```

Open the PWA URL it prints in a browser.

## On Windows (OptiPlex)

```sh
git clone <repo>
npm install
npm run build
$env:LAUNCHER="windows"
npm run start:server
```

See `server/README.md` for the appliance checklist
(disable sleep, auto-login, autostart, neutral Home screen).
