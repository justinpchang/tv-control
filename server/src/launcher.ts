import type { AppId, ServerState } from "@tv-control/shared";

// Launchers report device state; the service adds the live adapter list.
export type LauncherState = Omit<ServerState, "adapters" | "screensaver">;

// Platform capability boundary: mock runs anywhere, windows runs on the PC.
export interface Launcher {
  readonly name: "mock" | "windows";
  // url: open the app at a specific page (deep link) instead of its start page.
  launch(app: AppId, url?: string): Promise<void>;
  home(): Promise<void>;
  volume(action: "up" | "down" | "mute"): Promise<void>;
  // Toggle the active player's fullscreen with a real "f" keypress.
  fullscreen(): Promise<void>;
  getState(): LauncherState;
  // Machine-readable health for remote debugging (GET /api/state).
  diagnose(): Promise<Record<string, unknown>>;
  // PNG of the virtual desktop (GET /screenshot). May reject off-Windows.
  screenshot(): Promise<Buffer>;
}
