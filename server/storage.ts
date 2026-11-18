import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { GameLine } from "./stats/provider.ts";

// Where the server keeps what it downloads, so a restart does not start from
// scratch. Three backends behind one interface:
//
// - Postgres, when DATABASE_URL is set (on Heroku, whose disk is wiped on
//   every restart);
// - files in .cache/, otherwise (local development, as before);
// - memory only, for tests and mock mode.
//
// Two kinds of data:
// - cache entries: a key, when it was saved, and a JSON value (league
//   snapshots, the player list, schedules, logos);
// - box-score lines, one per player per game, grouped by dataset (a stats
//   source and season), so a sync writes only the games it downloaded.

export interface StoredEntry {
  savedAt: number;
  value: unknown;
}

/** A manager's word on whether a starter's current score is locked; see shared/matchup.ts. */
export interface StoredLockMark {
  leagueId: string;
  week: number;
  rosterId: number;
  playerId: string;
  locked: boolean;
  /** Sleeper's score when the mark was made; the mark applies only while the score is unchanged. */
  points: number;
  markedAt: number;
}

export interface Storage {
  readonly kind: "postgres" | "files" | "memory";
  /** Every lock mark for a league's week. */
  readLockMarks(leagueId: string, week: number): Promise<StoredLockMark[]>;
  writeLockMark(mark: StoredLockMark): Promise<void>;
  deleteLockMark(leagueId: string, week: number, rosterId: number, playerId: string): Promise<void>;
  readEntry(key: string): Promise<StoredEntry | null>;
  writeEntry(key: string, entry: StoredEntry): Promise<void>;
  /** Every saved line for a dataset, and when it was last brought up to date. */
  readLines(dataset: string): Promise<{ syncedAt: number | null; lines: GameLine[] }>;
  /** Adds or replaces the given lines and records the sync time. */
  writeLines(dataset: string, syncedAt: number, lines: GameLine[]): Promise<void>;
  close(): Promise<void>;
}

const markKey = (rosterId: number, playerId: string) => `${rosterId}:${playerId}`;

/** Keeps everything in memory: nothing survives a restart. */
export class MemoryStorage implements Storage {
  readonly kind = "memory";
  private entries = new Map<string, StoredEntry>();
  private marks = new Map<string, Map<string, StoredLockMark>>();

  async readLockMarks(leagueId: string, week: number) {
    return [...(this.marks.get(`${leagueId}:${week}`)?.values() ?? [])];
  }

  async writeLockMark(mark: StoredLockMark) {
    const key = `${mark.leagueId}:${mark.week}`;
    const week = this.marks.get(key) ?? new Map<string, StoredLockMark>();
    week.set(markKey(mark.rosterId, mark.playerId), mark);
    this.marks.set(key, week);
  }

  async deleteLockMark(leagueId: string, week: number, rosterId: number, playerId: string) {
    this.marks.get(`${leagueId}:${week}`)?.delete(markKey(rosterId, playerId));
  }
  private datasets = new Map<string, { syncedAt: number | null; lines: Map<string, GameLine> }>();

  async readEntry(key: string) {
    return this.entries.get(key) ?? null;
  }

  async writeEntry(key: string, entry: StoredEntry) {
    this.entries.set(key, entry);
  }

  async readLines(dataset: string) {
    const data = this.datasets.get(dataset);
    return { syncedAt: data?.syncedAt ?? null, lines: data ? [...data.lines.values()] : [] };
  }

  async writeLines(dataset: string, syncedAt: number, lines: GameLine[]) {
    const data = this.datasets.get(dataset) ?? { syncedAt: null, lines: new Map<string, GameLine>() };
    for (const line of lines) data.lines.set(line.key, line);
    data.syncedAt = syncedAt;
    this.datasets.set(dataset, data);
  }

  async close() {}
}

const safeName = (key: string) => key.replace(/[^a-zA-Z0-9_-]/g, "_");

/** JSON files in a folder: the layout the app has always used, so existing caches keep working. */
export class FileStorage implements Storage {
  readonly kind = "files";
  /** Lines already read, so a sync can add to them without reading the file again. */
  private loaded = new Map<string, Map<string, GameLine>>();

