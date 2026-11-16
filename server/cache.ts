import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// A small cache that keeps values in memory and on disk (.cache/*.json),
// so restarting the server does not trigger a fresh round of API calls.
//
// Rules:
// - A value younger than its TTL is returned without calling the loader.
// - Concurrent requests for the same key share one loader call.
// - If the loader fails and an older value exists, the older value is
//   returned and flagged as stale instead of surfacing the error.

interface Entry<T> {
  savedAt: number;
  value: T;
}

export interface CacheResult<T> {
  value: T;
  savedAt: number;
  stale: boolean;
}

export interface CacheOptions {
  dir?: string | null;
  now?: () => number;
}

export class Cache {
  private memory = new Map<string, Entry<unknown>>();
  private inFlight = new Map<string, Promise<CacheResult<unknown>>>();
  private dir: string | null;
  private now: () => number;

  constructor(options: CacheOptions = {}) {
    this.dir = options.dir === undefined ? ".cache" : options.dir;
    this.now = options.now ?? Date.now;
  }

  /** Age of a cached value in milliseconds, or null if nothing is cached. */
  async age(key: string): Promise<number | null> {
    const entry = await this.read(key);
    return entry ? this.now() - entry.savedAt : null;
  }

  async get<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { force?: boolean } = {},
  ): Promise<CacheResult<T>> {
    const existing = (await this.read(key)) as Entry<T> | null;
    if (existing && !options.force && this.now() - existing.savedAt < ttlMs) {
      return { value: existing.value, savedAt: existing.savedAt, stale: false };
    }

    const pending = this.inFlight.get(key) as Promise<CacheResult<T>> | undefined;
    if (pending) return pending;

    const run = (async (): Promise<CacheResult<T>> => {
      try {
        const value = await loader();
        const entry: Entry<T> = { savedAt: this.now(), value };
        await this.write(key, entry);
        return { value, savedAt: entry.savedAt, stale: false };
      } catch (error) {
        if (existing) {
          console.warn(`[cache] ${key}: refresh failed, serving older data.`, error);
          return { value: existing.value, savedAt: existing.savedAt, stale: true };
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, run);
    return run;
  }

  private file(key: string): string | null {
    if (!this.dir) return null;
    return path.join(this.dir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  private async read(key: string): Promise<Entry<unknown> | null> {
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;
    const file = this.file(key);
    if (!file) return null;
    try {
      const entry = JSON.parse(await readFile(file, "utf8")) as Entry<unknown>;
      if (typeof entry?.savedAt !== "number") return null;
      this.memory.set(key, entry);
      return entry;
    } catch {
      return null; // Missing or unreadable file: treat as not cached.
    }
  }

  private async write(key: string, entry: Entry<unknown>): Promise<void> {
    this.memory.set(key, entry);
    const file = this.file(key);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(entry));
    } catch (error) {
      console.warn(`[cache] could not write ${file}`, error);
    }
  }
}
