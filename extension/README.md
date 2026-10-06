# Extension (MV3, Edge)

Site adapters that make streaming pages drivable from the phone. YouTube and
Prime Video ship; Netflix plugs into `content.ts` next.

## How it works

- `src/youtube.ts` (content script, `document_start`) — scrapes YouTube's
  own rendered DOM (lockups plus legacy search-result renderers) and renders
  a 10-foot TV overlay sized in `vw`: 4-column full-width grid, mini player
  bar on watch pages (with a storyboard preview while the phone scrubs).
  Handles `navigate/select/back/playPause/seek/seekTo/scrub/speed/captions/
  quality/openVideo/search`; on the search screen it reports the grid as
  `results` for the phone. Back from a video returns to where it was opened. Sends `tvHello` every 20s as a
  heartbeat. Keeps a 12-item recently-watched list in `chrome.storage.local`
  (`tvyt.history`; recorded after 10s of non-ad playback).
- `src/ytMain.ts` (MAIN world) — quality, speed and the storyboard spec via
  YouTube's player API (`#movie_player`), which the isolated content script
  can't reach.
- `src/background.ts` (service worker) — holds the WebSocket to the control
  service (`ws://127.0.0.1:8080`), registers each adapter tab (`adapterHello`),
  forwards adapter context, relays commands to tabs. Tab heartbeats keep the
  worker alive and become `adapterPing`s on the socket; reconnects with
  backoff and asks tabs for fresh state (`tvRefresh`).
- `src/prime.ts` (content script) — Prime Video adapter, see below.
- `src/content.ts` — per-site router (YouTube, Prime).
- `src/ytLib.ts`, `src/pvLib.ts` — pure helpers (focus math, id parsing,
  Prime's ad clock).
- `src/overlayStyles.ts`, `src/primeStyles.ts` — overlay CSS per adapter.

## Prime Video

`prime.ts` renders a row overlay from Prime's own DOM: home carousels
(`card-container-list` / `super-carousel`, row titles from
`carousel-title`), search as a 4-wide grid, and detail pages as hero + action
row (Play/Resume, seasons) + Episodes + related rows. Ids are the
`/detail/<id>` path segment; Play/episode links carry Prime's `autoplay=1&t=`
resume position and are reused for `openTitle {play: true}`.

The player overlays the detail page (URL doesn't change), so "watch" means
`#dv-web-player.dv-player-fullscreen` is visible. It is driven through Prime's
keyboard shortcuts dispatched on `#dv-web-player`: untrusted events work as
long as `keyCode` is set. Space = play/pause, ←/→ = ±10s (ad-aware), C =
subtitles, F = fullscreen (inside the trusted F13 handler), Tab = show the
controls with no side effects. Controls unmount when idle and ignore
synthetic mouse moves.

Ads are stitched into the stream (ad tier), so `video.currentTime` runs
ahead of content time. The adapter shows the controls once per playback
(Tab) to read the seek bar, pins the offset, and freezes content time while
`[class*=ad-timer]` is up; `seekTo` adds the offset back. Subtitles are on
iff `localStorage.atvwebplayersdk_html5_previous_captions` exists. `skip`
clicks Skip Intro/Recap when shown, else Next Episode. Quality is Prime's
call (no command). Continue Watching is cached in `tvpv.continue`.

Dev loop on the Mac: real Edge (Widevine) with its own profile,
`--remote-debugging-port=9222 --load-extension=<this folder>`, signed into
Prime once; inspect/drive it over CDP.

Fullscreen: the service sends a real F13 keypress to the Edge window; the
adapter catches it (capture phase, any focus) and clicks the player's
fullscreen button (Prime: sends its `f` hotkey) under that trusted gesture.
YouTube's own `f` hotkey proved flaky.

The service routes phone commands to whichever app is active and broadcasts
adapter context back to the PWA, which renders its YouTube or Prime panel
from it.

## Build

```sh
npm install && npm run build   # tsc -> dist/
```

`@tv-control/shared` is a `file:../shared` dep, so the protocol types stay in
sync — rebuild shared first after protocol changes.

## Load it (Edge on the OptiPlex)

1. `edge://extensions` → Developer mode → Load unpacked → this folder.
2. Open `https://www.youtube.com/` or `https://www.primevideo.com/` — the TV
   overlay takes over the page.
   (PC keyboard works too: arrows/Enter/Backspace/space, for desk testing.)
3. Point at a different service host (non-default setup only):
   set `tvServerUrl` in the extension's `chrome.storage.local`.

## Phone flow (PWA)

The YouTube panel shows only while YouTube is the active app: now playing
with a draggable timeline (frame preview on phone and TV), ±10s, play/pause,
CC, quality, speed, fullscreen, then D-pad + OK, Back, Search, and a
swipeable Recent row. After a search the results list on the phone is
tappable.

The Prime panel shows while Prime is active: now playing (title + episode,
timeline that excludes ads, ±10s, play/pause, CC, Skip / Next ep, speed,
fullscreen), the detail page (Play/Resume, season chips, tappable episodes),
search results, D-pad/Back/Search, and Prime's Continue Watching row.
