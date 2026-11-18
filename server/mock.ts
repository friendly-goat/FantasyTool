import { fantasyPoints } from "./scoring.ts";
import type { FetchJson } from "./sleeper.ts";
import { createMockStats } from "./stats/mock.ts";
import { weekRange } from "../shared/weeks.ts";

// Stand-in for the Sleeper API, used by `npm run dev:mock` and the tests.
// It answers the same paths with a made-up ten-team league so the app can
// be run and developed without touching the network. All names are invented.

export const MOCK_LEAGUE_ID = "mock-league";
const WEEK = 4;

const MANAGERS = [
  ["Dana", "Backcourt Bandits"],
  ["Luis", "Paint Patrol"],
  ["Priya", "Corner Three Club"],
  ["Tomas", "Glass Cleaners"],
  ["Mei", "Full Court Press"],
  ["Jonah", "Sixth Man Society"],
  ["Aisha", "Pick and Roll Call"],
  ["Felix", "Rim Runners"],
  ["Nora", "Buzzer Beaters"],
  ["Sam", ""],
] as const;

const FIRST = ["Marcus", "Devon", "Elias", "Jalen", "Theo", "Andre", "Kofi", "Mateo", "Isaiah", "Niko", "Rashad", "Owen", "Dario"];
const LAST = ["Whitfield", "Okafor", "Lindqvist", "Brooks", "Castellano", "Ndiaye", "Harlow", "Vance", "Petrov", "Mbeki", "Sorensen", "Calloway", "Reyes"];
const NBA_TEAMS = ["ATL", "BOS", "CHI", "DAL", "DEN", "GSW", "LAL", "MIA", "MIL", "NYK", "OKC", "PHX"];
const POSITIONS = [["PG"], ["SG"], ["PG", "SG"], ["SF"], ["PF"], ["SF", "PF"], ["C"], ["PF", "C"]];
// As Sleeper sends them: starting and bench slots only; IR slots are in settings.reserve_slots.
const ROSTER_POSITIONS = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "UTIL", "BN", "BN", "BN", "BN"];
const ROSTER_SIZE = 13;

