import { createHash } from "node:crypto";
import type { LeagueSnapshot, NbaGame, PlayerDetail, PlayerRef, PlayerStats, StatLine, StatsReport, WeekLine } from "../../shared/types.ts";
import { fantasyPoints, ignoredSettings } from "../scoring.ts";
import type { Storage } from "../storage.ts";
import { matchPlayers, sameLastName } from "./match.ts";
import { PLAYER_ID_OVERRIDES } from "./overrides.ts";
import { type InjuryNews, readInjury } from "../../shared/injury.ts";
import type { GameLine, InjuryReport, ScheduledGame, StatsProvider } from "./provider.ts";

/** The injury report keyed by stats-source player ID, each entry read (dates, re-evaluations). */
function injuriesBySource(report: InjuryReport[], today: string): Map<string, InjuryNews> {
  return new Map(report.map((entry) => [entry.playerId, readInjury(entry, today)]));
}
import { counts, lastSeasonLevels, playerLog, pointsAllowed, RECENT_WINDOW, regularSeasonLines, summarize, type LastSeason } from "./summary.ts";

// Keeps a season of game lines on disk and brings it up to date in the
// background. The first sync downloads the whole season so far; later
// syncs only re-download the last few days.

/** Days re-downloaded on each sync, to pick up late stat corrections. */
const OVERLAP_DAYS = 2;
/** After a failed download, wait this long before trying again unprompted. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

interface SeasonData {
  syncedAt: number | null;
  /** When the days with games being played were last brought up to date (see keepLiveFresh). */
  liveSyncedAt: number | null;
  liveInFlight: Promise<void> | null;
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

/** The most seasons a player card offers, however long the career. */
export const MAX_CAREER_SEASONS = 25;
/** Older player seasons kept in memory once read. */
const PAST_SEASONS_KEPT = 60;

/**
 * The seasons a player can be viewed in, newest first. With Sleeper's years of experience: this
 * season back to his first (a rookie has this season only). Older seasons than last season need
 * a stats source that fetches one player's season; without one, or without his experience, the
 * list is this season, plus last season when he played in it.
 */
export function careerSeasons(
  current: string,
  yearsExp: number | undefined,
  canFetchOlder: boolean,
  playedLastSeason: () => boolean,
): string[] {
  const year = Number(current);
  const back =
    yearsExp === undefined
      ? playedLastSeason() ? 1 : 0
      : Math.min(Math.max(0, Math.floor(yearsExp)), canFetchOlder ? MAX_CAREER_SEASONS - 1 : 1);
  return Array.from({ length: back + 1 }, (_, index) => String(year - index));
}

const NO_STATS: StatLine = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0 };

/**
 * A game-less line for each of a team's finished games, so a past season's log can tell which of
 * his team's games a player missed (they count for nothing: no minutes, no player).
 */
