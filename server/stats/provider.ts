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

/** One NBA game on the schedule, played or not. */
export interface ScheduledGame {
  id: string;
  /** Game day, YYYY-MM-DD (US Eastern, as the NBA lists it). */
  date: string;
  /** Tip-off as an ISO timestamp, when known. */
  startTime: string | null;
  home: string | null;
  away: string | null;
  state: "scheduled" | "in_progress" | "final";
  homeScore: number | null;
  awayScore: number | null;
  /** The source's own status text, such as "3rd Qtr". */
  statusText: string | null;
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
  /** Every game from `startDate` to `endDate` (YYYY-MM-DD, inclusive), played or not. */
  fetchSchedule?(startDate: string, endDate: string): Promise<ScheduledGame[]>;
}
