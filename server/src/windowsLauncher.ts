import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AppId } from "@tv-control/shared";
import type { Launcher, LauncherState } from "./launcher.js";
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
    const t0 = Date.now();
    try {
      if (app === "geforce") {
        await this.launchGeforce(config.geforceUri, config.geforceExePaths);
        // Native app: real maximize, not F11 (GFN ignores it).
        await findAndMaximize("GeForce NOW", 12);
      } else {
        // Cold-start Edge per service: a new window in a running instance
        // ignores --start-fullscreen and accumulates tabs.
        await closeEdge();
        const closedAt = Date.now();
        const url = config.edgeUrls[app] ?? `https://www.${app}.com`;
        await this.startDetached(`msedge --start-fullscreen --disable-session-crashed-bubble ${url}`, `Edge ${app}`);
        log.info(`launch ${app}: edge closed in ${closedAt - t0}ms, started in ${Date.now() - closedAt}ms`);
        // --start-fullscreen already covers the screen; focusing is a
        // safety net, so don't hold the phone's ack on it.
        void findAndMaximize(app, 8);
      }
      this.activeApp = app;
      this.lastError = null;
      log.info(`launch ${app}: ok in ${Date.now() - t0}ms`);
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
    // Graceful Edge close: a force-kill reads as a crash and Edge nags with
    // "Restore pages" on next launch. Force is only for stragglers.
    await closeEdge();
    const port = process.env.PORT ?? 8080;
    await this.startDetached(`msedge --start-fullscreen --disable-session-crashed-bubble http://localhost:${port}/home.html`, "Edge home");
    void findAndMaximize("TV Home", 8);
    this.activeApp = "home";
    log.info("home: recovery done");
  }

  async volume(action: "up" | "down" | "mute"): Promise<void> {
    const key = action === "up" ? "{VOLUME_UP}" : action === "down" ? "{VOLUME_DOWN}" : "{VOLUME_MUTE}";
    await sendKeys(key);
    if (action === "mute") this.volumeMuted = !this.volumeMuted;
  }

  // Real keystroke to the app window, so the page gets a user gesture that
  // page-initiated requestFullscreen lacks. YouTube's own "f" hotkey is
  // flaky (ignored when focus sits in an input or before player focus), so
  // the extension adapters (YouTube, Prime) catch an otherwise-unused F13
  // and drive the player's own fullscreen. Other sites get their "f" hotkey.
  async fullscreen(): Promise<void> {
    const title = WINDOW_TITLES[this.activeApp as AppId];
    const activate = title ? `[void]$s.AppActivate('${title}');` : "";
    const key = this.activeApp === "youtube" || this.activeApp === "prime" ? "{F13}" : "f";
    await runPs(`$s = New-Object -ComObject WScript.Shell; ${activate} $s.SendKeys('${key}')`);
  }

  getState(): LauncherState {
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

// Window title suffixes AppActivate can match for the Edge streaming apps.
const WINDOW_TITLES: Partial<Record<AppId, string>> = {
  youtube: "YouTube",
  netflix: "Netflix",
  prime: "Prime Video",
};

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

// Poll for the window and foreground it. Maximize only when it does not already
// cover its screen — a native-fullscreen window must not be "maximized".
// The rectangle is logged so fullscreen is verifiable remotely.
async function findAndMaximize(titleMatch: string, attempts: number): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    const query = await windowRect(titleMatch);
    if (query === null) {
      if (i === 1) log.info(`focus ${titleMatch}: waiting for window…`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (coversScreen(query)) {
      log.info(`focus ${titleMatch}: ${formatRect(query)} already fullscreen (attempt ${i})`);
      return;
    }
    const after = await maximizeNow(titleMatch);
    log.info(`focus ${titleMatch}: ${after ? formatRect(after) + " maximized" : "maximize failed"} (attempt ${i})`);
    return;
  }
  log.warn(`focus ${titleMatch}: no window matched after ${attempts}s`);
}

// Ask Edge windows to close (clean exit, so session state is saved and there
// is no restore prompt), then force the windowless leftovers. Startup boost /
// background mode keep msedge processes alive indefinitely, so waiting for
// every process to exit just burned the full timeout on each launch. One
// PowerShell call: each spawn costs ~0.5s on the OptiPlex.
async function closeEdge(): Promise<void> {
  const out = await runPsCapture([
    "$edge = Get-Process msedge -ErrorAction SilentlyContinue;",
    "if (-not $edge) { Write-Output 'none'; exit 0 }",
    "$edge | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() | Out-Null };",
    "$deadline = (Get-Date).AddSeconds(4);",
    "while ((Get-Date) -lt $deadline) {",
    "  $w = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 };",
    "  if (-not $w) { break }",
    "  Start-Sleep -Milliseconds 100",
    "}",
    "$state = if ($w) { 'forced' } else { 'closed' };",
    "Start-Sleep -Milliseconds 300;",
    "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;",
    "Write-Output $state",
  ].join("\n")).catch((e) => `error ${e instanceof Error ? e.message : e}`);
  log.info(`exit wait: msedge ${out.trim()}`);
}

interface WinRect {
  left: number; top: number; right: number; bottom: number;
  screenW: number; screenH: number; screenX: number; screenY: number;
}

function formatRect(r: WinRect): string {
  return `WINDOW left=${r.left} top=${r.top} right=${r.right} bottom=${r.bottom} ` +
    `screen=${r.screenW}x${r.screenH}+${r.screenX}+${r.screenY}`;
}

function coversScreen(r: WinRect): boolean {
  const tol = 16;
  return r.left <= r.screenX + tol && r.top <= r.screenY + tol &&
    (r.right - r.left) >= r.screenW - tol && (r.bottom - r.top) >= r.screenH - tol;
}

function parseRect(line: string): WinRect | null {
  const m = /WINDOW left=(-?\d+) top=(-?\d+) right=(-?\d+) bottom=(-?\d+) screen=(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(line);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return { left: n[0], top: n[1], right: n[2], bottom: n[3], screenW: n[4], screenH: n[5], screenX: n[6], screenY: n[7] };
}

async function windowRect(titleMatch: string): Promise<WinRect | null> {
  try {
    const out = await runPsCapture(rectScript(titleMatch, false));
    return parseRect(out.trim().split("\n").pop()?.trim() ?? "");
  } catch {
    return null;
  }
}

async function maximizeNow(titleMatch: string): Promise<WinRect | null> {
  try {
    const out = await runPsCapture(rectScript(titleMatch, true));
    return parseRect(out.trim().split("\n").pop()?.trim() ?? "");
  } catch (e) {
    log.warn(`focus ${titleMatch}: powershell failed (${e instanceof Error ? e.message : e})`);
    return null;
  }
}

function rectScript(titleMatch: string, maximize: boolean): string {
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
    maximize ? "[Win32]::ShowWindow($h, 3) | Out-Null;" : "",
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
