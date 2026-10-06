import { execFile, spawn } from "node:child_process";
import type { AppId, ServerState } from "@tv-control/shared";
import type { Launcher } from "./launcher.js";

// Real implementation for the OptiPlex. Never import this on Mac.
const EDGE_URLS: Record<Exclude<AppId, "geforce">, string> = {
  netflix: "https://www.netflix.com",
  prime: "https://www.primevideo.com",
  youtube: "https://www.youtube.com/tv",
};

function runPs(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => {
      err ? reject(err) : resolve();
    });
  });
}

function sendKeys(keys: string): Promise<void> {
  return runPs(`(New-Object -ComObject WScript.Shell).SendKeys('${keys}')`);
}

export class WindowsLauncher implements Launcher {
  readonly name = "windows" as const;
  private activeApp: AppId | "home" | "unknown" = "unknown";
  private volumeMuted = false;

  async launch(app: AppId): Promise<void> {
    if (app === "geforce") {
      spawn("cmd", ["/c", "start", "", "geforcenow:"], { detached: true, stdio: "ignore" });
      spawn(
        "C:\\Program Files\\NVIDIA Corporation\\GeForce NOW\\GeForceNOW.exe",
        [],
        { detached: true, stdio: "ignore" },
      ).unref?.();
      await focusWindow("GeForce NOW").catch(() => {});
    } else {
      spawn(
        "cmd",
        ["/c", "start", "", "msedge", "--start-fullscreen", EDGE_URLS[app]],
        { detached: true, stdio: "ignore" },
      );
      await focusWindow(app).catch(() => {});
    }
    await sendKeys("{F11}").catch(() => {});
    this.activeApp = app;
  }

  async home(): Promise<void> {
    // Deterministic recovery: close known foreground apps, reopen neutral Home.
    await runPs("Get-Process GeForceNOW -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => {});
    await runPs("Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => {});
    spawn("cmd", ["/c", "start", "", "msedge", "--start-fullscreen", "http://localhost:8080/home.html"],
      { detached: true, stdio: "ignore" });
    this.activeApp = "home";
  }

  async volume(action: "up" | "down" | "mute"): Promise<void> {
    const key = action === "up" ? "{VOLUME_UP}" : action === "down" ? "{VOLUME_DOWN}" : "{VOLUME_MUTE}";
    await sendKeys(key);
    if (action === "mute") this.volumeMuted = !this.volumeMuted;
  }

  getState(): ServerState {
    return { activeApp: this.activeApp, volumeMuted: this.volumeMuted, updatedAt: new Date().toISOString() };
  }
}

async function focusWindow(titleMatch: string): Promise<void> {
  await runPs([
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    "Add-Type -MemberDefinition $sig -Name Win32 -Namespace W;",
    `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${titleMatch}*' } | Select-Object -First 1;`,
    "if ($p) { [W.Win32]::SetForegroundWindow($p.MainWindowHandle) }",
  ].join(" "));
}
