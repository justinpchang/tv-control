import { startYoutubeAdapter } from "./youtube.js";

// Per-site router. YouTube ships first; netflix/prime adapters plug in here.
if (location.hostname === "www.youtube.com" || location.hostname.endsWith(".youtube.com")) {
  startYoutubeAdapter();
} else {
  console.log("[tv-control] no adapter for this site yet");
}
