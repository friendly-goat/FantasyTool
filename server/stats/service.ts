import type { LeagueSnapshot, NbaGame, PlayerDetail, PlayerRef, StatsReport, WeekLine } from "../../shared/types.ts";
import { fantasyPoints, ignoredSettings } from "../scoring.ts";
import type { Storage } from "../storage.ts";
import { matchPlayers, sameLastName } from "./match.ts";
import { PLAYER_ID_OVERRIDES } from "./overrides.ts";
import { type InjuryNews, readInjury } from "../../shared/injury.ts";
import type { GameLine, InjuryReport, StatsProvider } from "./provider.ts";

/** The injury report keyed by stats-source player ID, each entry read (dates, re-evaluations). */
function injuriesBySource(report: InjuryReport[], today: string): Map<string, InjuryNews> {
  return new Map(report.map((entry) => [entry.playerId, readInjury(entry, today)]));
}
import { counts, lastSeasonLevels, playerLog, RECENT_WINDOW, summarize, type LastSeason } from "./summary.ts";

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
  /** Where downloaded box scores are kept; null keeps them in memory only. */
  storage?: Storage | null;
  staleMs?: number;
  now?: () => number;
}

function previousSeason(season: string): string {
  return String(Number(season) - 1);
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export class StatsService {
  private seasons = new Map<string, SeasonData>();
  private storage: Storage | null;
  private staleMs: number;
  private now: () => number;

  constructor(
    private provider: StatsProvider | null,
    options: StatsServiceOptions = {},
  ) {
    this.storage = options.storage ?? null;
    this.staleMs = options.staleMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Builds the stats report for one league. Never waits for a download. */
  async report(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
    injuryReport: InjuryReport[] = [],
  ): Promise<StatsReport> {
    const scoring = snapshot.league.scoringSettings;
    const base = {
      recentWindow: RECENT_WINDOW,
      ignoredScoring: ignoredSettings(scoring),
    };
    if (!this.provider) {
      return {
        ...base,
        lastSeason: "off",
        lastSeasonPages: 0,
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

    // Last season is fetched once this season's stats are in. It never changes,
    // so it is never fetched again.
    const prior = await this.load(previousSeason(season));
    const priorCoolingOff = prior.error !== null && this.now() - prior.failedAt < RETRY_AFTER_MS;
    if (data.syncedAt !== null && !data.syncing && prior.syncedAt === null && !prior.syncing && !priorCoolingOff) {
      void this.start(previousSeason(season), prior);
    }

    const lines = [...data.lines.values()];
    const { matches, lastSeason } = this.context(sleeperPlayers, lines, prior, scoring);
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
      lastSeason: prior.syncedAt !== null ? "ready" : "loading",
      lastSeasonPages: prior.pagesFetched,
      players: summarize(
        lines,
        matches,
        sleeperPlayers,
        scoring,
        snapshot.league.seasonStartDate,
        lastSeason,
        injuriesBySource(injuryReport, new Date(this.now()).toISOString().slice(0, 10)),
      ),
    };
  }

  /** Player matching and last season's levels, shared by the report and the player details. */
  private context(
    sleeperPlayers: Record<string, PlayerRef>,
    lines: GameLine[],
    prior: SeasonData,
    scoring: Record<string, number>,
  ): { matches: Map<string, string>; lastSeason: LastSeason } {
    const ready = prior.syncedAt !== null;
    const priorLines = ready ? [...prior.lines.values()] : [];
    return {
      // Matching looks at both seasons, so a player with few games this year is still found.
      matches: matchPlayers(sleeperPlayers, [...priorLines, ...lines], PLAYER_ID_OVERRIDES),
      lastSeason: ready ? lastSeasonLevels(priorLines, scoring) : new Map(),
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

    const season = snapshot.league.season;
    const lines = [...(await this.load(season)).lines.values()];
    const scoring = snapshot.league.scoringSettings;
    const prior = await this.load(previousSeason(season));
    const { matches, lastSeason } = this.context(sleeperPlayers, lines, prior, scoring);
    return {
      player,
      ...playerLog(player, matches.get(playerId), lines, scoring, snapshot.league.seasonStartDate, lastSeason),
    };
  }

  /** Whether the stats source can supply the NBA schedule. */
  hasSchedule(): boolean {
    return typeof this.provider?.fetchSchedule === "function";
  }

  /** NBA games from `start` to `end`, inclusive. Throws when the source cannot be reached. */
  async schedule(start: string, end: string): Promise<NbaGame[]> {
    if (!this.provider?.fetchSchedule) return [];
    return this.provider.fetchSchedule(start, end);
  }

  /**
   * Each rostered player's games from `start` to `end`, scored with the
   * league's settings. During a week the box scores are kept fresher than
   * usual: if they are older than `freshMs`, a background update starts.
   */
  async weekLines(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
    start: string,
    end: string,
    freshMs: number,
    /** Sleeper IDs to include besides today's rosters, such as a past week's starters since dropped. */
    alsoPlayerIds: string[] = [],
  ): Promise<{ lines: Record<string, WeekLine[]>; syncedAt: string | null }> {
    if (!this.provider) return { lines: {}, syncedAt: null };
    const season = snapshot.league.season;
    const data = await this.load(season);
    const old = data.syncedAt === null || this.now() - data.syncedAt >= freshMs;
    const coolingOff = data.error !== null && this.now() - data.failedAt < RETRY_AFTER_MS;
    if (old && !data.syncing && !coolingOff) void this.start(season, data);

    const lines = [...data.lines.values()];
    const prior = await this.load(previousSeason(season));
    const { matches } = this.context(sleeperPlayers, lines, prior, snapshot.league.scoringSettings);
    const wanted = new Map<string, string>();
    for (const team of snapshot.teams) {
      for (const player of [...team.starters.flatMap((s) => (s.player ? [s.player] : [])), ...team.bench, ...team.reserve]) {
        const sourceId = matches.get(player.id);
        if (sourceId) wanted.set(sourceId, player.id);
      }
    }
    for (const id of alsoPlayerIds) {
      const sourceId = matches.get(id);
      if (sourceId) wanted.set(sourceId, id);
    }
    const result: Record<string, WeekLine[]> = {};
    for (const line of lines) {
      const sleeperId = wanted.get(line.playerId);
      if (!sleeperId || line.date < start || line.date > end) continue;
      (result[sleeperId] ??= []).push({
        date: line.date,
        points: fantasyPoints(line.stats, snapshot.league.scoringSettings),
        minutes: line.minutes,
        final: line.final,
        opponent: line.opponent ?? null,
        home: line.home ?? null,
        team: line.team ?? null,
        stats: line.stats,
      });
    }
    for (const list of Object.values(result)) list.sort((a, b) => a.date.localeCompare(b.date));
    return { lines: result, syncedAt: data.syncedAt ? new Date(data.syncedAt).toISOString() : null };
  }

  /** Whether the stats source has an injury report. */
  hasInjuries(): boolean {
    return Boolean(this.provider?.fetchInjuries);
  }

  /** The league's injury report now, straight from the source (callers cache it). */
  async injuries(): Promise<InjuryReport[]> {
    return this.provider?.fetchInjuries ? this.provider.fetchInjuries() : [];
  }

  /** Stats-source players sharing a last name with `name`, for the check script. */
  async similarPlayers(season: string, name: string) {
    return sameLastName(name, [...(await this.load(season)).lines.values()]);
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
      await this.save(season, data.syncedAt, fresh);
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

  /** The stored dataset for a season; "v2": lines carry opponent details, so older ones are not reused. */
  private dataset(season: string): string | null {
    if (!this.storage || !this.provider) return null;
    return `stats-v2-${this.provider.name}-${season.replace(/\W/g, "_")}`;
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
    // Registered before reading, so two requests at once share one read.
    this.seasons.set(season, data);
    const dataset = this.dataset(season);
    if (dataset) {
      try {
        const saved = await this.storage!.readLines(dataset);
        for (const line of saved.lines) data.lines.set(line.key, line);
        data.syncedAt = saved.syncedAt;
      } catch (error) {
        console.warn(`[stats] could not read saved stats for ${season}`, error instanceof Error ? error.message : error);
      }
    }
    return data;
  }

  /** Saves the lines a sync downloaded (new or corrected), not the whole season again. */
  private async save(season: string, syncedAt: number, lines: GameLine[]): Promise<void> {
    const dataset = this.dataset(season);
    if (!dataset) return;
    try {
      await this.storage!.writeLines(dataset, syncedAt, lines);
    } catch (error) {
      console.warn(`[stats] could not save stats for ${season}`, error instanceof Error ? error.message : error);
    }
  }
}
