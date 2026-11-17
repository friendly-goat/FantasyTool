import type { PlayerGame, PlayerRef, PlayerStats, StatLine } from "../../shared/types.ts";
import { fantasyPoints, sleeperDisplayedAverage } from "../scoring.ts";
import type { GameLine } from "./provider.ts";

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

function summarizePlayer(
  player: PlayerRef,
  games: GameLine[],
  scoring: Record<string, number>,
): PlayerStats {
  const fantasy = games.map((game) => fantasyPoints(game.stats, scoring));
  const recent = fantasy.slice(-RECENT_WINDOW);
  const averages = Object.fromEntries(
    STAT_KEYS.map((key) => [key, mean(games.map((game) => game.stats[key]))]),
  ) as unknown as StatLine;
  return {
    ...player,
    games: games.length,
    minutes: mean(games.map((game) => game.minutes)),
    fantasyAvg: mean(fantasy),
    sleeperAvg: sleeperDisplayedAverage(games.map((game) => game.stats), scoring),
    recentAvg: recent.length > 0 ? mean(recent) : null,
    recentGames: recent.length,
    averages,
  };
}

/** Builds per-player season numbers, keyed by Sleeper player ID. */
export function summarize(
  lines: GameLine[],
  matches: Map<string, string>,
  sleeperPlayers: Record<string, PlayerRef>,
  scoring: Record<string, number>,
  seasonStart: string | null = null,
): Record<string, PlayerStats> {
  const bySource = countedGames(lines, seasonStart);
  const result: Record<string, PlayerStats> = {};
  for (const [sleeperId, sourceId] of matches) {
    const player = sleeperPlayers[sleeperId];
    const games = bySource.get(sourceId);
    if (!player || !games || games.length === 0) continue;
    result[sleeperId] = summarizePlayer(player, games, scoring);
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
): { stats: PlayerStats | null; games: PlayerGame[] } {
  const games = sourceId ? (countedGames(lines, seasonStart).get(sourceId) ?? []) : [];
  if (games.length === 0) return { stats: null, games: [] };

  // Opponents may be stored as IDs only; learn each team's abbreviation
  // from the lines of the players on it.
  const abbreviations = new Map<string, string>();
  for (const line of lines) {
    if (line.teamId && line.team) abbreviations.set(line.teamId, line.team);
  }

  return {
    stats: summarizePlayer(player, games, scoring),
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
