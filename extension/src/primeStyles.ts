// Injected <style> for the Prime TV overlay: Prime's navy surfaces, white
// focus ring, Prime-blue progress. Sized in vw like the YouTube overlay so it
// reads the same at 1080p or 4K.

export const PRIME_CSS = `
html { background: #0f171e; }
#tvpv-root {
  position: fixed; inset: 0; z-index: 2147483647;
  background: #0f171e; color: #f2f4f6;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
#tvpv-root[hidden] { display: none; }
.tvpv-head {
  display: flex; align-items: baseline; gap: .9vw;
  padding: 1.2vw 2.6vw .4vw;
}
.tvpv-brand { font-size: 1.6vw; font-weight: 700; letter-spacing: .01em; }
.tvpv-brand span { color: #1a98ff; }
.tvpv-query { font-size: 1.3vw; color: #aab4be; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvpv-hints { margin-left: auto; font-size: .8vw; color: #79838d; white-space: nowrap; }
.tvpv-exit {
  background: #232f3e; color: #f2f4f6; border: 1px solid #3a4553;
  border-radius: 1vw; font-size: .8vw; padding: .4vw .9vw; cursor: pointer;
}
.tvpv-body { flex: 1; overflow-y: auto; scrollbar-width: none; padding: 0 0 3vw; }
.tvpv-hero { padding: 1vw 2.6vw .6vw; max-width: 62vw; }
.tvpv-hero[hidden] { display: none; }
.tvpv-hero h1 { font-size: 2.6vw; line-height: 1.15; margin: 0 0 .6vw; font-weight: 700; }
.tvpv-hero .tvpv-ent { font-size: .95vw; color: #1a98ff; font-weight: 600; margin-bottom: .5vw; }
.tvpv-hero p {
  font-size: 1.05vw; line-height: 1.45; color: #d0d6dc; margin: 0;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.tvpv-row { margin-top: 1.4vw; }
.tvpv-row h2 { font-size: 1.3vw; font-weight: 600; margin: 0 2.6vw .6vw; color: #f2f4f6; }
.tvpv-strip {
  display: flex; gap: 1vw; overflow-x: auto; scrollbar-width: none;
  padding: .5vw 2.6vw; scroll-padding: 0 2.6vw;
}
.tvpv-card { flex: 0 0 calc((100vw - 5.2vw - 4vw) / 5); min-width: 0; }
.tvpv-row.wide .tvpv-card { flex-basis: calc((100vw - 5.2vw - 3vw) / 4); }
.tvpv-thumb {
  position: relative; aspect-ratio: 16 / 9; border-radius: .6vw; overflow: hidden;
  background: #1b2530;
}
.tvpv-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tvpv-card.focused .tvpv-thumb, .tvpv-btn.focused { outline: .25vw solid #fff; outline-offset: .2vw; }
.tvpv-prog { position: absolute; left: 0; right: 0; bottom: 0; height: .3vw; background: rgba(255,255,255,.25); }
.tvpv-prog i { display: block; height: 100%; background: #1a98ff; }
.tvpv-lock {
  position: absolute; left: .45vw; top: .45vw; background: rgba(0,0,0,.75); color: #f5c518;
  font-size: .75vw; font-weight: 700; padding: .1vw .4vw; border-radius: .25vw;
}
.tvpv-title {
  margin-top: .5vw; font-size: 1.05vw; line-height: 1.3; font-weight: 500;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tvpv-meta { margin-top: .15vw; font-size: .85vw; color: #aab4be; }
.tvpv-btn {
  flex: none; background: #232f3e; color: #f2f4f6; border-radius: .5vw;
  font-size: 1.15vw; font-weight: 600; padding: .9vw 1.6vw; white-space: nowrap;
}
.tvpv-btn.primary { background: #f2f4f6; color: #0f171e; }
.tvpv-btn.current { box-shadow: inset 0 -.2vw 0 #1a98ff; }
.tvpv-empty { padding: 3vw 2.6vw; font-size: 1.2vw; color: #79838d; }
.tvpv-empty[hidden] { display: none; }
#tvpv-toast {
  position: fixed; left: 50%; top: 2.5vw; transform: translateX(-50%); z-index: 2147483647;
  background: #f2f4f6; color: #0f171e; font: 600 1vw system-ui, sans-serif;
  padding: .6vw 1.3vw; border-radius: 1.3vw; opacity: 0; transition: opacity .2s;
  pointer-events: none;
}
#tvpv-toast.show { opacity: 1; }
#tvpv-minibar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
  background: rgba(15,23,30,.92); border-top: 1px solid #3a4553;
  padding: .8vw 2.6vw 1vw; font-family: system-ui, sans-serif; color: #f2f4f6;
}
#tvpv-minibar[hidden] { display: none; }
.tvpv-mini-title { font-size: 1.15vw; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tvpv-mini-sub { font-size: .8vw; color: #aab4be; margin-top: .15vw; }
.tvpv-mini-track { position: relative; height: .3vw; background: #3a4553; border-radius: .15vw; margin-top: .5vw; }
.tvpv-mini-fill { height: 100%; background: #1a98ff; border-radius: .15vw; width: 0%; }
.tvpv-mini-preview {
  position: absolute; bottom: 1vw; transform: translateX(-50%);
  font-size: .9vw; font-weight: 600; background: rgba(0,0,0,.85);
  padding: .1vw .5vw; border-radius: .3vw; font-variant-numeric: tabular-nums;
}
.tvpv-mini-preview[hidden] { display: none; }
.tvpv-mini-hints { font-size: .7vw; color: #79838d; margin-top: .4vw; }
@media (prefers-reduced-motion: reduce) {
  #tvpv-toast { transition: none; }
}
`;
