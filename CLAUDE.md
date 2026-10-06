# TV Control

Turn a Dell OptiPlex 7060 (Windows, DisplayPort → HDMI to Samsung UN55MU6300FXZA)
into the main TV streaming/gaming box, remote-controlled by an iPhone PWA.

## Key decision

The TV remote owns TV power/input. Once the TV is on the PC input, the PWA owns
the entire PC experience. Samsung LAN control is parked, not a blocker
(see git history for the original Tizen probe if it gets revived).

## Layout

- `shared/` — phone → PC protocol. Source of truth; PWA and server must follow it.
- `server/` — Windows control service: WebSocket + `/home.html` on one `PORT`
  (default 8080). `MockLauncher` runs anywhere; `WindowsLauncher` (Edge
  fullscreen, GeForce NOW, PowerShell focus/volume, aggressive `home` recovery)
  loads only on Windows via `LAUNCHER=windows`.
- `pwa/` — minimal Living Room remote (Vite + plain TS): app launch buttons,
  volume, Home. Talks to `ws://<host>:8080`.
- `extension/` — Edge MV3 adapters. YouTube ships (`youtube.ts` TV overlay +
  `background.ts` WS bridge to the service); `content.ts` routes per site,
  Netflix/Prime plug in next.

## Run

```sh
npm install && npm run build
PORT=8080 LAUNCHER=mock npm run dev:server   # Mac dev
cd pwa && npm install && npm run dev          # remote UI on :5173
npm test                                      # service endpoints + supervisor restart
```

On the PC run `npm run supervise:server` instead of `start:server`: the
supervisor restarts the service on crash and serves `/status` + `/logs` on
port 8081. Debug from the Mac with `GET /logs`, `GET /api/state`,
`POST /api/command` against the PC's LAN IP.

Throwaway smoke scripts live in `/tmp` (`smoke-server.mjs`, `smoke-pwa.mjs`);
do not commit them. Real tests belong in the repo when behavior needs locking in.

## Conventions

- Extend the protocol in `shared/` first, then server, then PWA. Reject unknown
  commands with `error`, never crash the loop.
- No mouse emulation as a control model. `home` must always restore a known
  usable state (close known apps, reopen `/home.html` fullscreen).
- Streaming in Edge (ad blocking); GeForce NOW via the native Windows app.
- No secrets in the tree: `.tv-token`, `.env`, `node_modules/`, `dist/` are
  gitignored. LAN IPs in docs are fine.

## Repo

Public: `https://github.com/justinpchang/tv-control` (`main`).
This checkout uses repo-local git identity `justinpchang` + noreply email.
The Mac also holds a work `gh` account (`jpc-owner`); switch accounts with
`gh auth switch --user <name>` and leave `jpc-owner` active when done.

## Roadmap

1. Done: phone → PC loop proven with mock launcher (Mac + iPhone over LAN).
2. Next: clone on the OptiPlex, run `LAUNCHER=windows`, prove GeForce NOW
   launch + Home recovery on the real TV; apply the appliance checklist in
   `server/README.md` (no sleep, auto-login, autostart).
3. Then: Edge extension adapters — YouTube done (overlay + search/history +
   context-aware PWA panel); `netflix.ts`, `prime.ts` next.
