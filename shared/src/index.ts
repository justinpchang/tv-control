// Shared phone -> PC protocol. Single source of truth for Phase 1 + 2.
//
// Phone <-> server: Command (phone sends) and ServerMessage (server sends).
// Extension <-> server: AdapterMessage. The server relays adapter-routed
// commands (d-pad, transport, search) to connected adapters and broadcasts
// adapter context to phones so the PWA can render per-app controls.

export type AppId = "netflix" | "prime" | "youtube" | "geforce";

export type Command =
  | { type: "launch"; app: AppId }
  | { type: "navigate"; direction: "up" | "down" | "left" | "right" }
  | { type: "select" }
  | { type: "back" }
  | { type: "home" }
  | { type: "playPause" }
  | { type: "fullscreen" }
  | { type: "seek"; seconds: number }
  | { type: "seekTo"; seconds: number }
  | { type: "captions" }
  | { type: "quality"; level: string }
  | { type: "openVideo"; videoId: string }
  | { type: "search"; text: string }
  | { type: "volume"; action: "up" | "down" | "mute" }
  | { type: "ping" };

// Commands the server forwards to site adapters (extension). launch/home/
// volume/ping stay server-side, as does fullscreen: it needs a real keypress
// (browsers refuse requestFullscreen without a user gesture).
const ADAPTER_COMMAND_TYPES = new Set([
  "navigate", "select", "back", "playPause", "seek", "seekTo", "captions", "quality", "openVideo", "search",
]);

export function isAdapterCommand(command: Command): boolean {
  return ADAPTER_COMMAND_TYPES.has(command.type);
}

// --- Adapter context (extension -> server -> phone) ---

export interface VideoItem {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
}

export interface NowPlaying extends VideoItem {
  currentTimeSec: number;
  durationSec: number;
  paused: boolean;
  // null when the video has no captions track.
  captions: boolean | null;
  // YouTube quality ids ("auto", "hd1080", "large", ...); [] until known.
  quality: string;
  qualities: string[];
}

export interface YoutubeContext {
  app: "youtube";
  screen: "browse" | "search" | "watch";
  query: string;
  nowPlaying: NowPlaying | null;
  // Recently watched, newest first (kept by the extension, capped at 12).
  recent: VideoItem[];
}

// Union grows as netflix/prime adapters land.
export type AppContext = YoutubeContext;

export type AdapterMessage =
  | { type: "adapterHello"; app: AppId }
  // Keepalive: MV3 service workers sleep after ~30s without traffic.
  | { type: "adapterPing" }
  | { type: "adapterContext"; context: AppContext };

export interface ServerState {
  activeApp: AppId | "home" | "unknown";
  volumeMuted: boolean;
  updatedAt: string;
  // Adapter apps with a live extension connection. The PWA uses this to show
  // contextual controls only when the on-TV side can actually respond.
  adapters: AppId[];
}

export type ServerMessage =
  | { type: "state"; state: ServerState }
  | { type: "context"; context: AppContext }
  | { type: "ack"; command: Command }
  | { type: "error"; message: string };

const APP_IDS: AppId[] = ["netflix", "prime", "youtube", "geforce"];