  constructor(private dir: string) {}

  private marksFile(leagueId: string, week: number) {
    return path.join(this.dir, `locks-${safeName(leagueId)}-week-${week}.json`);
  }

  async readLockMarks(leagueId: string, week: number): Promise<StoredLockMark[]> {
    try {
      const saved = JSON.parse(await readFile(this.marksFile(leagueId, week), "utf8")) as StoredLockMark[];
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  private async saveMarks(leagueId: string, week: number, marks: StoredLockMark[]) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.marksFile(leagueId, week), JSON.stringify(marks));
  }

  async writeLockMark(mark: StoredLockMark) {
    const marks = (await this.readLockMarks(mark.leagueId, mark.week)).filter(
      (other) => markKey(other.rosterId, other.playerId) !== markKey(mark.rosterId, mark.playerId),
    );
    await this.saveMarks(mark.leagueId, mark.week, [...marks, mark]);
  }

  async deleteLockMark(leagueId: string, week: number, rosterId: number, playerId: string) {
    const marks = await this.readLockMarks(leagueId, week);
    await this.saveMarks(
      leagueId,
      week,
      marks.filter((mark) => markKey(mark.rosterId, mark.playerId) !== markKey(rosterId, playerId)),
    );
  }

  async readEntry(key: string) {
    try {
      const entry = JSON.parse(await readFile(path.join(this.dir, `${safeName(key)}.json`), "utf8")) as StoredEntry;
      return typeof entry?.savedAt === "number" ? entry : null;
    } catch {
      return null; // Missing or unreadable: not stored.
    }
  }

