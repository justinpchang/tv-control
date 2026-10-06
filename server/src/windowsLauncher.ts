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
        // Native app: real maximize, not F11 (GFN ignores it).
        await findAndMaximize("GeForce NOW", 12);
      } else {
        const url = config.edgeUrls[app] ?? `https://www.${app}.com`;
        await this.startDetached(`msedge --start-fullscreen ${url}`, `Edge ${app}`);
        await findAndMaximize(app, 6);
      }
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
    // Cold-start Edge: a new window in a lingering instance ignores --start-fullscreen.
    await this.waitForExit("msedge", 10);
    const port = process.env.PORT ?? 8080;
    await this.startDetached(`msedge --start-fullscreen http://localhost:${port}/home.html`, "Edge home");
    await findAndMaximize("TV Home", 8);
    this.activeApp = "home";
    log.info("home: recovery done");
  }

  private async waitForExit(name: string, timeoutSec: number): Promise<void> {
    for (let i = 0; i < timeoutSec; i++) {
      const out = await runPsCapture(
        `(Get-Process ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ).catch(() => "?");
      if (out.trim() === "0") {
        log.info(`home: ${name} exited`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log.warn(`home: ${name} still alive after ${timeoutSec}s; launching anyway`);
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

  async screenshot(): Promise<Buffer> {
    const { captureScreenshot } = await import("./screen.js");
    return captureScreenshot();
  }
}

export function runPs(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], (err) => {
      err ? reject(err) : resolve();
    });
  });
}

function sendKeys(keys: string): Promise<void> {
  return runPs(`(New-Object -ComObject WScript.Shell).SendKeys('${keys}')`);
}

// Poll for the window, maximize + foreground it, and report the resulting
// rectangle against its screen so fullscreen is verifiable from the logs.
async function findAndMaximize(titleMatch: string, attempts: number): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    let line = "";
    try {
      const out = await runPsCapture(maximizeScript(titleMatch));
      line = out.trim().split("\n").pop()?.trim() ?? "";
    } catch (e) {
      log.warn(`focus ${titleMatch}: powershell failed (${e instanceof Error ? e.message : e})`);
      return;
    }
    if (line.startsWith("WINDOW")) {
      log.info(`focus ${titleMatch}: ${line} (attempt ${i})`);
      return;
    }
    if (i === 1) log.info(`focus ${titleMatch}: waiting for window…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  log.warn(`focus ${titleMatch}: no window matched after ${attempts}s`);
}

function maximizeScript(titleMatch: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class Win32 {",
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);',
    "  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }",
    "}",
    "'@;",
    "Add-Type -TypeDefinition $sig;",
    `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${titleMatch}*' } | Select-Object -First 1;`,
    "if (-not $p) { Write-Output 'NO_WINDOW'; exit 0 }",
    "$h = $p.MainWindowHandle;",
    "[Win32]::ShowWindow($h, 3) | Out-Null;",
    "[Win32]::SetForegroundWindow($h) | Out-Null;",
    "Start-Sleep -Milliseconds 600;",
    "$rect = New-Object Win32+RECT;",
    "[Win32]::GetWindowRect($h, [ref]$rect) | Out-Null;",
    "$b = [System.Windows.Forms.Screen]::FromHandle($h).Bounds;",
    "Write-Output ('WINDOW left={0} top={1} right={2} bottom={3} screen={4}x{5}+{6}+{7}' -f $rect.Left,$rect.Top,$rect.Right,$rect.Bottom,$b.Width,$b.Height,$b.X,$b.Y);",
  ].join("\n");
}

function runPsCapture(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000 }, (err, stdout) => {
      err ? reject(err) : resolve(stdout);
    });
  });
}
