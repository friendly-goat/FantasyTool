import type { LeagueSnapshot, PlayerRef, PlayerStats, StatsReport, Team } from "./types.ts";

// Lineup and roster analysis. Pure functions over the league snapshot and
// player stats, so the same code serves every view and can be tested.
// A player's value here is his lock-in value (see shared/lockin.ts).

const NON_STARTING_SLOTS = new Set(["BN", "IR", "TAXI"]);
const SLOT_POSITIONS: Record<string, string[]> = {
  PG: ["PG"],
  SG: ["SG"],
  G: ["PG", "SG"],
  SF: ["SF"],
  PF: ["PF"],
  F: ["SF", "PF"],
  C: ["C"],
};

/** Whether a player with these positions may fill a lineup slot. */
export function slotAccepts(slot: string, positions: string[]): boolean {
  const allowed = SLOT_POSITIONS[slot];
  if (!allowed) return slot === "UTIL"; // UTIL takes anyone; unknown slots take no one
  return positions.some((position) => allowed.includes(position));
}

export function startingSlots(snapshot: LeagueSnapshot): string[] {
  return snapshot.league.rosterPositions.filter((slot) => !NON_STARTING_SLOTS.has(slot));
}

export interface Candidate {
  id: string;
  positions: string[];
  value: number;
}

export interface Lineup {
  total: number;
  /** One entry per slot, in slot order: the player's ID, or null if left empty. */
  playerIds: (string | null)[];
}

/**
 * Fills lineup slots for the highest total value. Exact (the Hungarian
 * method), and fast enough to run many thousands of times.
 *
 * `eligible[player][slot]` says who may play where. Returns the total and,
 * for each slot, the index of the chosen player or -1 for an empty slot.
 */
export function assignSlots(
  eligible: boolean[][],
  values: ArrayLike<number>,
  slotCount: number,
): { total: number; picks: number[] } {
  const players = eligible.length;
  const rows = slotCount;
  const cols = Math.max(players, rows); // padded so every slot can stay empty
  // Cost of putting column j in row i. An ineligible or padded column costs
  // nothing, which is the same as leaving the slot empty.
  const cost = (i: number, j: number) => (j < players && eligible[j]![i] ? -values[j]! : 0);

  const u = new Float64Array(rows + 1);
  const v = new Float64Array(cols + 1);
  const match = new Int32Array(cols + 1); // row matched to each column, 1-based
  const way = new Int32Array(cols + 1);
  const minv = new Float64Array(cols + 1);
  const used = new Uint8Array(cols + 1);
  for (let i = 1; i <= rows; i++) {
    match[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = match[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const current = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (current < minv[j]!) {
          minv[j] = current;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[match[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (match[j0] !== 0);
    do {
      const j1 = way[j0]!;
      match[j0] = match[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const picks = new Array<number>(rows).fill(-1);
  let total = 0;
  for (let j = 1; j <= cols; j++) {
    const row = match[j]! - 1;
    if (row < 0 || j - 1 >= players || !eligible[j - 1]![row]) continue;
    picks[row] = j - 1;
    total += values[j - 1]!;
  }
  return { total, picks };
}

/** The assignment of players to slots with the highest total value. */
export function bestLineup(slots: string[], candidates: Candidate[]): Lineup {
  const eligible = candidates.map((player) => slots.map((slot) => slotAccepts(slot, player.positions)));
  const { total, picks } = assignSlots(eligible, candidates.map((player) => player.value), slots.length);
  return { total, playerIds: picks.map((index) => (index >= 0 ? candidates[index]!.id : null)) };
}

/** Everyone on a team: starters, bench and injured reserve. */
export function rosterPlayers(team: Team): PlayerRef[] {
  return [
    ...team.starters.flatMap((starter) => (starter.player ? [starter.player] : [])),
    ...team.bench,
    ...team.reserve,
  ];
}
