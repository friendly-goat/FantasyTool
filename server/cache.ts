import type { Storage } from "./storage.ts";

// A small cache that keeps values in memory and in storage (files in .cache/
// locally, Postgres on Heroku), so restarting the server does not trigger a
// fresh round of API calls.
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
  /** True when a refresh failed and an older value is served instead. */
  stale: boolean;
  /** True when an older value is served while a refresh runs in the background. */
  refreshing?: boolean;
}

export interface CacheOptions {
  /** Where values are kept between restarts; null keeps them in memory only. */
  storage?: Storage | null;
  now?: () => number;
}

export class Cache {
  private memory = new Map<string, Entry<unknown>>();
  private inFlight = new Map<string, Promise<CacheResult<unknown>>>();
  private storage: Storage | null;
  private now: () => number;

  constructor(options: CacheOptions = {}) {
    this.storage = options.storage ?? null;
    this.now = options.now ?? Date.now;
  }

  /** Age of a cached value in milliseconds, or null if nothing is cached. */
  async age(key: string): Promise<number | null> {
    const entry = await this.read(key);
    return entry ? this.now() - entry.savedAt : null;
  }

  /** The saved value without loading anything, or null. */
  async peek<T>(key: string): Promise<{ value: T; savedAt: number } | null> {
    return (await this.read(key)) as Entry<T> | null;
  }

  /**
   * The value for a key: the saved one while younger than its TTL, otherwise
   * a fresh one from the loader. With `background`, an expired saved value is
   * returned right away while the loader runs behind it, so a request never
   * waits on the outside world once something is saved.
   */
  async get<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
    options: { force?: boolean; background?: boolean } = {},
  ): Promise<CacheResult<T>> {
    const existing = (await this.read(key)) as Entry<T> | null;
    if (existing && !options.force && this.now() - existing.savedAt < ttlMs) {
      return { value: existing.value, savedAt: existing.savedAt, stale: false };
    }

    const pending = this.inFlight.get(key) as Promise<CacheResult<T>> | undefined;
    if (existing && options.background && !options.force) {
      if (!pending) void this.refresh(key, loader, existing).catch(() => {});
      return { value: existing.value, savedAt: existing.savedAt, stale: false, refreshing: true };
    }
    if (pending) return pending;
    return this.refresh(key, loader, existing);
  }

  private refresh<T>(key: string, loader: () => Promise<T>, existing: Entry<T> | null): Promise<CacheResult<T>> {
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

  private async read(key: string): Promise<Entry<unknown> | null> {
    const inMemory = this.memory.get(key);
    if (inMemory) return inMemory;
    if (!this.storage) return null;
    try {
      const entry = (await this.storage.readEntry(key)) as Entry<unknown> | null;
      if (!entry) return null;
      this.memory.set(key, entry);
      return entry;
    } catch (error) {
      console.warn(`[cache] could not read ${key}`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  private async write(key: string, entry: Entry<unknown>): Promise<void> {
    this.memory.set(key, entry);
    if (!this.storage) return;
    try {
      await this.storage.writeEntry(key, entry);
    } catch (error) {
      console.warn(`[cache] could not save ${key}`, error instanceof Error ? error.message : error);
    }
  }
}
