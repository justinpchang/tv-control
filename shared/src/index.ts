// Shared phone -> PC protocol. Single source of truth for Phase 1.

export type AppId = "netflix" | "prime" | "youtube" | "geforce";

export type Command =
  | { type: "launch"; app: AppId }
  | { type: "navigate"; direction: "up" | "down" | "left" | "right" }
  | { type: "select" }
  | { type: "back" }
  | { type: "home" }
  | { type: "playPause" }
  | { type: "search"; text: string }
  | { type: "volume"; action: "up" | "down" | "mute" }
  | { type: "ping" };

export interface ServerState {
  activeApp: AppId | "home" | "unknown";
  volumeMuted: boolean;
  updatedAt: string;
}

export type ServerMessage =
  | { type: "state"; state: ServerState }
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
    case "ping":
      return { type: c.type as Command["type"] } as Command;
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