  async writeEntry(key: string, entry: StoredEntry) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${safeName(key)}.json`), JSON.stringify(entry));
  }

  private linesFile(dataset: string) {
    return path.join(this.dir, `${safeName(dataset)}.json`);
  }

  async readLines(dataset: string) {
    try {
      const saved = JSON.parse(await readFile(this.linesFile(dataset), "utf8")) as {
        syncedAt?: number;
        lines?: GameLine[];
      };
      const lines = saved.lines ?? [];
      this.loaded.set(dataset, new Map(lines.map((line) => [line.key, line])));
      return { syncedAt: typeof saved.syncedAt === "number" ? saved.syncedAt : null, lines };
    } catch {
      this.loaded.set(dataset, new Map());
      return { syncedAt: null, lines: [] };
    }
  }

  async writeLines(dataset: string, syncedAt: number, lines: GameLine[]) {
    if (!this.loaded.has(dataset)) await this.readLines(dataset);
    const all = this.loaded.get(dataset)!;
    for (const line of lines) all.set(line.key, line);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.linesFile(dataset), JSON.stringify({ syncedAt, lines: [...all.values()] }));
  }

  async close() {}
}

/** Lines are written in batches of this many rows per statement. */
const BATCH = 500;

const SCHEMA = `
  create table if not exists cache_entries (
    key text primary key,
    saved_at bigint not null,
    value jsonb not null
  );
  create table if not exists stat_datasets (
    dataset text primary key,
    synced_at bigint
  );
  create table if not exists game_lines (
    dataset text not null,
    key text not null,
    data jsonb not null,
    primary key (dataset, key)
  );
  create table if not exists lock_marks (
    league_id text not null,
    week integer not null,
    roster_id integer not null,
    player_id text not null,
    locked boolean not null,
    points double precision not null,
    marked_at bigint not null,
    primary key (league_id, week, roster_id, player_id)
  );
`;

/** Postgres, through one small connection pool. Creates its tables on first use. */
export class PostgresStorage implements Storage {
  readonly kind = "postgres";
  private ready: Promise<void>;

  constructor(private pool: pg.Pool) {
    this.ready = pool.query(SCHEMA).then(() => undefined);
    // Callers see the failure when they wait on `ready`; this only stops
    // Node from treating it as unhandled before then.
    this.ready.catch((error: Error) => console.error("[storage] could not prepare the database:", error.message));
  }

  async readEntry(key: string) {
    await this.ready;
    const result = await this.pool.query<{ saved_at: string; value: unknown }>(
      "select saved_at, value from cache_entries where key = $1",
      [key],
    );
    const row = result.rows[0];
    return row ? { savedAt: Number(row.saved_at), value: row.value } : null;
  }

  async writeEntry(key: string, entry: StoredEntry) {
    await this.ready;
    await this.pool.query(
      `insert into cache_entries (key, saved_at, value) values ($1, $2, $3)
       on conflict (key) do update set saved_at = excluded.saved_at, value = excluded.value`,
      [key, entry.savedAt, JSON.stringify(entry.value)],
    );
  }

  async readLines(dataset: string) {
    await this.ready;
    const [synced, lines] = await Promise.all([
      this.pool.query<{ synced_at: string | null }>("select synced_at from stat_datasets where dataset = $1", [dataset]),
      this.pool.query<{ data: GameLine }>("select data from game_lines where dataset = $1", [dataset]),
    ]);
    const syncedAt = synced.rows[0]?.synced_at;
    return { syncedAt: syncedAt == null ? null : Number(syncedAt), lines: lines.rows.map((row) => row.data) };
  }

  async writeLines(dataset: string, syncedAt: number, lines: GameLine[]) {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (let start = 0; start < lines.length; start += BATCH) {
        const batch = lines.slice(start, start + BATCH);
        await client.query(
          `insert into game_lines (dataset, key, data)
           select $1, line->>'key', line from jsonb_array_elements($2::jsonb) as line
           on conflict (dataset, key) do update set data = excluded.data`,
          [dataset, JSON.stringify(batch)],
        );
      }
      await client.query(
        `insert into stat_datasets (dataset, synced_at) values ($1, $2)
         on conflict (dataset) do update set synced_at = excluded.synced_at`,
        [dataset, syncedAt],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async readLockMarks(leagueId: string, week: number): Promise<StoredLockMark[]> {
    await this.ready;
    const result = await this.pool.query<{
      roster_id: number;
      player_id: string;
      locked: boolean;
      points: number;
      marked_at: string;
    }>(
      "select roster_id, player_id, locked, points, marked_at from lock_marks where league_id = $1 and week = $2",
      [leagueId, week],
    );
    return result.rows.map((row) => ({
      leagueId,
      week,
      rosterId: row.roster_id,
      playerId: row.player_id,
      locked: row.locked,
      points: Number(row.points),
      markedAt: Number(row.marked_at),
    }));
  }

  async writeLockMark(mark: StoredLockMark) {
    await this.ready;
    await this.pool.query(
      `insert into lock_marks (league_id, week, roster_id, player_id, locked, points, marked_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (league_id, week, roster_id, player_id)
       do update set locked = excluded.locked, points = excluded.points, marked_at = excluded.marked_at`,
      [mark.leagueId, mark.week, mark.rosterId, mark.playerId, mark.locked, mark.points, mark.markedAt],
    );
  }

  async deleteLockMark(leagueId: string, week: number, rosterId: number, playerId: string) {
    await this.ready;
    await this.pool.query(
      "delete from lock_marks where league_id = $1 and week = $2 and roster_id = $3 and player_id = $4",
      [leagueId, week, rosterId, playerId],
    );
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Connects to Postgres. Heroku's databases require SSL with a certificate
 * the client cannot verify; a local database usually has no SSL at all.
 */
export function createPostgresStorage(url: string): PostgresStorage {
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) || !url.includes("@");
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local ? undefined : { rejectUnauthorized: false },
    // Essential-0 allows 20 connections; a handful is plenty for this app.
    max: 5,
  });
  pool.on("error", (error) => console.error("[storage] idle connection error:", error.message));
  return new PostgresStorage(pool);
}

/** Postgres when DATABASE_URL is set, otherwise files in .cache/. */
export function storageFromEnv(dir = ".cache"): Storage {
  const url = process.env.DATABASE_URL?.trim();
  return url ? createPostgresStorage(url) : new FileStorage(dir);
}
