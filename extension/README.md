# Extension (MV3, Edge)

Site adapters that make streaming pages drivable from the phone. YouTube
ships first; Netflix/Prime plug into `content.ts` when they land.

## How it works

- `src/youtube.ts` (content script) — scrapes YouTube's own rendered DOM and
  renders a readable 10-foot TV overlay: large-card grid, Continue Watching
  row, mini player bar on watch pages. Handles `navigate/select/back/
  playPause/seek/openVideo/search` from the phone. Watch history lives in
  `chrome.storage.local` (`tvyt.history`, survives restarts, no API key).
- `src/background.ts` (service worker) — holds the WebSocket to the control
  service (`ws://127.0.0.1:8080`), registers each adapter tab (`adapterHello`),
  forwards adapter context, relays commands to tabs. Reconnects with backoff;
  on reconnect it asks tabs for fresh state (`tvRefresh`).
- `src/content.ts` — per-site router (YouTube now, more later).
- `src/ytLib.ts` — pure helpers (focus math, history merge, id parsing).
- `src/overlayStyles.ts` — overlay CSS injected by the adapter.

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

Launch YouTube from the remote, then the YouTube panel appears: D-pad + OK,
play/pause, ±10s, search box, the on-TV grid, and history — tapping a row
opens that video on the TV.