export function teamLines(team: string, games: ScheduledGame[]): GameLine[] {
  const lines: GameLine[] = [];
  for (const game of games) {
    if (game.state !== "final" || (game.home !== team && game.away !== team)) continue;
    const home = game.home === team;
    lines.push({
      key: `team:${team}:${game.id}`,
      playerId: `team:${team}`,
      playerName: team,
      team,
      opponent: home ? game.away : game.home,
      home,
      date: game.date,
      final: true,
      minutes: 0,
      stats: NO_STATS,
    });
  }
  return lines;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

/** The report's heavy part, worked out once per set of inputs (see report). */
interface Worked {
  inputs: unknown[];
  players: Record<string, PlayerStats>;
  allowed: Record<string, number>;
  unmatchedRostered: PlayerRef[];
  version: string;
}

export class StatsService {
  private seasons = new Map<string, SeasonData>();
  private worked = new Map<string, Worked>();
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

    const worked = this.work(snapshot, sleeperPlayers, injuryReport, data, prior);
    return {
      ...base,
      // A routine update runs behind data already in hand, so the page keeps "ready" and the
      // numbers it has; "syncing" and "error" are for when there is nothing to show yet.
      status: data.syncedAt !== null ? "ready" : data.syncing ? "syncing" : data.error ? "error" : "ready",
      message: data.syncedAt !== null ? null : data.error,
      source: this.provider.name,
      syncedAt: data.syncedAt ? new Date(data.syncedAt).toISOString() : null,
      pagesFetched: data.pagesFetched,
      unmatchedRostered: worked.unmatchedRostered,
      lastSeason: prior.syncedAt !== null ? "ready" : "loading",
      lastSeasonPages: prior.pagesFetched,
      players: worked.players,
      allowed: worked.allowed,
      version: worked.version,
    };
  }

  /**
   * The players' numbers, matched and summarized. That takes a moment over a season of box
   * scores, so it is kept and worked out again only when an input changes: the box scores
   * (each sync), last season's, the injury report, Sleeper's player list, the league's scoring,
   * season start or rosters, or the day (injury return dates count from today).
   */
  private work(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
    injuryReport: InjuryReport[],
    data: SeasonData,
    prior: SeasonData,
  ): Worked {
    const scoring = snapshot.league.scoringSettings;
    const rostered = snapshot.teams.flatMap((team) => [
      ...team.starters.flatMap((starter) => (starter.player ? [starter.player] : [])),
      ...team.bench,
      ...team.reserve,
    ]);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const inputs: unknown[] = [
      data.syncedAt,
      data.lines.size,
      prior.syncedAt,
      prior.lines.size,
      sleeperPlayers,
      // The same saved report is the same object; an empty one is a new [] each time.
      injuryReport.length === 0 ? "no injuries" : injuryReport,
      JSON.stringify(scoring),
      snapshot.league.seasonStartDate,
      rostered.map((player) => player.id).join(","),
      today,
    ];
    const key = snapshot.league.id;
    const kept = this.worked.get(key);
    if (kept && kept.inputs.length === inputs.length && kept.inputs.every((value, index) => value === inputs[index])) return kept;

    const lines = [...data.lines.values()];
    const { matches, lastSeason } = this.context(sleeperPlayers, lines, prior, scoring);
    const players = summarize(
      lines,
      matches,
      sleeperPlayers,
      scoring,
      snapshot.league.seasonStartDate,
      lastSeason,
      injuriesBySource(injuryReport, today),
    );
    const allowed = pointsAllowed(lines, scoring, snapshot.league.seasonStartDate);
    const version = createHash("sha1").update(JSON.stringify(players)).update(JSON.stringify(allowed)).digest("hex").slice(0, 16);
    const worked: Worked = {
      inputs,
      players,
      allowed,
      unmatchedRostered: lines.length > 0 ? rostered.filter((player) => !matches.has(player.id)) : [],
      version,
    };
    this.worked.set(key, worked);
    return worked;
  }

  /**
   * While games are being played: brings just the given days' box scores up to date (a request or
   * two, the source updates in-progress games as they go) when older than `freshMs`. The full
   * sync of the last few days still runs on its own time. Only finished games are saved; lines
   * from games still being played live in memory until they are final.
   */
  async keepLiveFresh(season: string, dates: string[], freshMs: number): Promise<void> {
    if (!this.provider || dates.length === 0) return;
    const data = await this.load(season);
    if (data.liveInFlight) return data.liveInFlight;
    const last = Math.max(data.liveSyncedAt ?? 0, data.syncedAt ?? 0);
    if (this.now() - last < freshMs) return;
    const fromDate = dates[0]!;
    data.liveInFlight = (async () => {
      try {
        const fresh = await this.provider!.fetchGameLines(season, fromDate, () => {});
        for (const line of fresh) data.lines.set(line.key, line);
        data.liveSyncedAt = this.now();
        const finished = fresh.filter((line) => line.final);
        if (finished.length > 0) await this.save(season, data.syncedAt ?? data.liveSyncedAt, finished);
      } catch (error) {
        console.error("[stats] live box scores:", error instanceof Error ? error.message : error);
      } finally {
        data.liveInFlight = null;
      }
    })();
    return data.liveInFlight;
  }

  /** Whether box scores are older than `freshMs`; if so (and none is running), a download starts. */
  async keepFresh(season: string, freshMs: number): Promise<void> {
    if (!this.provider) return;
    const data = await this.load(season);
    const old = data.syncedAt === null || this.now() - data.syncedAt >= freshMs;
    const coolingOff = data.error !== null && this.now() - data.failedAt < RETRY_AFTER_MS;
    if (old && !data.syncing && !coolingOff) void this.start(season, data);
  }

  /** Player matching and last season's levels, shared by the report and the player details. */
  private context(
    sleeperPlayers: Record<string, PlayerRef>,
    lines: GameLine[],
    prior: SeasonData,
    scoring: Record<string, number>,
  ): { matches: Map<string, string>; lastSeason: LastSeason } {
    // Matching a season of box scores to Sleeper's players takes a moment: kept while the inputs stand.
    const inputs: unknown[] = [sleeperPlayers, lines.length, lines.at(-1)?.key, prior.syncedAt, prior.lines.size, JSON.stringify(scoring)];
    const kept = this.contextKept;
    if (kept && kept.inputs.every((value, index) => value === inputs[index])) return kept.value;
    const value = this.workContext(sleeperPlayers, lines, prior, scoring);
    this.contextKept = { inputs, value };
    return value;
  }

  private contextKept: { inputs: unknown[]; value: { matches: Map<string, string>; lastSeason: LastSeason } } | null = null;

  private workContext(
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

  /**
   * One player's season numbers and game log. The current season and the one before come from
   * the box scores already saved; an older season is fetched for him alone the first time it is
   * asked for and kept for good (see pastSeason). `seasons` lists the seasons he can be viewed
   * in, newest first.
   */
  async playerDetail(
    snapshot: LeagueSnapshot,
    sleeperPlayers: Record<string, PlayerRef>,
    playerId: string,
    /** "current", "previous", or a season's starting year such as "2015". */
    wanted: string = "current",
  ): Promise<PlayerDetail | null> {
    const sleeperPlayer = sleeperPlayers[playerId];
    if (!sleeperPlayer) return null;
    const { yearsExp, ...player } = sleeperPlayer;
    const current = snapshot.league.season;
    const previous = previousSeason(current);
    const season = wanted === "current" ? current : wanted === "previous" ? previous : wanted;
    if (!this.provider) return { player, season, seasons: [current], stats: null, games: [], missed: [] };

    const lines = [...(await this.load(current)).lines.values()];
    const scoring = snapshot.league.scoringSettings;
    const prior = await this.load(previous);
    const { matches, lastSeason } = this.context(sleeperPlayers, lines, prior, scoring);
    const sourceId = matches.get(playerId);
    const seasons = careerSeasons(current, yearsExp, this.canFetchPastSeasons(), () =>
      sourceId !== undefined && this.priorRegular(prior).some((line) => line.playerId === sourceId && line.minutes > 0),
    );
    const empty = { player, season, seasons, stats: null, games: [], missed: [] };
    // Only a season in his list is ever looked up, so a made-up year never reaches the stats source.
    if (!seasons.includes(season)) return empty;
    if (season === current) {
      return { player, season, seasons, ...playerLog(player, sourceId, lines, scoring, snapshot.league.seasonStartDate, lastSeason) };
    }
    if (season === previous) {
      return { player, season, seasons, ...playerLog(player, sourceId, this.priorRegular(prior), scoring, null) };
    }
    if (!sourceId) return empty;
    return { player, season, seasons, ...playerLog(player, sourceId, await this.pastSeason(sourceId, season), scoring, null) };
  }

  /** Whether the stats source can fetch one player's older seasons. */
  private canFetchPastSeasons(): boolean {
    return typeof this.provider?.fetchPlayerSeason === "function" && typeof this.provider?.fetchTeamSeason === "function";
  }

  /**
   * One player's regular season from before last season, with a game-less line for each of his
   * teams' games (so the games he missed show). Read from storage when it has been fetched before;
   * otherwise fetched once (his box scores, then each of his teams' schedules) and stored for good,
   * since a finished season does not change. An empty season is stored too.
   */
  private async pastSeason(sourceId: string, season: string): Promise<GameLine[]> {
    const key = `player-season-v1-${sourceId}-${season}`;
    const kept = this.pastKept.get(key);
    if (kept) {
      this.pastKept.delete(key);
      this.pastKept.set(key, kept);
      return kept;
    }
    const pending = this.pastInFlight.get(key);
    if (pending) return pending;
    const work = (async () => {
      const saved = await this.storage?.readEntry(key).catch(() => null);
      if (saved && Array.isArray(saved.value)) return saved.value as GameLine[];
      const provider = this.provider!;
      const games = await provider.fetchPlayerSeason!(sourceId, season);
      const teams = new Map<string, string | null>();
      for (const game of games) if (game.team && !teams.has(game.team)) teams.set(game.team, game.teamId ?? null);
      const schedules = await Promise.all(
        [...teams].map(async ([abbreviation, id]) => teamLines(abbreviation, await provider.fetchTeamSeason!({ id, abbreviation }, season))),
      );
      const lines = regularSeasonLines([...games, ...schedules.flat()]);
      await this.storage?.writeEntry(key, { savedAt: this.now(), value: lines }).catch((error: Error) => {
        console.error(`[stats] could not save ${key}:`, error.message);
      });
      return lines;
    })();
    this.pastInFlight.set(key, work);
    try {
      const lines = await work;
      this.pastKept.set(key, lines);
      while (this.pastKept.size > PAST_SEASONS_KEPT) this.pastKept.delete(this.pastKept.keys().next().value!);
      return lines;
    } finally {
      this.pastInFlight.delete(key);
    }
  }

  /** Older seasons already read, most recently used last. */
  private pastKept = new Map<string, GameLine[]>();
  private pastInFlight = new Map<string, Promise<GameLine[]>>();

  /** Last season's regular-season lines, worked out once per download of it. */
  private priorRegular(prior: SeasonData): GameLine[] {
    if (prior.syncedAt === null) return [];
    const kept = this.priorRegularKept;
    if (kept && kept.syncedAt === prior.syncedAt && kept.size === prior.lines.size) return kept.lines;
    const lines = regularSeasonLines([...prior.lines.values()]);
    this.priorRegularKept = { syncedAt: prior.syncedAt, size: prior.lines.size, lines };
    return lines;
  }

  private priorRegularKept: { syncedAt: number; size: number; lines: GameLine[] } | null = null;

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
    const synced = Math.max(data.syncedAt ?? 0, data.liveSyncedAt ?? 0);
    return { lines: result, syncedAt: synced > 0 ? new Date(synced).toISOString() : null };
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
      liveSyncedAt: null,
      liveInFlight: null,
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
