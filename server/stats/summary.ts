import type { PlayerRef, PlayerStats, StatLine } from "../../shared/types.ts";
import { fantasyPoints } from "../scoring.ts";
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
 * Builds per-player season numbers, keyed by Sleeper player ID.
 * Only finished games in which the player actually played are counted.
 */
export function summarize(
  lines: GameLine[],
  matches: Map<string, string>,
  sleeperPlayers: Record<string, PlayerRef>,
  scoring: Record<string, number>,
): Record<string, PlayerStats> {
  const bySource = new Map<string, GameLine[]>();
  for (const line of lines) {
    if (!line.final || line.minutes <= 0) continue;
    bySource.set(line.playerId, [...(bySource.get(line.playerId) ?? []), line]);
  }

  const result: Record<string, PlayerStats> = {};
  for (const [sleeperId, sourceId] of matches) {
    const player = sleeperPlayers[sleeperId];
    const games = bySource.get(sourceId);
    if (!player || !games || games.length === 0) continue;

    games.sort((a, b) => a.date.localeCompare(b.date));
    const fantasy = games.map((game) => fantasyPoints(game.stats, scoring));
    const recent = fantasy.slice(-RECENT_WINDOW);
    const averages = Object.fromEntries(
      STAT_KEYS.map((key) => [key, mean(games.map((game) => game.stats[key]))]),
    ) as unknown as StatLine;

    result[sleeperId] = {
      ...player,
      games: games.length,
      minutes: mean(games.map((game) => game.minutes)),
      fantasyAvg: mean(fantasy),
      recentAvg: recent.length > 0 ? mean(recent) : null,
      recentGames: recent.length,
      averages,
    };
  }
  return result;
}
