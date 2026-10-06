// Ring-buffer log: console output plus a tail readable over HTTP (GET /logs)
// so the service can be debugged remotely from another machine on the LAN.
// Every entry is also appended to a log file (LOG_FILE, default
// ./logs/service.log) so the trail survives a crash that takes /logs with it.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  msg: string;
}

const MAX_ENTRIES = 500;
let nextId = 1;
const entries: LogEntry[] = [];

let filePath: string | null = null;

function push(level: LogLevel, msg: string): LogEntry {
  const entry = { id: nextId++, ts: new Date().toISOString(), level, msg };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  console.log(`[${entry.ts}] ${level} ${msg}`);
  // Sync append: if this line is the last thing before a crash, it still lands.
  try {
    if (filePath === null) {
      filePath = resolve(process.cwd(), process.env.LOG_FILE ?? "logs/service.log");
      mkdirSync(dirname(filePath), { recursive: true });
    }
    appendFileSync(filePath, JSON.stringify(entry) + "\n");
  } catch { /* file logging is best-effort; memory + console remain */ }
  return entry;
}

export const log = {
  info: (msg: string) => push("info", msg),
  warn: (msg: string) => push("warn", msg),
  error: (msg: string) => push("error", msg),
};

export function getLogs(limit = 200, since = 0): LogEntry[] {
  const saneLimit = Math.min(Math.max(limit, 1), MAX_ENTRIES);
  return entries.filter((e) => e.id > since).slice(-saneLimit);
}
