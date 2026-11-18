import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Cache } from "./cache.ts";
import type { GameLine } from "./stats/provider.ts";
import { createPostgresStorage, FileStorage, MemoryStorage, type Storage } from "./storage.ts";

// The same checks run against every backend. Postgres is tested when
// TEST_DATABASE_URL points at a database that may be written to, e.g.
//   TEST_DATABASE_URL=postgres://localhost/fantasytool_test npm test

const line = (key: string, pts: number, date = "2026-11-16"): GameLine => ({
  key,
  playerId: key.split(":")[1] ?? key,
  playerName: "Test Player",
  team: "CLE",
  date,
  final: true,
  minutes: 30,
  stats: { pts, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0 },
});

const backends: { name: string; make: () => Promise<Storage> }[] = [
  { name: "memory", make: async () => new MemoryStorage() },
  {
    name: "files",
    make: async () => new FileStorage(await mkdtemp(path.join(tmpdir(), "fantasytool-"))),
  },
];
const testUrl = process.env.TEST_DATABASE_URL?.trim();
if (testUrl) {
  backends.push({
    name: "postgres",
    make: async () => {
      const storage = createPostgresStorage(testUrl);
      // Start from empty tables each time.
      const pool = (storage as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool;
      await storage.readEntry("warm-up");
      await pool.query("truncate cache_entries, stat_datasets, game_lines");
      return storage;
    },
  });
}

const opened: Storage[] = [];
afterAll(async () => {
  for (const storage of opened) await storage.close();
});

for (const backend of backends) {
  describe(`storage: ${backend.name}`, () => {
    const make = async () => {
      const storage = await backend.make();
      opened.push(storage);
      return storage;
    };

    it("saves and reads cache entries, replacing on a second write", async () => {
      const storage = await make();
      expect(await storage.readEntry("league-1")).toBeNull();
      await storage.writeEntry("league-1", { savedAt: 100, value: { name: "Test", teams: [1, 2] } });
      expect(await storage.readEntry("league-1")).toEqual({ savedAt: 100, value: { name: "Test", teams: [1, 2] } });
      await storage.writeEntry("league-1", { savedAt: 200, value: "newer" });
      expect(await storage.readEntry("league-1")).toEqual({ savedAt: 200, value: "newer" });
    });

    it("adds box-score lines a sync at a time, replacing corrected ones", async () => {
      const storage = await make();
      expect(await storage.readLines("stats-test-2026")).toEqual({ syncedAt: null, lines: [] });
      await storage.writeLines("stats-test-2026", 1000, [line("g1:p1", 20), line("g1:p2", 15)]);
      await storage.writeLines("stats-test-2026", 2000, [line("g1:p2", 17), line("g2:p1", 30, "2026-11-18")]);
      const saved = await storage.readLines("stats-test-2026");
      expect(saved.syncedAt).toBe(2000);
      const points = Object.fromEntries(saved.lines.map((entry) => [entry.key, entry.stats.pts]));
      expect(points).toEqual({ "g1:p1": 20, "g1:p2": 17, "g2:p1": 30 });
      // Datasets stay apart.
      expect((await storage.readLines("stats-test-2025")).lines).toEqual([]);
    });

    it("writes many lines at once", async () => {
      const storage = await make();
      const many = Array.from({ length: 1234 }, (_, index) => line(`g${index}:p1`, index));
      await storage.writeLines("stats-big", 1, many);
      expect((await storage.readLines("stats-big")).lines).toHaveLength(1234);
    });

    it("backs the cache across restarts", async () => {
      const storage = await make();
      let calls = 0;
      const load = async () => ++calls;
      await new Cache({ storage }).get("k", 60_000, load);
      // A new cache (as after a restart) finds the saved value instead of loading again.
      expect((await new Cache({ storage }).get("k", 60_000, load)).value).toBe(1);
      expect(calls).toBe(1);
    });
  });
}

describe("files storage", () => {
  it("reads caches saved by earlier versions of the app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fantasytool-"));
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(dir, "players-nba.json"), JSON.stringify({ savedAt: 5, value: { a: 1 } }));
      expect(await new FileStorage(dir).readEntry("players-nba")).toEqual({ savedAt: 5, value: { a: 1 } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