/** Deterministic pseudo-random numbers, so mock data is the same every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function build() {
  const random = seeded(7);
  const players: Record<string, unknown> = {};
  const total = MANAGERS.length * ROSTER_SIZE + 20; // 20 extra free agents
  for (let i = 0; i < total; i++) {
    const id = String(1000 + i);
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 5 + Math.floor(i / FIRST.length)) % LAST.length]!;
    const roll = random();
    players[id] = {
      player_id: id,
      full_name: `${first} ${last}`,
      first_name: first,
      last_name: last,
      team: NBA_TEAMS[Math.floor(random() * NBA_TEAMS.length)],
      fantasy_positions: POSITIONS[Math.floor(random() * POSITIONS.length)],
      injury_status: roll < 0.06 ? "OUT" : roll < 0.12 ? "DTD" : null,
    };
  }

  const users = MANAGERS.map(([name, teamName], i) => ({
    user_id: `u${i + 1}`,
    username: name.toLowerCase(),
    display_name: name,
    avatar: null,
    metadata: teamName ? { team_name: teamName } : {},
  }));

  const rosters = MANAGERS.map((_, i) => {
    const ids = Array.from({ length: ROSTER_SIZE }, (_, j) => String(1000 + i * ROSTER_SIZE + j));
    const wins = Math.round(random() * (WEEK - 1));
    return {
      roster_id: i + 1,
      owner_id: `u${i + 1}`,
      starters: ids.slice(0, 9),
      players: ids,
      reserve: ids.slice(12),
      settings: {
        wins,
        losses: WEEK - 1 - wins,
        ties: 0,
        fpts: 2600 + Math.floor(random() * 700),
        fpts_decimal: Math.floor(random() * 100),
        fpts_against: 2600 + Math.floor(random() * 700),
        fpts_against_decimal: Math.floor(random() * 100),
      },
    };
  });

  // Each starter has a score for the week, or none yet (about one in four).
  const day = 24 * 60 * 60 * 1000;
  const base = Date.UTC(2026, 10, 14, 18, 0, 0);
  const freeAgent = (n: number) => String(1000 + MANAGERS.length * ROSTER_SIZE + n);
  const transactions: Record<number, unknown[]> = {
    [WEEK]: [
      {
        transaction_id: "t1",
        type: "trade",
        status: "complete",
        created: base,
        leg: WEEK,
        roster_ids: [2, 5],
        adds: { "1013": 5, "1014": 5, "1052": 2 },
        drops: { "1013": 2, "1014": 2, "1052": 5 },
        draft_picks: [{ season: "2027", round: 2, roster_id: 5, previous_owner_id: 5, owner_id: 2 }],
      },
      {
        transaction_id: "t2",
        type: "waiver",
        status: "complete",
        created: base - day,
        leg: WEEK,
        roster_ids: [7],
        adds: { [freeAgent(0)]: 7 },
        drops: { "1089": 7 },
        draft_picks: [],
      },
      {
        transaction_id: "t3",
        type: "waiver",
        status: "failed",
        created: base - day,
        leg: WEEK,
        roster_ids: [3],
        adds: { [freeAgent(0)]: 3 },
        drops: null,
        draft_picks: [],
      },
    ],
    [WEEK - 1]: [
      {
        transaction_id: "t4",
        type: "free_agent",
        status: "complete",
        created: base - 6 * day,
        leg: WEEK - 1,
        roster_ids: [1],
        adds: { [freeAgent(1)]: 1 },
        drops: null,
        draft_picks: [],
      },
    ],
  };

  const league = {
    league_id: MOCK_LEAGUE_ID,
    name: "Sample League (mock data)",
    season: "2026",
    status: "in_season",
    total_rosters: MANAGERS.length,
    roster_positions: ROSTER_POSITIONS,
    // Same shape as the owner's league, so bonus handling shows up in the sample data.
    scoring_settings: {
      pts: 1, reb: 1.2, ast: 1.5, stl: 2, blk: 3, to: -1, dd: 3, td: 5,
      bonus_pt_40p: 5, bonus_pt_50p: 10, bonus_reb_20p: 10, bonus_ast_15p: 5,
    },
    settings: { playoff_week_start: 22, playoff_teams: 6, reserve_slots: 1 },
  };

  // A completed snake draft of each roster's players. It uses its own random
  // stream so the rest of the mock league stays the same.
  const draftRandom = seeded(11);
  const slotToRoster: Record<string, number> = {};
  const draftOrder: Record<string, number> = {};
  rosters.forEach((roster, i) => {
    const slot = ((i * 7) % MANAGERS.length) + 1;
    slotToRoster[String(slot)] = roster.roster_id;
    draftOrder[roster.owner_id] = slot;
  });
  const draftOrderOf = rosters.map((roster) =>
    roster.players
      .map((id) => ({ id, key: draftRandom() }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.id),
  );
  const draftPicks: Record<string, unknown>[] = [];
  for (let round = 1; round <= ROSTER_SIZE; round++) {
    for (let k = 1; k <= MANAGERS.length; k++) {
      const slot = round % 2 === 1 ? k : MANAGERS.length - k + 1;
      const rosterId = slotToRoster[String(slot)]!;
      const playerId = draftOrderOf[rosterId - 1]![round - 1]!;
      draftPicks.push({
        player_id: playerId,
        picked_by: `u${rosterId}`,
        roster_id: rosterId,
        round,
        draft_slot: slot,
        pick_no: (round - 1) * MANAGERS.length + k,
        is_keeper: null,
        metadata: {},
      });
    }
  }
  const draft = {
    draft_id: "mock-draft",
    status: "complete",
    type: "snake",
    season: "2026",
    start_time: Date.UTC(2026, 9, 12),
    settings: { rounds: ROSTER_SIZE, teams: MANAGERS.length },
    draft_order: draftOrder,
    slot_to_roster_id: slotToRoster,
  };

  return { players, users, rosters, transactions, league, draft, draftPicks };
}

const data = build();

const SEASON_START = "2026-10-20";
const matchupsCache = new Map<number, Promise<unknown[]>>();

/** Week `week`'s pairs of roster indexes: the current week pairs neighbours, other weeks rotate (circle method). */
function pairings(week: number, teams: number): number[][] {
  if (week === WEEK) return Array.from({ length: teams / 2 }, (_, k) => [2 * k, 2 * k + 1]);
  const others = Array.from({ length: teams - 1 }, (_, k) => k + 1);
  const turned = others.map((_, k) => others[(k + week) % others.length]!);
  const order = [0, ...turned];
  return Array.from({ length: teams / 2 }, (_, k) => [order[k]!, order[teams - 1 - k]!]);
}

