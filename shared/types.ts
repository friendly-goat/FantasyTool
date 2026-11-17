// Types shared by the backend (server/) and the React app (src/).
// The backend turns raw Sleeper responses into these shapes so the UI
// never has to know how Sleeper structures its data.

export interface PlayerRef {
  id: string;
  name: string;
  /** NBA team abbreviation, or null for free agents / unknown players. */
  team: string | null;
  positions: string[];
  /** Sleeper's injury tag (e.g. "OUT", "DTD"), or null when healthy. */
  injuryStatus: string | null;
}

export interface StarterSlot {
  /** Lineup slot from the league settings, e.g. "PG", "UTIL". */
  slot: string;
  player: PlayerRef | null;
}

export interface Team {
  rosterId: number;
  ownerId: string | null;
  managerName: string;
  teamName: string;
  avatarUrl: string | null;
  rank: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  starters: StarterSlot[];
  bench: PlayerRef[];
  reserve: PlayerRef[];
}

export interface MatchupSlot {
  /** Lineup slot, e.g. "PG", "UTIL", or "BN" for the bench. */
  slot: string;
  player: PlayerRef | null;
  /** Points Sleeper has credited this player for the week, if any yet. */
  points: number | null;
}

export interface MatchupSide {
  rosterId: number;
  points: number;
  starters: MatchupSlot[];
  bench: MatchupSlot[];
}

export interface Matchup {
  matchupId: number;
  sides: MatchupSide[];
}

export type TransactionType = "trade" | "waiver" | "free_agent" | "other";

export interface TransactionSide {
  rosterId: number;
  adds: PlayerRef[];
  drops: PlayerRef[];
  /** Draft picks received, already formatted for display. */
  picks: string[];
}

export interface Transaction {
  id: string;
  type: TransactionType;
  /** ISO timestamp. */
  createdAt: string;
  week: number;
  sides: TransactionSide[];
}

export interface LeagueSnapshot {
  /** ISO timestamp of when this data was pulled from Sleeper. */
  fetchedAt: string;
  /** True when Sleeper could not be reached and older data is shown. */
  stale: boolean;
  league: {
    id: string;
    name: string;
    season: string;
    /** First day of the regular season (YYYY-MM-DD), when Sleeper reports it. */
    seasonStartDate: string | null;
    status: string;
    totalRosters: number;
    rosterPositions: string[];
    scoringSettings: Record<string, number>;
  };
  week: number;
  teams: Team[];
  matchups: Matchup[];
  transactions: Transaction[];
}

export interface LeagueSummary {
  id: string;
  name: string;
  season: string;
  totalRosters: number;
}

export interface UserLeagues {
  user: { id: string; displayName: string };
  season: string;
  leagues: LeagueSummary[];
}

export interface AppConfig {
  defaultLeagueId: string | null;
  mock: boolean;
}

// ---- Player stats -------------------------------------------------------

/** One player's box-score numbers for a game, or per-game averages. */
export interface StatLine {
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  /** Three-pointers made and attempted. */
  tpm: number;
  tpa: number;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  oreb: number;
  dreb: number;
  pf: number;
}

export interface PlayerStats extends PlayerRef {
  games: number;
  /** Average minutes per game played. */
  minutes: number;
  /** Fantasy points per game this season, under this league's scoring. */
  fantasyAvg: number;
  /**
   * The season average as Sleeper's app displays it, which counts each
   * threshold bonus once against season totals. For comparison only.
   */
  sleeperAvg: number;
  /** Fantasy points per game over the most recent games, or null if none. */
  recentAvg: number | null;
  recentGames: number;
  averages: StatLine;
}

export interface StatsReport {
  /**
   * unconfigured: no stats API key is set.
   * syncing: game data is being downloaded; `players` may be partial or empty.
   * ready: `players` is complete as of `syncedAt`.
   * error: the last download failed; `players` holds any older data.
   */
  status: "unconfigured" | "syncing" | "ready" | "error";
  message: string | null;
  source: string | null;
  syncedAt: string | null;
  /** Pages downloaded so far in the current sync. */
  pagesFetched: number;
  /** How many games the "recent" average covers. */
  recentWindow: number;
  /** League scoring settings the stats source has no data for. */
  ignoredScoring: string[];
  /** Rostered players that could not be matched to the stats source. */
  unmatchedRostered: PlayerRef[];
  /** Keyed by Sleeper player ID. Only players with at least one game. */
  players: Record<string, PlayerStats>;
}

/** One game in a player's game log. */
export interface PlayerGame {
  /** YYYY-MM-DD. */
  date: string;
  /** Opponent's abbreviation, when the stats source provides it. */
  opponent: string | null;
  /** True for a home game, false for away, null when unknown. */
  home: boolean | null;
  minutes: number;
  stats: StatLine;
  fantasyPoints: number;
}

export interface PlayerDetail {
  player: PlayerRef;
  /** Null when the player has no counted games this season. */
  stats: PlayerStats | null;
  /** Newest first. */
  games: PlayerGame[];
}
