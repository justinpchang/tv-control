// Pure helpers for the Prime Video adapter: no DOM, no chrome APIs, so they
// can be exercised from plain node. DOM scraping lives in prime.ts.

export type PrimeScreen = "browse" | "search" | "detail" | "watch";
export type NavDirection = "up" | "down" | "left" | "right";

export const PRIME_ORIGIN = "https://www.primevideo.com";

// "/detail/0H1T1C23B07HLZPPHJSSPMYSL7?ref_=..." and "/gp/video/detail/B0B8TNQ2KP/".
export function titleIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /\/detail\/(?:[^/?#]+\/)?([A-Za-z0-9]{10,64})(?:[/?#]|$)/.exec(href);
  return m ? m[1] : null;
}

export function detailUrl(titleId: string): string {
  return `${PRIME_ORIGIN}/detail/${titleId}`;
}

export function searchUrl(text: string): string {
  return `${PRIME_ORIGIN}/search/ref=atv_nb_sug?phrase=${encodeURIComponent(text)}`;
}

// Page screen from the URL. "watch" is not a URL: the player overlays the
// detail page, so the adapter checks the DOM for it.
export function screenForPath(pathname: string, search: string): Exclude<PrimeScreen, "watch"> {
  if (/\/detail\//.test(pathname)) return "detail";
  if (/\/search\b/.test(pathname) && /[?&]phrase=/.test(search)) return "search";
  return "browse";
}

// Row-based focus (TV-style, never wraps). Each row remembers its column so
// coming back to a row lands where you left it.
export interface RowFocus {
  row: number;
  cols: number[];
}

export function moveRowFocus(focus: RowFocus, rowLengths: number[], direction: NavDirection): RowFocus {
  if (rowLengths.length === 0) return { row: 0, cols: [] };
  const cols = rowLengths.map((len, i) => Math.max(0, Math.min(len - 1, focus.cols[i] ?? 0)));
  let row = Math.max(0, Math.min(rowLengths.length - 1, focus.row));
  if (direction === "up" || direction === "down") {
    const step = direction === "up" ? -1 : 1;
    // Skip empty rows.
    let next = row + step;
    while (next >= 0 && next < rowLengths.length && rowLengths[next] === 0) next += step;
    if (next >= 0 && next < rowLengths.length) row = next;
  } else {
    const len = rowLengths[row];
    cols[row] = Math.max(0, Math.min(len - 1, cols[row] + (direction === "left" ? -1 : 1)));
  }
  return { row, cols };
}

// "0:22:46", "00:24", "1:02:03" -> seconds; NaN when not a clock.
export function parseClock(text: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(r).padStart(2, "0")}`;
}

// Prime stitches ads into the media stream, so video.currentTime runs ahead
// of the content clock by the ads already played. The adapter calibrates the
// offset from Prime's seek bar whenever its controls are up, and freezes the
// content clock during ads.
export interface AdClock {
  offset: number;
  contentSec: number;
  // Content duration from the seek bar; 0 until calibrated.
  durationSec: number;
  calibrated: boolean;
}

export function newAdClock(): AdClock {
  return { offset: 0, contentSec: 0, durationSec: 0, calibrated: false };
}

export function tickAdClock(
  clock: AdClock,
  videoSec: number,
  ad: boolean,
  seekBar: { currentSec: number; durationSec: number } | null,
): AdClock {
  if (ad) return { ...clock, offset: Math.max(0, videoSec - clock.contentSec) };
  if (seekBar && Number.isFinite(seekBar.currentSec)) {
    return {
      offset: Math.max(0, videoSec - seekBar.currentSec),
      contentSec: seekBar.currentSec,
      durationSec: Number.isFinite(seekBar.durationSec) ? seekBar.durationSec : clock.durationSec,
      calibrated: true,
    };
  }
  return { ...clock, contentSec: Math.max(0, videoSec - clock.offset) };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
