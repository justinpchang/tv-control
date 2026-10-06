// Injected <style> for the TV overlay. Deliberately YouTube-dark: near-black
// surfaces, white text, a single red progress accent. No gradients.

export const OVERLAY_CSS = `
#tvyt-root {
  position: fixed; inset: 0; z-index: 2147483647;
  background: #0f0f0f; color: #f1f1f1;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
#tvyt-root[hidden] { display: none; }
.tvyt-head {
  display: flex; align-items: baseline; gap: 16px;
  padding: 20px 40px 8px;
}
.tvyt-brand { font-size: 30px; font-weight: 700; letter-spacing: .5px; }
.tvyt-brand span { color: #ff0033; }
.tvyt-query { font-size: 24px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvyt-hints { margin-left: auto; font-size: 15px; color: #717171; white-space: nowrap; }
.tvyt-exit {
  background: #272727; color: #f1f1f1; border: 1px solid #3d3d3d;
  border-radius: 18px; font-size: 15px; padding: 8px 16px; cursor: pointer;
}
.tvyt-rowlabel { padding: 14px 40px 4px; font-size: 20px; font-weight: 600; color: #f1f1f1; }
.tvyt-grid {
  flex: 1; overflow-y: auto; padding: 12px 40px 40px;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 28px 20px; align-content: start;
}
.tvyt-card { outline: none; }
.tvyt-thumb {
  position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden;
  background: #212121;
}
.tvyt-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvyt-dur {
  position: absolute; right: 8px; bottom: 8px; background: rgba(0,0,0,.8);
  font-size: 15px; padding: 2px 6px; border-radius: 4px;
}
.tvyt-card.focused .tvyt-thumb { outline: 4px solid #fff; outline-offset: 3px; }
.tvyt-title {
  margin-top: 10px; font-size: 19px; line-height: 1.3; font-weight: 500;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tvyt-channel { margin-top: 4px; font-size: 16px; color: #aaa; }
.tvyt-hrow {
  display: flex; gap: 16px; overflow-x: auto; padding: 8px 40px 4px;
}
.tvyt-hcard { flex: 0 0 300px; }
.tvyt-hcard .tvyt-title { font-size: 17px; }
.tvyt-empty { padding: 60px 40px; font-size: 22px; color: #717171; }
.tvyt-toast {
  position: absolute; left: 50%; bottom: 48px; transform: translateX(-50%);
  background: #f1f1f1; color: #0f0f0f; font-size: 19px; font-weight: 600;
  padding: 12px 24px; border-radius: 24px; opacity: 0; transition: opacity .2s;
  pointer-events: none;
}
.tvyt-toast.show { opacity: 1; }
#tvyt-minibar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  background: rgba(15,15,15,.96); border-top: 1px solid #3d3d3d;
  padding: 10px 28px 12px; font-family: system-ui, sans-serif; color: #f1f1f1;
}
#tvyt-minibar[hidden] { display: none; }
.tvyt-mini-title { font-size: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvyt-mini-sub { font-size: 14px; color: #aaa; margin-top: 2px; }
.tvyt-mini-track { height: 5px; background: #3d3d3d; border-radius: 3px; margin-top: 8px; }
.tvyt-mini-fill { height: 100%; background: #ff0033; border-radius: 3px; width: 0%; }
.tvyt-mini-hints { font-size: 13px; color: #717171; margin-top: 6px; }
@media (prefers-reduced-motion: reduce) {
  .tvyt-toast { transition: none; }
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
