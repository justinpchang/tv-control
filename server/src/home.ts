import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SCREENSAVER_MODES,
  type AppContext,
  type HomeFeed,
  type JumpItem,
  type ResumeApp,
  type ScreensaverMode,
} from "@tv-control/shared";
import { log } from "./log.js";

// Home screen memory: "Jump back in" items from adapter contexts plus the
// chosen screensaver, persisted to DATA_DIR/home.json (gitignored) so the
// row survives restarts and Home (which clears live contexts).

interface Saved {
  screensaver: ScreensaverMode;
  jump: Record<ResumeApp, JumpItem[]>;
  // Last playback per app: orders the row.
  usedAt: Partial<Record<ResumeApp, number>>;
}

const EMPTY: Saved = { screensaver: "art", jump: { youtube: [], prime: [] }, usedAt: {} };

export class HomeStore {
  private data: Saved;
  private readonly path: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private jumpSig = "";

  // onJumpChange: the row changed and is worth broadcasting.
  constructor(dir: string, private readonly onJumpChange: () => void) {
    this.path = resolve(dir, "home.json");
    mkdirSync(dir, { recursive: true });
    this.data = this.load();
    this.jumpSig = JSON.stringify(this.jumpBack());
  }

  private load(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Saved>;
      return {
        screensaver: SCREENSAVER_MODES.includes(raw.screensaver as ScreensaverMode) ? raw.screensaver! : "art",
        jump: { ...EMPTY.jump, ...raw.jump },
        usedAt: raw.usedAt ?? {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 5_000);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
      renameSync(`${this.path}.tmp`, this.path);
    } catch (e) {
      log.warn(`home: save failed (${e instanceof Error ? e.message : e})`);
    }
  }

  get screensaver(): ScreensaverMode {
    return this.data.screensaver;
  }

  set screensaver(mode: ScreensaverMode) {
    this.data.screensaver = mode;
    this.save();
  }

  observe(context: AppContext): void {
    const np = context.nowPlaying;
    // Playing contexts arrive ~1/s; recency only needs minute precision.
    if (np && !np.paused && context.screen === "watch" && Date.now() - (this.data.usedAt[context.app] ?? 0) > 60_000) {
      this.data.usedAt[context.app] = Date.now();
      this.save();
    }
    if (context.app === "youtube" && context.recent.length > 0) {
      this.data.jump.youtube = context.recent.slice(0, 12).map((r) => ({
        app: "youtube", id: r.videoId, title: r.title, subtitle: r.channel,
        image: r.thumbnail || `https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`, progress: null,
      }));
    } else if (context.app === "prime" && context.continueWatching.length > 0) {
      this.data.jump.prime = context.continueWatching.filter((t) => t.entitled).slice(0, 12).map((t) => ({
        app: "prime", id: t.titleId, title: t.title, subtitle: t.meta, image: t.image, progress: t.progress,
      }));
    }
    const sig = JSON.stringify(this.jumpBack());
    if (sig === this.jumpSig) return;
    this.jumpSig = sig;
    this.save();
    this.onJumpChange();
  }

  // Most recently watched app leads; each app gets a few before the overflow.
  private jumpBack(): JumpItem[] {
    const lists = (["youtube", "prime"] as ResumeApp[])
      .sort((a, b) => (this.data.usedAt[b] ?? 0) - (this.data.usedAt[a] ?? 0))
      .map((a) => this.data.jump[a]);
    return [...lists.flatMap((l) => l.slice(0, 4)), ...lists.flatMap((l) => l.slice(4))].slice(0, 12);
  }

  feed(): HomeFeed {
    return { jumpBack: this.jumpBack() };
  }
}
