# Extension (MV3, Edge)

Site adapters that make streaming pages drivable from the phone. YouTube
ships first; Netflix/Prime plug into `content.ts` when they land.

## How it works

- `src/youtube.ts` (content script, `document_start`) — scrapes YouTube's
  own rendered DOM (lockups plus legacy search-result renderers) and renders
  a 10-foot TV overlay sized in `vw`: 4-column full-width grid, mini player
  bar on watch pages. Handles `navigate/select/back/playPause/seek/seekTo/
  captions/quality/openVideo/search`. Sends `tvHello` every 20s as a
  heartbeat.
- `src/ytMain.ts` (MAIN world) — reads/sets quality through YouTube's player
  API (`#movie_player`), which the isolated content script can't reach.
- `src/background.ts` (service worker) — holds the WebSocket to the control
  service (`ws://127.0.0.1:8080`), registers each adapter tab (`adapterHello`),
  forwards adapter context, relays commands to tabs. Tab heartbeats keep the
  worker alive and become `adapterPing`s on the socket; reconnects with
  backoff and asks tabs for fresh state (`tvRefresh`).
- `src/content.ts` — per-site router (YouTube now, more later).
- `src/ytLib.ts` — pure helpers (focus math, id parsing).
- `src/overlayStyles.ts` — overlay CSS injected by the adapter.

Fullscreen is not handled here: the service sends a real `f` keypress to
the Edge window (pages can't enter fullscreen without a user gesture).

The service routes phone commands to whichever app is active and broadcasts
adapter context back to the PWA, which renders its YouTube panel from it.

## Build

```sh
npm install && npm run build   # tsc -> dist/
```

`@tv-control/shared` is a `file:../shared` dep, so the protocol types stay in
sync — rebuild shared first after protocol changes.

## Load it (Edge on the OptiPlex)

1. `edge://extensions` → Developer mode → Load unpacked → this folder.
2. Open `https://www.youtube.com/` — the TV overlay takes over the page.
   (PC keyboard works too: arrows/Enter/Backspace/space, for desk testing.)
3. Point at a different service host (non-default setup only):
   set `tvServerUrl` in the extension's `chrome.storage.local`.

## Phone flow (PWA)

The YouTube panel shows only while YouTube is the active app: now playing
with a draggable timeline, ±10s, play/pause, CC, quality, fullscreen, then
D-pad + OK, Back, and Search.
