import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./log.js";

// Launch targets live outside the code so a wrong path is a config edit on the
// PC, not a rebuild. Reloaded on every launch call: edit, tap the PWA button,
// check /logs — no restart needed.
export interface AppsConfig {
  geforceUri: string;
  geforceExePaths: string[];
  edgeUrls: Record<string, string>;
  // Minutes idle on the home screen before the screensaver starts.
  screensaverIdleMin: number;
}

const DEFAULTS: AppsConfig = {
  geforceUri: "geforcenow:",
  geforceExePaths: [
    "C:\\Program Files\\NVIDIA Corporation\\GeForce NOW\\GeForceNOW.exe",
    "C:\\Program Files (x86)\\NVIDIA Corporation\\GeForce NOW\\GeForceNOW.exe",
  ],
  edgeUrls: {
    netflix: "https://www.netflix.com",
    prime: "https://www.primevideo.com",
    youtube: "https://www.youtube.com/",
  },
  screensaverIdleMin: 5,
};

export function configPath(): string {
  return resolve(process.cwd(), "apps.json");
}

export function loadConfig(): AppsConfig {
  const path = configPath();
  if (!existsSync(path)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppsConfig>;
    return {
      geforceUri: raw.geforceUri ?? DEFAULTS.geforceUri,
      geforceExePaths: raw.geforceExePaths ?? DEFAULTS.geforceExePaths,
      edgeUrls: { ...DEFAULTS.edgeUrls, ...(raw.edgeUrls ?? {}) },
      screensaverIdleMin: typeof raw.screensaverIdleMin === "number" && raw.screensaverIdleMin > 0
        ? raw.screensaverIdleMin
        : DEFAULTS.screensaverIdleMin,
    };
  } catch (e) {
    log.warn(`apps.json unreadable (${e instanceof Error ? e.message : e}); using defaults`);
    return DEFAULTS;
  }
}
