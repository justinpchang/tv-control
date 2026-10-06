// Runs in the page's MAIN world (manifest "world": "MAIN") because YouTube's
// player API lives on the #movie_player element's JS object, which the
// isolated content script can't see. Talks to youtube.ts via JSON-string
// CustomEvents on document (strings cross the world boundary intact).

interface YtPlayer {
  getAvailableQualityLevels?: () => string[];
  getPlaybackQuality?: () => string;
  getPreferredQuality?: () => string;
  setPlaybackQualityRange?: (min: string, max?: string) => void;
}

function player(): YtPlayer | null {
  return document.getElementById("movie_player") as unknown as YtPlayer | null;
}

function report(): void {
  const p = player();
  const info = {
    levels: p?.getAvailableQualityLevels?.() ?? [],
    preferred: p?.getPreferredQuality?.() ?? "auto",
  };
  document.dispatchEvent(new CustomEvent("tvyt:quality", { detail: JSON.stringify(info) }));
}

document.addEventListener("tvyt:qualityReq", (e) => {
  try {
    const req = JSON.parse(String((e as CustomEvent).detail ?? "{}")) as { set?: string };
    const p = player();
    if (req.set && p?.setPlaybackQualityRange) p.setPlaybackQualityRange(req.set, req.set);
  } catch {
    /* player mid-load */
  }
  report();
});
