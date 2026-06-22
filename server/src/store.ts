import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tiny JSON-file store under the app data dir. Used to persist autopilot config
 * and action history across restarts. Synchronous and simple on purpose — the
 * payloads are tiny and writes are infrequent.
 */
export class JsonStore<T> {
  private readonly file: string;

  constructor(dataDir: string, name: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, name);
  }

  read(fallback: T): T {
    try {
      if (!existsSync(this.file)) return fallback;
      return JSON.parse(readFileSync(this.file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  write(value: T): void {
    try {
      writeFileSync(this.file, JSON.stringify(value, null, 2));
    } catch (err) {
      console.error("[store] failed to persist", this.file, err);
    }
  }
}
