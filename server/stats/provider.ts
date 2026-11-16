import type { StatLine } from "../../shared/types.ts";

/** One player's line in one game, as supplied by a stats source. */
export interface GameLine {
  /** Unique per player per game. */
  key: string;
  /** The stats source's own player ID (not Sleeper's). */
  playerId: string;
  playerName: string;
  team: string | null;
  /** The player's team and opponent, as the stats source identifies them. */
  teamId?: string | null;
  opponentId?: string | null;
  /** Opponent's abbreviation, when the source includes it on the game. */
  opponent?: string | null;
  /** True for a home game, false for away. */
  home?: boolean | null;
  /** YYYY-MM-DD. */
  date: string;
  /** False while a game is still being played. */
  final: boolean;
  minutes: number;
  stats: StatLine;
}

/**
 * A source of NBA box scores. Swapping stats vendors means writing one
 * more of these; nothing else in the app knows which vendor is in use.
 */
export interface StatsProvider {
  name: string;
  /**
   * Returns every game line for a season, or only those on or after
   * `fromDate` (YYYY-MM-DD). `onPage` is called after each page loads.
   */
  fetchGameLines(
    season: string,
    fromDate: string | null,
    onPage: (pagesFetched: number) => void,
  ): Promise<GameLine[]>;
}
