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
 * The assignment of players to slots with the highest total value.
 * Exact, not greedy: it tries every way of filling the slots, remembering
 * results for each set of players already used.
 */
export function bestLineup(slots: string[], candidates: Candidate[]): Lineup {
  // More than ~20 candidates is never needed: only the best few per slot matter.
  const pool = [...candidates].sort((a, b) => b.value - a.value).slice(0, 20);
  const memo = new Map<number, { total: number; pick: number }>();

  const solve = (slotIndex: number, used: number): number => {
    if (slotIndex === slots.length) return 0;
    const key = slotIndex * (1 << 20) + used;
    const known = memo.get(key);
    if (known) return known.total;

    let best = { total: solve(slotIndex + 1, used), pick: -1 }; // leave the slot empty
    for (let index = 0; index < pool.length; index++) {
      const player = pool[index]!;
      if (used & (1 << index) || !slotAccepts(slots[slotIndex]!, player.positions)) continue;
      const total = player.value + solve(slotIndex + 1, used | (1 << index));
      if (total > best.total) best = { total, pick: index };
    }
    memo.set(key, best);
    return best.total;
  };

  const total = solve(0, 0);
  const playerIds: (string | null)[] = [];
  let used = 0;
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const pick = memo.get(slotIndex * (1 << 20) + used)?.pick ?? -1;
    playerIds.push(pick >= 0 ? pool[pick]!.id : null);
    if (pick >= 0) used |= 1 << pick;
  }
  return { total, playerIds };
}

/** Everyone on a team: starters, bench and injured reserve. */
export function rosterPlayers(team: Team): PlayerRef[] {
  return [
    ...team.starters.flatMap((starter) => (starter.player ? [starter.player] : [])),
    ...team.bench,
    ...team.reserve,
  ];
}

/** Players who can be put in a lineup: not on injured reserve and not ruled out. */
function available(team: Team): PlayerRef[] {
  const onReserve = new Set(team.reserve.map((player) => player.id));
  return rosterPlayers(team).filter(
    (player) => !onReserve.has(player.id) && player.injuryStatus?.toUpperCase() !== "OUT",
  );
}

function candidate(player: PlayerRef, stats: Record<string, PlayerStats>): Candidate {
  return { id: player.id, positions: player.positions, value: stats[player.id]?.lockInValue ?? 0 };
}

export interface TeamOutlook {
  rosterId: number;
  /** Combined lock-in value of the lineup as currently set. */
  currentValue: number;
  /** Combined lock-in value of the best lineup the roster allows. */
  bestValue: number;
  best: Lineup;
}

export function teamOutlook(team: Team, slots: string[], stats: Record<string, PlayerStats>): TeamOutlook {
  const best = bestLineup(slots, available(team).map((player) => candidate(player, stats)));
  const currentValue = team.starters.reduce(
    (sum, starter) => sum + (starter.player ? (stats[starter.player.id]?.lockInValue ?? 0) : 0),
    0,
  );
  return { rosterId: team.rosterId, currentValue, bestValue: best.total, best };
}

/** Every team's outlook, strongest best lineup first. */
export function leagueOutlook(snapshot: LeagueSnapshot, report: StatsReport): TeamOutlook[] {
  const slots = startingSlots(snapshot);
  return snapshot.teams
    .map((team) => teamOutlook(team, slots, report.players))
    .sort((a, b) => b.bestValue - a.bestValue);
}

export interface Upgrade {
  player: PlayerStats;
  /** How much the team's best lineup improves with this player on the roster. */
  gain: number;
  /** The slot he would take in the new best lineup. */
  slot: string;
}

/** Free agents who would raise a team's best lineup, biggest gain first. */
export function freeAgentUpgrades(
  team: Team,
  snapshot: LeagueSnapshot,
  report: StatsReport,
  limit = 5,
): Upgrade[] {
  const slots = startingSlots(snapshot);
  const rostered = new Set(snapshot.teams.flatMap((other) => rosterPlayers(other).map((player) => player.id)));
  const base = available(team).map((player) => candidate(player, report.players));
  const current = bestLineup(slots, base);
  const weakest = Math.min(...current.playerIds.map((id) => (id ? (report.players[id]?.lockInValue ?? 0) : 0)));

  const upgrades: Upgrade[] = [];
  const freeAgents = Object.values(report.players)
    .filter(
      (player) =>
        !rostered.has(player.id) &&
        player.lockInValue > weakest && // cannot help otherwise
        player.injuryStatus?.toUpperCase() !== "OUT",
    )
    .sort((a, b) => b.lockInValue - a.lockInValue)
    .slice(0, 40);
  for (const player of freeAgents) {
    const withPlayer = bestLineup(slots, [...base, candidate(player, report.players)]);
    const slotIndex = withPlayer.playerIds.indexOf(player.id);
    const gain = withPlayer.total - current.total;
    if (slotIndex >= 0 && gain > 0.005) upgrades.push({ player, gain, slot: slots[slotIndex]! });
  }
  return upgrades.sort((a, b) => b.gain - a.gain).slice(0, limit);
}
