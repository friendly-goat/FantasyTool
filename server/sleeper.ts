// Thin client for the Sleeper read-only API (https://docs.sleeper.com).
//
// Sleeper asks callers to stay under 1,000 requests per minute. A full
// league refresh here is roughly ten requests, and the limiter below
// caps this process at 120 per minute as a safety net against bugs.

const BASE_URL = "https://api.sleeper.app/v1";
const MAX_REQUESTS_PER_MINUTE = 120;

export type FetchJson = (path: string) => Promise<unknown>;

export class SleeperError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const recentRequests: number[] = [];

async function waitForSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (recentRequests.length > 0 && now - recentRequests[0]! > 60_000) {
      recentRequests.shift();
    }
    if (recentRequests.length < MAX_REQUESTS_PER_MINUTE) {
      recentRequests.push(now);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Fetches one Sleeper path, e.g. "/league/123/rosters". */
export const fetchFromSleeper: FetchJson = async (path) => {
  await waitForSlot();
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SleeperError(
      "Sleeper could not be reached. Check your internet connection and try again.",
      0,
    );
  }
  if (!response.ok) {
    throw new SleeperError(
      `Sleeper returned ${response.status} for ${path}`,
      response.status,
    );
  }
  return response.json();
};

// ---- Raw response shapes -------------------------------------------------
// Only the fields this app reads. Everything is optional because the NBA
// side of the API is not formally documented, so the code that consumes
// these must tolerate missing values.

export interface RawState {
  week?: number;
  leg?: number;
  season?: string;
  league_season?: string;
  season_type?: string;
  /** First day of the regular season, YYYY-MM-DD. */
  season_start_date?: string;
}

export interface RawUser {
  user_id?: string;
  username?: string;
  display_name?: string;
  avatar?: string | null;
  metadata?: { team_name?: string } | null;
}

export interface RawLeague {
  league_id?: string;
  name?: string;
  season?: string;
  status?: string;
  total_rosters?: number;
  roster_positions?: string[];
  scoring_settings?: Record<string, number>;
  settings?: {
    /** First week of the playoffs. */
    playoff_week_start?: number;
    /** How many teams make the playoffs. */
    playoff_teams?: number;
  } | null;
}

export interface RawRoster {
  roster_id?: number;
  owner_id?: string | null;
  starters?: string[] | null;
  players?: string[] | null;
  reserve?: string[] | null;
  settings?: {
    wins?: number;
    losses?: number;
    ties?: number;
    fpts?: number;
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
  } | null;
}

export interface RawMatchup {
  roster_id?: number;
  matchup_id?: number | null;
  points?: number | null;
  custom_points?: number | null;
  starters?: string[] | null;
  players?: string[] | null;
  /** Same order as `starters`. */
  starters_points?: number[] | null;
  /** Player ID -> points credited for the week. */
  players_points?: Record<string, number> | null;
}

export interface RawDraftPick {
  season?: string;
  round?: number;
  roster_id?: number;
  owner_id?: number;
}

export interface RawTransaction {
  transaction_id?: string;
  type?: string;
  status?: string;
  created?: number;
  leg?: number;
  roster_ids?: number[] | null;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: RawDraftPick[] | null;
}

/** A draft, from /league/:id/drafts or /draft/:id. */
export interface RawDraft {
  draft_id?: string;
  status?: string;
  /** "snake", "linear" or "auction". */
  type?: string;
  season?: string;
  start_time?: number | null;
  settings?: { rounds?: number; teams?: number } | null;
  /** User ID -> draft slot. */
  draft_order?: Record<string, number> | null;
  /** Draft slot -> roster ID. */
  slot_to_roster_id?: Record<string, number> | null;
}

/** One selection, from /draft/:id/picks. */
export interface RawDraftSelection {
  player_id?: string;
  picked_by?: string;
  roster_id?: number | null;
  round?: number;
  draft_slot?: number;
  pick_no?: number;
  is_keeper?: boolean | null;
  metadata?: {
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string;
  } | null;
}

export interface RawPlayer {
  player_id?: string;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  team?: string | null;
  fantasy_positions?: string[] | null;
  position?: string | null;
  injury_status?: string | null;
}
