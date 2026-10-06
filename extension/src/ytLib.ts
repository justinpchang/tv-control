// Pure helpers for the YouTube adapter: no DOM, no chrome APIs, so they can
// be exercised from plain node. DOM scraping lives in youtube.ts.

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function videoIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(href);
  return m ? m[1] : null;
}

export type NavDirection = "up" | "down" | "left" | "right";

// Grid focus movement with clamping (TV-style: stop at edges, never wrap).
export function moveFocus(index: number, count: number, columns: number, direction: NavDirection): number {
  if (count <= 0) return 0;
  const cols = Math.max(1, Math.floor(columns));
  const cur = Math.max(0, Math.min(count - 1, Math.floor(index)));
  switch (direction) {
    case "left": return cur % cols === 0 ? cur : cur - 1;
    case "right": return cur % cols === cols - 1 || cur + 1 >= count ? cur : cur + 1;
    case "up": return cur - cols < 0 ? cur : cur - cols;
    case "down": return cur + cols >= count ? cur : cur + cols;
  }
}

export function columnsFor(containerWidthPx: number, cardWidthPx: number): number {
  return Math.max(1, Math.floor(containerWidthPx / Math.max(1, cardWidthPx)));
}

export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

export function screenForPath(pathname: string, search: string): "browse" | "search" | "watch" {
  if (pathname.startsWith("/watch")) return "watch";
  if (pathname.startsWith("/results") && search.includes("search_query")) return "search";
  return "browse";
}
