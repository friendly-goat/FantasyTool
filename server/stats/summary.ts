import type { InjuryNews } from "../../shared/injury.ts";
import { FANTASY_SOURCES, type FantasySource, type MissedGame, type PlayerGame, type PlayerRef, type PlayerStats, type StatLine } from "../../shared/types.ts";
import { lockInValue, lockInValues } from "../../shared/lockin.ts";
import { availabilityOutlook, projectPlayer } from "../../shared/projection.ts";
import { fantasyPoints, fantasySources, sleeperDisplayedAverage } from "../scoring.ts";
import type { GameLine } from "./provider.ts";

/** The player's reference without Sleeper's years in the league (server side only). */
function withoutYears(player: PlayerRef): PlayerRef {
  const { yearsExp: _yearsExp, ...ref } = player;
  return ref;
}

/** Number of most recent games behind each player's "recent" average. */
export const RECENT_WINDOW = 5;

const STAT_KEYS: (keyof StatLine)[] = [
  "pts", "reb", "ast", "stl", "blk", "tov", "tpm", "tpa",
  "fgm", "fga", "ftm", "fta", "oreb", "dreb", "pf",
];

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Whether a game line counts toward a player's numbers: the game is
 * finished, the player actually played, and it is not a preseason game
 * (anything before the season's first day).
 */
export function counts(line: GameLine, seasonStart: string | null): boolean {
  return line.final && line.minutes > 0 && (seasonStart === null || line.date >= seasonStart);
}

/** Groups the lines that count by stats-source player ID, oldest game first. */
export function countedGames(lines: GameLine[], seasonStart: string | null): Map<string, GameLine[]> {
  const bySource = new Map<string, GameLine[]>();
  for (const line of lines) {
    if (!counts(line, seasonStart)) continue;
    const games = bySource.get(line.playerId);
    if (games) games.push(line);
    else bySource.set(line.playerId, [line]);
  }
  for (const games of bySource.values()) games.sort((a, b) => a.date.localeCompare(b.date));
  return bySource;
}

const REGULAR_SEASON_GAMES = 82;

/** The dates each NBA team has played on, oldest first: team abbreviation -> dates. */
export function teamGameDates(lines: GameLine[], seasonStart: string | null): Map<string, string[]> {
  const dates = new Map<string, Set<string>>();
  for (const line of lines) {
    if (!line.team || !line.final || (seasonStart !== null && line.date < seasonStart)) continue;
    const seen = dates.get(line.team);
    if (seen) seen.add(line.date);
    else dates.set(line.team, new Set([line.date]));
  }
  return new Map([...dates].map(([team, seen]) => [team, [...seen].sort()]));
}

/** Games in an NBA regular season, per team. */
export const REGULAR_SEASON_TEAM_GAMES = 82;

/**
 * A finished season's regular-season lines: each team's first 82 game days (the play-in and
 * playoffs come after, and the stored lines do not mark them).
 */
export function regularSeasonLines(lines: GameLine[]): GameLine[] {
  const regular = new Map<string, Set<string>>();
  for (const [team, dates] of teamGameDates(lines, null)) regular.set(team, new Set(dates.slice(0, REGULAR_SEASON_TEAM_GAMES)));
  return lines.filter((line) => line.team !== null && regular.get(line.team)?.has(line.date));
}

/** What a player did last season: stats-source player ID -> games and fantasy average. */
export type LastSeason = Map<string, { games: number; average: number }>;

export function lastSeasonLevels(lines: GameLine[], scoring: Record<string, number>): LastSeason {
  const totals = new Map<string, { games: number; points: number }>();
  for (const line of lines) {
    if (!line.final || line.minutes <= 0) continue;
    const total = totals.get(line.playerId) ?? { games: 0, points: 0 };
    total.games++;
    total.points += fantasyPoints(line.stats, scoring);
    totals.set(line.playerId, total);
  }
  return new Map([...totals].map(([id, total]) => [id, { games: total.games, average: total.points / total.games }]));
}

interface Context {
  teamDates: Map<string, string[]>;
  lastSeason?: { games: number; average: number } | null;
  injury?: InjuryNews | null;
}

/** A player is projected at last season's level, with no games this season, only with this many last season. */
const NO_GAMES_MIN_LAST_SEASON = 10;
/** His usual share of games when fit, for a player with no games yet this season. */
const NO_GAMES_PLAY_RATE = 0.9;

/**
 * A player on the injury report who has not played this season but is due
 * back (or has a date at all) is projected at last season's level, so a
 * star out since opening night still counts once he returns. When he will
 * play comes from the report (shared/injury.ts).
 */
function injuredWithoutGames(
  player: PlayerRef,
  injury: InjuryNews,
  lastSeason: { games: number; average: number },
): PlayerStats {
  const empty = Object.fromEntries(STAT_KEYS.map((key) => [key, 0])) as unknown as StatLine;
  return {
    ...withoutYears(player),
    games: 0,
    minutes: 0,
    fantasyAvg: 0,
    sleeperAvg: 0,
    lockInValue: 0,
    lockInByGames: [],
    teamGames: 0,
    availability: 0,
    playRate: NO_GAMES_PLAY_RATE,
    missedStreak: 0,
    longTermOut: true,
    injury,
    projection: {
      perGame: lastSeason.average,
      factors: [{ label: "Last season's level (no games yet this season)", effect: lastSeason.average }],
      trend: "steady",
      lastSeason,
    },
    bestGame: 0,
    recentAvg: null,
    recentMinutes: null,
    recentGames: 0,
    averages: empty,
  };
}

function summarizePlayer(
  player: PlayerRef,
  games: GameLine[],
  scoring: Record<string, number>,
  context: Context,
): PlayerStats {
  const fantasy = games.map((game) => fantasyPoints(game.stats, scoring));
  const recent = fantasy.slice(-RECENT_WINDOW);
  const averages = Object.fromEntries(
    STAT_KEYS.map((key) => [key, mean(games.map((game) => game.stats[key]))]),
  ) as unknown as StatLine;
  const split = games.map((game) => fantasySources(game.stats, scoring));
  const sources = Object.fromEntries(
    FANTASY_SOURCES.map((source) => [source, mean(split.map((parts) => parts[source]))]),
  ) as Record<FantasySource, number>;

  // Which of his current team's games he played. If he changed teams, only
  // the games since he joined count, so the move does not look like an absence.
  const team = games[games.length - 1]?.team ?? null;
  const allDates = (team && context.teamDates.get(team)) || [];
  const changedTeams = games.some((game) => game.team !== team);
  const joined = games.find((game) => game.team === team)?.date ?? "";
  const dates = changedTeams ? allDates.filter((date) => date >= joined) : allDates;
  const playedOn = new Set(games.map((game) => game.date));
  const teamGames = Math.max(games.length, allDates.length);
  const outlook = availabilityOutlook(
    dates.map((date) => playedOn.has(date)),
    REGULAR_SEASON_GAMES - teamGames,
  );

  return {
    ...withoutYears(player),
    games: games.length,
    minutes: mean(games.map((game) => game.minutes)),
    fantasyAvg: mean(fantasy),
    sleeperAvg: sleeperDisplayedAverage(games.map((game) => game.stats), scoring),
    lockInValue: lockInValue(fantasy),
    lockInByGames: lockInValues(fantasy),
    teamGames,
    availability: outlook.rate,
    playRate: outlook.playRate,
    missedStreak: outlook.missedStreak,
    longTermOut: outlook.longTermOut,
    injury: context.injury ?? null,
    projection: projectPlayer(fantasy, games.map((game) => game.minutes), context.lastSeason ?? null),
    bestGame: Math.max(...fantasy),
    recentAvg: recent.length > 0 ? mean(recent) : null,
    recentMinutes: recent.length > 0 ? mean(games.slice(-RECENT_WINDOW).map((game) => game.minutes)) : null,
    recentGames: recent.length,
    averages,
    sources,
  };
}

/** Builds per-player season numbers, keyed by Sleeper player ID. */
export function summarize(
  lines: GameLine[],
  matches: Map<string, string>,
  sleeperPlayers: Record<string, PlayerRef>,
  scoring: Record<string, number>,
  seasonStart: string | null = null,
  lastSeason: LastSeason = new Map(),
  /** The injury report, by stats-source player ID. */
  injuries: Map<string, InjuryNews> = new Map(),
): Record<string, PlayerStats> {
  const bySource = countedGames(lines, seasonStart);
  const teamDates = teamGameDates(lines, seasonStart);
  const result: Record<string, PlayerStats> = {};
  for (const [sleeperId, sourceId] of matches) {
    const player = sleeperPlayers[sleeperId];
    if (!player) continue;
    const games = bySource.get(sourceId);
    const injury = injuries.get(sourceId) ?? null;
    if (!games || games.length === 0) {
      const prior = lastSeason.get(sourceId);
      if (injury && (injury.returnDate || injury.seasonOut) && prior && prior.games >= NO_GAMES_MIN_LAST_SEASON) {
        result[sleeperId] = injuredWithoutGames(player, injury, prior);
      }
      continue;
    }
    result[sleeperId] = summarizePlayer(player, games, scoring, {
      teamDates,
      lastSeason: lastSeason.get(sourceId),
      injury,
    });
  }
  return result;
}

/** One player's season numbers and game log (newest game first). */
export function playerLog(
  player: PlayerRef,
  sourceId: string | undefined,
  lines: GameLine[],
  scoring: Record<string, number>,
  seasonStart: string | null = null,
  lastSeason: LastSeason = new Map(),
): { stats: PlayerStats | null; games: PlayerGame[]; missed: MissedGame[] } {
  const games = sourceId ? (countedGames(lines, seasonStart).get(sourceId) ?? []) : [];
  if (games.length === 0) return { stats: null, games: [], missed: [] };

  // Opponents may be stored as IDs only; learn each team's abbreviation
  // from the lines of the players on it.
  const abbreviations = new Map<string, string>();
  for (const line of lines) {
    if (line.teamId && line.team) abbreviations.set(line.teamId, line.team);
  }

  const teamDates = teamGameDates(lines, seasonStart);
  return {
    missed: missedGames(games, lines, teamDates, abbreviations),
    stats: summarizePlayer(player, games, scoring, {
      teamDates,
      lastSeason: sourceId ? lastSeason.get(sourceId) : null,
    }),
    games: games
      .map((game) => ({
        date: game.date,
        opponent: game.opponent ?? (game.opponentId ? (abbreviations.get(game.opponentId) ?? null) : null),
        home: game.home ?? null,
        minutes: game.minutes,
        stats: game.stats,
        fantasyPoints: fantasyPoints(game.stats, scoring),
      }))
      .reverse(),
  };
}

/**
 * His team's finished games he did not play in, newest first. His team on a date is the team of
 * his latest game on or before it (his first game's team before that), so a traded player's
 * misses are counted against the team he was on. A game he sat with no minutes counts as missed.
 */
export function missedGames(
  games: GameLine[],
  lines: GameLine[],
  teamDates: Map<string, string[]>,
  abbreviations: Map<string, string>,
): MissedGame[] {
  if (games.length === 0) return [];
  const played = new Set(games.map((game) => game.date));
  // Each team's opponent and venue on each date, from its players' lines.
  const fixtures = new Map<string, { opponent: string | null; home: boolean | null }>();
  for (const line of lines) {
    if (!line.team || !line.final) continue;
    const key = `${line.team}|${line.date}`;
    if (fixtures.has(key)) continue;
    const opponent = line.opponent ?? (line.opponentId ? (abbreviations.get(line.opponentId) ?? null) : null);
    fixtures.set(key, { opponent, home: line.home ?? null });
  }
  const teamOn = (date: string): string | null => {
    let team = games[0]!.team;
    for (const game of games) {
      if (game.date > date) break;
      team = game.team ?? team;
    }
    return team;
  };
  const teams = new Set(games.flatMap((game) => (game.team ? [game.team] : [])));
  const missed: MissedGame[] = [];
  for (const team of teams) {
    for (const date of teamDates.get(team) ?? []) {
      if (played.has(date) || teamOn(date) !== team) continue;
      const fixture = fixtures.get(`${team}|${date}`);
      missed.push({ date, opponent: fixture?.opponent ?? null, home: fixture?.home ?? null });
    }
  }
  return missed.sort((a, b) => b.date.localeCompare(a.date));
}

/** Games against a team counted as league average, so a team seen a few times is not judged on them alone. */
const ALLOWED_PRIOR_GAMES = 3;

/**
 * Fantasy points opponents score against each NBA team, per game, as a ratio to the league's
 * average (above 1: a soft matchup). Counted regular-season games only, under the league's
 * scoring; each team starts from three average games, so a few big nights do not make it soft.
 */
export function pointsAllowed(lines: GameLine[], scoring: Record<string, number>, seasonStart: string | null = null): Record<string, number> {
  // The stats source may give only an opponent ID: learn each ID's abbreviation from the lines.
  const abbrById = new Map<string, string>();
  for (const line of lines) if (line.teamId && line.team) abbrById.set(line.teamId, line.team);
  const totals = new Map<string, { points: number; games: Set<string> }>();
  for (const line of lines) {
    if (!counts(line, seasonStart)) continue;
    const against = line.opponent ?? (line.opponentId ? abbrById.get(line.opponentId) : undefined);
    if (!against) continue;
    const entry = totals.get(against) ?? { points: 0, games: new Set<string>() };
    entry.points += fantasyPoints(line.stats, scoring);
    entry.games.add(line.date);
    totals.set(against, entry);
  }
  const perGame = [...totals.values()].filter((entry) => entry.games.size > 0);
  const average = perGame.reduce((sum, entry) => sum + entry.points, 0) / Math.max(1, perGame.reduce((sum, entry) => sum + entry.games.size, 0));
  if (!(average > 0)) return {};
  return Object.fromEntries(
    [...totals.entries()].map(([team, entry]) => [
      team,
      (entry.points + ALLOWED_PRIOR_GAMES * average) / ((entry.games.size + ALLOWED_PRIOR_GAMES) * average),
    ]),
  );
}
