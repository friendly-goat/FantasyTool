import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LeagueSnapshot, PlayerDetail, PlayerRef, StatsReport } from "../../shared/types.ts";
import { ignoredSettings } from "../scoring.ts";
import { matchPlayers } from "./match.ts";
import { PLAYER_ID_OVERRIDES } from "./overrides.ts";
import type { GameLine, StatsProvider } from "./provider.ts";
import { counts, playerLog, RECENT_WINDOW, summarize } from "./summary.ts";

// Keeps a season of game lines on disk and brings it up to date in the
// background. The first sync downloads the whole season so far; later
// syncs only re-download the last few days.

/** Days re-downloaded on each sync, to pick up late stat corrections. */
const OVERLAP_DAYS = 2;
/** After a failed download, wait this long before trying again unprompted. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

interface SeasonData {
  syncedAt: number | null;
  lines: Map<string, GameLine>;
  syncing: boolean;
  pagesFetched: number;
  error: string | null;
  failedAt: number;
  inFlight: Promise<void> | null;
}

export interface StatsServiceOptions {
  dir?: string | null;
  staleMs?: number;
  now?: () => number;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export class StatsService {
  private seasons = new Map<string, SeasonData>();
  private dir: string | null;
  private staleMs: number;
  private now: () => number;

  constructor(
    private provider: StatsProvider | null,
    options: StatsServiceOptions = {},
  ) {
    this.dir = options.dir === undefined ? ".cache" : options.dir;
    this.staleMs = options.staleMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Builds the stats report for one league. Never waits for a download. */
  async report(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
  ): Promise<StatsReport> {
    const scoring = snapshot.league.scoringSettings;
    const base = {
      recentWindow: RECENT_WINDOW,
      ignoredScoring: ignoredSettings(scoring),
    };
    if (!this.provider) {
      return {
        ...base,
        status: "unconfigured",
        message: null,
        source: null,
        syncedAt: null,
        pagesFetched: 0,
        unmatchedRostered: [],
        players: {},
      };
    }

    const season = snapshot.league.season;
    const data = await this.load(season);
    const isStale = data.syncedAt === null || this.now() - data.syncedAt >= this.staleMs;
    const coolingOff = data.error !== null && this.now() - data.failedAt < RETRY_AFTER_MS;
    if (isStale && !data.syncing && !coolingOff) void this.start(season, data);

    const lines = [...data.lines.values()];
    const matches = matchPlayers(sleeperPlayers, lines, PLAYER_ID_OVERRIDES);
    const rostered = snapshot.teams.flatMap((team) => [
      ...team.starters.flatMap((starter) => (starter.player ? [starter.player] : [])),
      ...team.bench,
      ...team.reserve,
    ]);

    return {
      ...base,
      status: data.syncing ? "syncing" : data.error ? "error" : "ready",
      message: data.error,
      source: this.provider.name,
      syncedAt: data.syncedAt ? new Date(data.syncedAt).toISOString() : null,
      pagesFetched: data.pagesFetched,
      unmatchedRostered: lines.length > 0 ? rostered.filter((player) => !matches.has(player.id)) : [],
      players: summarize(lines, matches, sleeperPlayers, scoring, snapshot.league.seasonStartDate),
    };
  }

  /** One player's season numbers and game log, from the data already downloaded. */
  async playerDetail(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
    playerId: string,
  ): Promise<PlayerDetail | null> {
    const player = sleeperPlayers[playerId];
    if (!player) return null;
    if (!this.provider) return { player, stats: null, games: [] };

    const lines = [...(await this.load(snapshot.league.season)).lines.values()];
    const matches = matchPlayers(sleeperPlayers, lines, PLAYER_ID_OVERRIDES);
    return {
      player,
      ...playerLog(
        player,
        matches.get(playerId),
        lines,
        snapshot.league.scoringSettings,
        snapshot.league.seasonStartDate,
      ),
    };
  }

  /** What is stored for a season, for the check script. */
  async overview(season: string, seasonStart: string | null) {
    const lines = [...(await this.load(season)).lines.values()];
    const dates = lines.map((line) => line.date).sort();
    return {
      lines: lines.length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      beforeSeasonStart: seasonStart ? lines.filter((line) => line.date < seasonStart).length : 0,
      counted: lines.filter((line) => counts(line, seasonStart)).length,
    };
  }

  /**
   * Downloads new game lines, or waits for a download already running.
   * Resolves when done; errors are recorded on the season, not thrown.
   */
  async sync(season: string): Promise<void> {
    if (!this.provider) return;
    await this.start(season, await this.load(season));
  }

  /** Marks the season as syncing right away, then downloads in the background. */
  private start(season: string, data: SeasonData): Promise<void> {
    if (data.inFlight) return data.inFlight;
    data.syncing = true;
    data.pagesFetched = 0;
    data.error = null;
    data.inFlight = this.download(season, data).finally(() => {
      data.syncing = false;
      data.inFlight = null;
    });
    return data.inFlight;
  }

  private async download(season: string, data: SeasonData): Promise<void> {
    try {
      let latest: string | null = null;
      for (const line of data.lines.values()) {
        if (latest === null || line.date > latest) latest = line.date;
      }
      const fromDate = latest ? daysBefore(latest, OVERLAP_DAYS) : null;
      const fresh = await this.provider!.fetchGameLines(season, fromDate, (pages) => {
        data.pagesFetched = pages;
      });
      for (const line of fresh) data.lines.set(line.key, line);
      data.syncedAt = this.now();
      await this.save(season, data);
    } catch (error) {
      data.error = error instanceof Error ? error.message : "The stats download failed.";
      data.failedAt = this.now();
      console.error("[stats]", data.error);
    }
  }

  /** Forgets a failed download so the next report tries again right away. */
  retry(season: string): void {
    const data = this.seasons.get(season);
    if (data) data.failedAt = 0;
  }

  private file(season: string): string | null {
    if (!this.dir || !this.provider) return null;
    // "v2": lines now carry opponent details, so older files are not reused.
    return path.join(this.dir, `stats-v2-${this.provider.name}-${season.replace(/\W/g, "_")}.json`);
  }

  private async load(season: string): Promise<SeasonData> {
    const existing = this.seasons.get(season);
    if (existing) return existing;
    const data: SeasonData = {
      syncedAt: null,
      lines: new Map(),
      syncing: false,
      pagesFetched: 0,
      error: null,
      failedAt: 0,
      inFlight: null,
    };
    const file = this.file(season);
    if (file) {
      try {
        const saved = JSON.parse(await readFile(file, "utf8")) as {
          syncedAt?: number;
          lines?: GameLine[];
        };
        for (const line of saved.lines ?? []) data.lines.set(line.key, line);
        data.syncedAt = typeof saved.syncedAt === "number" ? saved.syncedAt : null;
      } catch {
        // No saved stats yet.
      }
    }
    this.seasons.set(season, data);
    return data;
  }

  private async save(season: string, data: SeasonData): Promise<void> {
    const file = this.file(season);
    if (!file) return;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ syncedAt: data.syncedAt, lines: [...data.lines.values()] }));
    } catch (error) {
      console.warn(`[stats] could not write ${file}`, error);
    }
  }
}
