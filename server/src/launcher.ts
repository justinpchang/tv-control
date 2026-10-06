import type { AppId, ServerState } from "@tv-control/shared";

// Platform capability boundary: mock runs anywhere, windows runs on the PC.
export interface Launcher {
  readonly name: "mock" | "windows";
  launch(app: AppId): Promise<void>;
  home(): Promise<void>;
  volume(action: "up" | "down" | "mute"): Promise<void>;
  getState(): ServerState;
}
