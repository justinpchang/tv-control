import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AppId, ServerState } from "@tv-control/shared";
import type { Launcher } from "./launcher.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";

// Real implementation for the OptiPlex. Never import this on Mac.
// Launch order per app: URI scheme first, then configured exe paths that exist
// on disk. Failures are recorded (see diagnose()) instead of vanishing.
export class WindowsLauncher implements Launcher {
  readonly name = "windows" as const;
  private activeApp: AppId | "home" | "unknown" = "unknown";
  private volumeMuted = false;
  private lastError: string | null = null;

  async launch(app: AppId): Promise<void> {
    const config = loadConfig();
    try {
      if (app === "geforce") {
        await this.launchGeforce(config.geforceUri, config.geforceExePaths);
      } else {
        const url = config.edgeUrls[app] ?? `https://www.${app}.com`;
        await this.startDetached(`msedge --start-fullscreen ${url}`, `Edge ${app}`);
      }
      await focusWindow(app === "geforce" ? "GeForce NOW" : app).catch(() => {});
      await sendKeys("{F11}").catch(() => {});
      this.activeApp = app;
      this.lastError = null;
      log.info(`launch ${app}: ok`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      log.error(`launch ${app}: ${this.lastError}`);
      throw e;
    }
  }

  private async launchGeforce(uri: string, exePaths: string[]): Promise<void> {
    try {
      await this.startDetached(uri, `URI ${uri}`);
      log.info(`geforce: handled by URI scheme ${uri}`);
      return;
    } catch (e) {
      log.warn(`geforce: URI scheme failed (${e instanceof Error ? e.message : e}); trying exe paths`);
    }
    for (const exe of exePaths) {
      if (!existsSync(exe)) {
        log.warn(`geforce: not on disk: ${exe}`);
        continue;
      }
      spawn(exe, [], { detached: true, stdio: "ignore" }).unref?.();
      log.info(`geforce: started ${exe}`);
      return;
    }
    throw new Error(`no GeForce NOW target worked (uri ${uri}, ${exePaths.length} exe paths checked)`);
  }

  private startDetached(target: string, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile("cmd", ["/c", "start", "", ...target.split(" ")], { timeout: 15000 }, (err) => {
        if (err) reject(new Error(`${label}: ${err.message.split("\n")[0]}`));
        else resolve();
      });
    });
  }

  async home(): Promise<void> {
    await runPs("Get-Process GeForceNOW -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => {});
    await runPs("Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => {});
    spawn("cmd", ["/c", "start", "", "msedge", "--start-fullscreen", "http://localhost:8080/home.html"],
      { detached: true, stdio: "ignore" });
    this.activeApp = "home";
    log.info("home: recovery done");
  }

  async volume(action: "up" | "down" | "mute"): Promise<void> {
    const key = action === "up" ? "{VOLUME_UP}" : action === "down" ? "{VOLUME_DOWN}" : "{VOLUME_MUTE}";
    await sendKeys(key);
    if (action === "mute") this.volumeMuted = !this.volumeMuted;
  }

  getState(): ServerState {
    return { activeApp: this.activeApp, volumeMuted: this.volumeMuted, updatedAt: new Date().toISOString() };
  }

  async diagnose(): Promise<Record<string, unknown>> {
    const config = loadConfig();
    return {
      mode: "windows",
      lastError: this.lastError,
      geforceUri: config.geforceUri,
      geforceExePaths: config.geforceExePaths.map((p) => ({ path: p, exists: existsSync(p) })),
      edgeUrls: config.edgeUrls,
    };
  }
}

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

async function focusWindow(titleMatch: string): Promise<void> {
  await runPs([
    "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);'",
    "Add-Type -MemberDefinition $sig -Name Win32 -Namespace W;",
    `$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${titleMatch}*' } | Select-Object -First 1;`,
    "if ($p) { [W.Win32]::SetForegroundWindow($p.MainWindowHandle) }",
  ].join(" "));
}
