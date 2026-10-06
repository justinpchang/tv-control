// Runs in the page's MAIN world (manifest "world": "MAIN") because YouTube's
// player API lives on the #movie_player element's JS object, which the
// isolated content script can't see. Talks to youtube.ts via JSON-string
// CustomEvents on document (strings cross the world boundary intact).

interface YtPlayer {
  getAvailableQualityLevels?: () => string[];
  getPreferredQuality?: () => string;
  setPlaybackQualityRange?: (min: string, max?: string) => void;
  setPlaybackRate?: (rate: number) => void;
  getPlayerResponse?: () => {
    storyboards?: { playerStoryboardSpecRenderer?: { spec?: string } };
  } | null;
}

function player(): YtPlayer | null {
  return document.getElementById("movie_player") as unknown as YtPlayer | null;
}

function report(): void {
  const p = player();
  let spec = "";
  try {
    spec = p?.getPlayerResponse?.()?.storyboards?.playerStoryboardSpecRenderer?.spec ?? "";
  } catch {
    /* response not ready */
  }
  const info = {
    levels: p?.getAvailableQualityLevels?.() ?? [],
    preferred: p?.getPreferredQuality?.() ?? "auto",
    storyboardSpec: spec,
  };
  document.dispatchEvent(new CustomEvent("tvyt:player", { detail: JSON.stringify(info) }));
}

document.addEventListener("tvyt:playerReq", (e) => {
  try {
    const req = JSON.parse(String((e as CustomEvent).detail ?? "{}")) as { set?: string; rate?: number };
    const p = player();
    if (req.set && p?.setPlaybackQualityRange) p.setPlaybackQualityRange(req.set, req.set);
    // Player API keeps YouTube's own speed menu in sync; video.playbackRate
    // is the fallback.
    if (typeof req.rate === "number") {
      if (p?.setPlaybackRate) p.setPlaybackRate(req.rate);
      else {
        const v = document.querySelector("video");
        if (v) v.playbackRate = req.rate;
      }
    }
  } catch {
    /* player mid-load */
  }
  report();
});