export function parseCommand(input: unknown): Command {
  if (typeof input !== "object" || input === null) throw new Error("not an object");
  const c = input as Record<string, unknown>;
  switch (c.type) {
    case "launch":
      if (typeof c.app === "string" && (APP_IDS as string[]).includes(c.app)) {
        return { type: "launch", app: c.app as AppId };
      }
      throw new Error("launch.app must be netflix|prime|youtube|geforce");
    case "navigate":
      if (c.direction === "up" || c.direction === "down" || c.direction === "left" || c.direction === "right") {
        return { type: "navigate", direction: c.direction };
      }
      throw new Error("navigate.direction invalid");
    case "select":
    case "back":
    case "home":
    case "playPause":
    case "fullscreen":
    case "ping":
      return { type: c.type as Command["type"] } as Command;
    case "captions":
      return { type: "captions" };
    case "seekTo":
      if (typeof c.seconds === "number" && Number.isFinite(c.seconds) && c.seconds >= 0 && c.seconds <= 86400) {
        return { type: "seekTo", seconds: c.seconds };
      }
      throw new Error("seekTo.seconds must be within 0..86400");
    case "quality":
      if (typeof c.level === "string" && /^[a-z0-9]{1,16}$/.test(c.level)) {
        return { type: "quality", level: c.level };
      }
      throw new Error("quality.level must be a YouTube quality id");
    case "seek":
      if (typeof c.seconds === "number" && Number.isFinite(c.seconds) && Math.abs(c.seconds) <= 3600) {
        return { type: "seek", seconds: c.seconds };
      }
      throw new Error("seek.seconds must be a finite number within ±3600");
    case "openVideo":
      if (typeof c.videoId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c.videoId)) {
        return { type: "openVideo", videoId: c.videoId };
      }
      throw new Error("openVideo.videoId must be 1..64 url-safe chars");
    case "search":
      if (typeof c.text === "string" && c.text.length > 0 && c.text.length <= 200) {
        return { type: "search", text: c.text };
      }
      throw new Error("search.text must be 1..200 chars");
    case "volume":
      if (["up", "down", "mute"].includes(c.action as string)) {
        return { type: "volume", action: c.action as "up" | "down" | "mute" };
      }
      throw new Error("volume.action must be up|down|mute");
    default:
      throw new Error(`unknown command: ${String(c.type)}`);
  }
}

function parseVideoItem(input: unknown): VideoItem | null {
  if (typeof input !== "object" || input === null) return null;
  const v = input as Record<string, unknown>;
  if (typeof v.videoId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.videoId)) return null;
  return {
    videoId: v.videoId,
    title: typeof v.title === "string" ? v.title.slice(0, 300) : "",
    channel: typeof v.channel === "string" ? v.channel.slice(0, 200) : "",
    thumbnail: typeof v.thumbnail === "string" ? v.thumbnail.slice(0, 2000) : "",
  };
}

function numOr(input: unknown, fallback: number): number {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback;
}

export function parseAppContext(input: unknown): AppContext {
  if (typeof input !== "object" || input === null) throw new Error("context not an object");
  const c = input as Record<string, unknown>;
  if (c.app !== "youtube") throw new Error(`unsupported context app: ${String(c.app)}`);
  if (c.screen !== "browse" && c.screen !== "search" && c.screen !== "watch") {
    throw new Error("context.screen must be browse|search|watch");
  }
  let nowPlaying: NowPlaying | null = null;
  if (typeof c.nowPlaying === "object" && c.nowPlaying !== null) {
    const item = parseVideoItem(c.nowPlaying);
    if (item) {
      const np = c.nowPlaying as Record<string, unknown>;
      nowPlaying = {
        ...item,
        currentTimeSec: Math.max(0, numOr(np.currentTimeSec, 0)),
        durationSec: Math.max(0, numOr(np.durationSec, 0)),
        paused: np.paused !== false,
        captions: typeof np.captions === "boolean" ? np.captions : null,
        quality: typeof np.quality === "string" ? np.quality.slice(0, 16) : "",
        qualities: Array.isArray(np.qualities)
          ? np.qualities.filter((q): q is string => typeof q === "string" && /^[a-z0-9]{1,16}$/.test(q)).slice(0, 16)
          : [],
      };
    }
  }
  return {
    app: "youtube",
    screen: c.screen,
    query: typeof c.query === "string" ? c.query.slice(0, 200) : "",
    nowPlaying,
    recent: Array.isArray(c.recent)
      ? c.recent.map(parseVideoItem).filter((v): v is VideoItem => v !== null).slice(0, 12)
      : [],
  };
}

export function parseAdapterMessage(input: unknown): AdapterMessage {
  if (typeof input !== "object" || input === null) throw new Error("not an object");
  const m = input as Record<string, unknown>;
  switch (m.type) {
    case "adapterHello":
      if (typeof m.app === "string" && (APP_IDS as string[]).includes(m.app)) {
        return { type: "adapterHello", app: m.app as AppId };
      }
      throw new Error("adapterHello.app must be netflix|prime|youtube|geforce");
    case "adapterPing":
      return { type: "adapterPing" };
    case "adapterContext":
      return { type: "adapterContext", context: parseAppContext(m.context) };
    default:
      throw new Error(`unknown adapter message: ${String(m.type)}`);
  }
}