/**
 * A week's matchups, scored from the mock box scores the way Sleeper reports
 * a lock-in week: a starter shows either an earlier game that week (he
 * locked it) or his latest game (not locked yet, or locked on it), and 0
 * before he plays. Bench players show 0, as on Sleeper. In past weeks one
 * score in a few is nudged off its box score, as a stat correction would, so
 * the app has something it cannot explain.
 */
function mockMatchups(week: number): Promise<unknown[]> {
  let cached = matchupsCache.get(week);
  if (cached) return cached;
  cached = (async () => {
    const { start, end } = weekRange(SEASON_START, week);
    const lines = await createMockStats(data.players).fetchGameLines("2026", start, () => {});
    const byPlayer = new Map<string, typeof lines>();
    for (const line of lines) {
      if (line.date > end) continue;
      const list = byPlayer.get(line.playerId) ?? [];
      list.push(line);
      byPlayer.set(line.playerId, list);
    }
    for (const list of byPlayer.values()) list.sort((a, b) => a.date.localeCompare(b.date));
    const scoring = data.league.scoring_settings;
    const matchupOf = new Map<number, number>();
    pairings(week, data.rosters.length).forEach((pair, k) => pair.forEach((index) => matchupOf.set(index, k + 1)));
    return data.rosters.map((roster, i) => {
      const playersPoints: Record<string, number> = {};
      for (const id of roster.players) playersPoints[id] = 0;
      const startersPoints = roster.starters.map((id, slot) => {
        const games = byPlayer.get(`p${id}`) ?? [];
        if (games.length === 0) return 0;
        // The current week keeps the pattern the tests know; past weeks shift it.
        const shift = WEEK - week;
        const counted = (i + slot + shift) % 3 === 0 && games.length > 1 ? games[0]! : games[games.length - 1]!;
        const corrected = shift > 0 && (i + slot + shift) % 17 === 0 ? 1.5 : 0;
        const score = Math.round((fantasyPoints(counted.stats, scoring) + corrected) * 100) / 100;
        playersPoints[id] = score;
        return score;
      });
      return {
        roster_id: roster.roster_id,
        matchup_id: matchupOf.get(i) ?? null,
        points: Math.round(startersPoints.reduce((sum, value) => sum + value, 0) * 100) / 100,
        starters: roster.starters,
        players: roster.players,
        starters_points: startersPoints,
        players_points: playersPoints,
      };
    });
  })();
  matchupsCache.set(week, cached);
  return cached;
}

export const fetchFromMock: FetchJson = async (path) => {
  if (path === "/state/nba") {
    return {
      week: WEEK,
      leg: WEEK,
      season: "2026",
      league_season: "2026",
      season_type: "regular",
      season_start_date: SEASON_START,
    };
  }
  if (path === "/players/nba") return data.players;
  if (/^\/user\/[^/]+$/.test(path)) return { user_id: "u1", username: "dana", display_name: "Dana" };
  if (/^\/user\/[^/]+\/leagues\/nba\/\d+$/.test(path)) return [data.league];

  const league = path.match(/^\/league\/([^/]+)(\/.*)?$/);
  if (league) {
    if (decodeURIComponent(league[1]!) !== MOCK_LEAGUE_ID) return null;
    const rest = league[2] ?? "";
    if (rest === "") return data.league;
    if (rest === "/rosters") return data.rosters;
    if (rest === "/users") return data.users;
    const matchups = rest.match(/^\/matchups\/(\d+)$/);
    if (matchups) return Number(matchups[1]) > WEEK ? [] : mockMatchups(Number(matchups[1]));
    if (rest === "/drafts") return [data.draft];
    const tx = rest.match(/^\/transactions\/(\d+)$/);
    if (tx) return data.transactions[Number(tx[1])] ?? [];
  }
  if (path === "/draft/mock-draft") return data.draft;
  if (path === "/draft/mock-draft/picks") return data.draftPicks;
  throw new Error(`Mock Sleeper API has no answer for ${path}`);
};
