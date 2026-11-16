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

export interface MatchupSide {
  rosterId: number;
  points: number;
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
