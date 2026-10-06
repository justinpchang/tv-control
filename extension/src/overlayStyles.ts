// Injected <style> for the TV overlay. Deliberately YouTube-dark: near-black
// surfaces, white text, a single red progress accent. No gradients.
// Sized in vw so it reads the same on a 1080p or 4K (3840 CSS px) desktop.

export const OVERLAY_CSS = `
html { background: #0f0f0f; }
#tvyt-root {
  position: fixed; inset: 0; z-index: 2147483647;
  background: #0f0f0f; color: #f1f1f1;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
#tvyt-root[hidden] { display: none; }
.tvyt-head {
  display: flex; align-items: baseline; gap: .9vw;
  padding: 1.2vw 2.2vw .5vw;
}
.tvyt-brand { font-size: 1.6vw; font-weight: 700; letter-spacing: .03em; }
.tvyt-brand span { color: #ff0033; }
.tvyt-query { font-size: 1.3vw; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvyt-hints { margin-left: auto; font-size: .8vw; color: #717171; white-space: nowrap; }
.tvyt-exit {
  background: #272727; color: #f1f1f1; border: 1px solid #3d3d3d;
  border-radius: 1vw; font-size: .8vw; padding: .4vw .9vw; cursor: pointer;
}
.tvyt-grid {
  flex: 1; overflow-y: auto; scrollbar-width: none;
  padding: .8vw 2.2vw 2.2vw;
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 2vw 1.2vw; align-content: start; box-sizing: border-box;
}
.tvyt-card { outline: none; min-width: 0; }
.tvyt-thumb {
  position: relative; aspect-ratio: 16 / 9; border-radius: .7vw; overflow: hidden;
  background: #212121;
}
.tvyt-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvyt-dur {
  position: absolute; right: .45vw; bottom: .45vw; background: rgba(0,0,0,.8);
  font-size: .8vw; padding: .1vw .35vw; border-radius: .25vw;
}
.tvyt-card.focused .tvyt-thumb { outline: .25vw solid #fff; outline-offset: .2vw; }
.tvyt-title {
  margin-top: .55vw; font-size: 1.15vw; line-height: 1.3; font-weight: 500;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tvyt-channel { margin-top: .2vw; font-size: .95vw; color: #f1f1f1; }
.tvyt-meta { margin-top: .1vw; font-size: .85vw; color: #aaa; }
.tvyt-empty { padding: 3vw 2.2vw; font-size: 1.2vw; color: #717171; }
#tvyt-toast {
  position: fixed; left: 50%; bottom: 3vw; transform: translateX(-50%); z-index: 2147483647;
  background: #f1f1f1; color: #0f0f0f; font: 600 1vw system-ui, sans-serif;
  padding: .6vw 1.3vw; border-radius: 1.3vw; opacity: 0; transition: opacity .2s;
  pointer-events: none;
}
#tvyt-toast.show { opacity: 1; }
#tvyt-minibar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  background: rgba(15,15,15,.92); border-top: 1px solid #3d3d3d;
  padding: .8vw 2.2vw 1vw; font-family: system-ui, sans-serif; color: #f1f1f1;
}
#tvyt-minibar[hidden] { display: none; }
.tvyt-mini-title { font-size: 1.15vw; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvyt-mini-sub { font-size: .8vw; color: #aaa; margin-top: .15vw; }
.tvyt-mini-track { height: .3vw; background: #3d3d3d; border-radius: .15vw; margin-top: .5vw; }
.tvyt-mini-fill { height: 100%; background: #ff0033; border-radius: .15vw; width: 0%; }
.tvyt-mini-track { position: relative; }
.tvyt-mini-preview {
  position: absolute; bottom: 1vw; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: .3vw;
}
.tvyt-mini-preview[hidden], .tvyt-mini-frame[hidden] { display: none; }
.tvyt-mini-frame {
  height: 6.75vw; aspect-ratio: 16 / 9; overflow: hidden; border-radius: .4vw;
  border: .15vw solid #f1f1f1; background: #000;
}
.tvyt-mini-frame > div { transform-origin: 0 0; background-repeat: no-repeat; }
.tvyt-mini-preview span {
  font-size: .9vw; font-weight: 600; background: rgba(0,0,0,.8);
  padding: .1vw .5vw; border-radius: .3vw; font-variant-numeric: tabular-nums;
}
.tvyt-mini-hints { font-size: .7vw; color: #717171; margin-top: .4vw; }
@media (prefers-reduced-motion: reduce) {
  #tvyt-toast { transition: none; }
}

/* Leanback restyle for watch pages: player front and center, YouTube chrome
   (masthead, related rail, comments, title block) hidden. Our mini bar
   carries title/status. Display:none only — the DOM stays intact for the
   scraper and player, so a missed selector just shows that part. */
.tvyt-cinema, .tvyt-cinema ytd-app, .tvyt-cinema ytd-watch-flexy { background: #000 !important; }
.tvyt-cinema #masthead-container,
.tvyt-cinema ytd-masthead,
.tvyt-cinema #secondary,
.tvyt-cinema #comments,
.tvyt-cinema ytd-comments,
.tvyt-cinema #chat,
.tvyt-cinema #related,
.tvyt-cinema #below,
.tvyt-cinema ytd-watch-metadata { display: none !important; }
.tvyt-cinema #primary { max-width: 100% !important; margin: 0 auto !important; padding: 24px !important; }
.tvyt-cinema #player-container-outer { max-width: 100% !important; }
`;
