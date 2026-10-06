import { startPrimeAdapter } from "./prime.js";
import { startYoutubeAdapter } from "./youtube.js";

// Per-site router. Netflix plugs in here next.
const host = location.hostname;
if (host === "www.youtube.com" || host.endsWith(".youtube.com")) {
  startYoutubeAdapter();
} else if (host === "www.primevideo.com") {
  startPrimeAdapter();
} else {
  console.log("[tv-control] no adapter for this site yet");
}
