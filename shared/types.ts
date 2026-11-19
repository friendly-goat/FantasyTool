import type { InjuryNews } from "./injury.ts";
import type { Projection } from "./projection.ts";

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
  /** True when saved data is shown while a newer copy is being fetched. */
  refreshing?: boolean;
  /** True while NBA games are being played (data refreshes more often). */
  live?: boolean;
  league: {
    id: string;
    name: string;
    season: string;
    /** First day of the regular season (YYYY-MM-DD), when Sleeper reports it. */
    seasonStartDate: string | null;
    status: string;
    totalRosters: number;
    /** Starting and bench slots, as Sleeper lists them (no IR). */
    rosterPositions: string[];
    /** Injured reserve slots. */
    reserveSlots: number;
    /** Which injury statuses may go on IR, from the league settings. */
    reserveAllows?: ReserveAllows;
    scoringSettings: Record<string, number>;
    /** Playoff format from the league settings, or null when Sleeper does not say. */
    playoffs: { startWeek: number; teams: number } | null;
  };
  week: number;
  teams: Team[];
  matchups: Matchup[];
  transactions: Transaction[];
}

/** One NBA game in a fantasy week, played or not. */
export interface NbaGame {
  id: string;
  /** Game day, YYYY-MM-DD, as the NBA lists it. */
  date: string;
  /** Tip-off as an ISO timestamp, when known. */
  startTime: string | null;
  home: string | null;
  away: string | null;
  state: "scheduled" | "in_progress" | "final";
  homeScore: number | null;
  awayScore: number | null;
  statusText: string | null;
}

/** One player's game this week, scored with the league's settings. */
export interface WeekLine {
  date: string;
  /** Fantasy points from the box score (no technical or flagrant fouls). */
  points: number;
  minutes: number;
  final: boolean;
  opponent: string | null;
  home: boolean | null;
  /** His team in that game, when the stats source says (a past week may predate a trade). */
  team?: string | null;
  /** The box score itself. */
  stats: StatLine;
}

/** Injury statuses a league lets onto IR. */
export interface ReserveAllows {
  out: boolean;
  doubtful: boolean;
  suspended: boolean;
  dayToDay: boolean;
}

/** One fantasy week's matchups, current or past. */
export interface WeekMatchups {
  week: number;
  matchups: Matchup[];
}

/** Everything the matchup view needs about the NBA side of a fantasy week. */
export interface WeekData {
  week: number;
  /** First and last day of the fantasy week, YYYY-MM-DD. */
  start: string;
  end: string;
  /** "unavailable" when the stats source has no schedule or could not be reached. */
  schedule: "ready" | "unavailable";
  scheduleMessage: string | null;
  games: NbaGame[];
  /** Sleeper player ID -> his games this week, oldest first. */
  lines: Record<string, WeekLine[]>;
  /** When the box scores were last brought up to date. */
  linesSyncedAt: string | null;
}

/** A manager's word on whether a starter's current score is locked. */
export interface LockMarkInfo {
  rosterId: number;
  playerId: string;
  locked: boolean;
  /** Sleeper's score when the mark was made. */
  points: number;
  markedAt: number;
}

export interface LockMarks {
  week: number;
  marks: LockMarkInfo[];
}

/** One pick on the draft board. */
export interface DraftSelection {
  /** Overall pick number, from 1. */
  pickNo: number;
  round: number;
  /** Draft slot (board column), from 1. */
  slot: number;
  /** Pick number within the round, as Sleeper labels it ("2.12"). */
  pickInRound: number;
  /** Roster that made the pick; differs from the slot's owner after a pick trade. */
  rosterId: number | null;
  keeper: boolean;
  player: PlayerRef;
}

export interface DraftBoard {
  draftId: string;
  status: string;
  /** "snake", "linear" or "auction". */
  type: string;
  rounds: number;
  teams: number;
  /** One column per draft slot, in board order, with the roster that owns it. */
  slots: { slot: number; rosterId: number | null }[];
  picks: DraftSelection[];
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

/**
 * Where fantasy points come from, by scoring setting: points and shooting, threes, rebounds,
 * assists, steals and blocks, bonuses (double-doubles, triple-doubles, thresholds), and what
 * costs points (turnovers, fouls). Worked out in server/scoring.ts.
 */
export const FANTASY_SOURCES = ["scoring", "threes", "boards", "playmaking", "defense", "bonuses", "mistakes"] as const;
export type FantasySource = (typeof FANTASY_SOURCES)[number];

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
  /**
   * Expected locked score in a typical week of a lock-in league
   * (see shared/lockin.ts). The value used for lineup and trade analysis.
   */
  lockInValue: number;
  /** Lock-in value for weeks of 1, 2, 3 and 4 games, in that order. */
  lockInByGames: number[];
  /** Games his NBA team has played this season. */
  teamGames: number;
  /** Share of his team's remaining games he is expected to play (shared/projection.ts). */
  availability: number;
  /** Team games he has missed in a row up to now. */
  missedStreak: number;
  /** True when that run is long enough to be an injury absence, not rest. */
  longTermOut: boolean;
  /** His usual share of games when fit, before any allowance for a long absence (`availability` includes one). */
  playRate: number;
  /** His entry on the league's injury report, if he is on it (shared/injury.ts). */
  injury: InjuryNews | null;
  /** Rest-of-season projection with the adjustments behind it. */
  projection: Projection;
  /** Highest single-game fantasy score this season. */
  bestGame: number;
  /** Fantasy points per game over the most recent games, or null if none. */
  recentAvg: number | null;
  recentGames: number;
  averages: StatLine;
  /**
   * Fantasy points per game by where they come from (shared/teamProfile.ts). Missing from
   * reports saved before it was added.
   */
  sources?: Record<FantasySource, number>;
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
  /**
   * Last season's stats feed the projections. They download once, in the
   * background, after this season's: "loading" until then, "off" without a
   * stats source.
   */
  lastSeason: "off" | "loading" | "ready";
  lastSeasonPages: number;
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
