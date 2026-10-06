import type { AppId, ServerState } from "@tv-control/shared";
import type { Launcher } from "./launcher.js";

// Safe anywhere. Records intent so Mac dev can prove the phone -> PC loop
// without touching real Windows APIs.
export class MockLauncher implements Launcher {
  readonly name = "mock" as const;
  private activeApp: AppId | "home" | "unknown" = "home";
  private volumeMuted = false;

  async launch(app: AppId): Promise<void> {
    console.log(`[mock] launch ${app} (focus + fullscreen)`);
    this.activeApp = app;
  }

  async home(): Promise<void> {
    console.log("[mock] home (close apps, show launcher, fullscreen)");
    this.activeApp = "home";
  }

  async volume(action: "up" | "down" | "mute"): Promise<void> {
    console.log(`[mock] volume ${action}`);
    if (action === "mute") this.volumeMuted = !this.volumeMuted;
  }

  getState(): ServerState {
    return { activeApp: this.activeApp, volumeMuted: this.volumeMuted, updatedAt: new Date().toISOString() };
  }
}
