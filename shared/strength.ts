import { assignSlots, rosterPlayers, slotAccepts, startingSlots } from "./analysis.ts";
import type { LeagueSnapshot, PlayerRef, PlayerStats, StatsReport } from "./types.ts";

// Team strength for the rest of the season, on a scale of 1 to 1000.
//
// The core number is a team's PROJECTED WEEKLY SCORE: the points its best
// lineup is expected to lock in an average week, allowing for the fact that
// players miss games. It is found by playing out many imaginary weeks:
//
//   1. For each player, decide how many games he plays that week. His team
//      has 2, 3 or 4 games (in the proportions NBA schedules have), and he
//      appears in each with the frequency he has shown this season.
//   2. His value that week is his lock-in value for that many games
//      (shared/lockin.ts), or nothing if he plays none.
//   3. The team fields its best legal lineup from whoever is available.
//
// Averaged over all weeks, this one number reflects star power, positional
// fit, bench depth and durability together: a deep bench only matters in the
// weeks a starter is missing, and those weeks are in the average.
//
// The 1 to 1000 scale is fixed by two reference teams in the same league:
//   1    = a team built entirely from the best free agents
//   1000 = the nine best players in the league, never missing a game
//
// Every player sees the same imaginary weeks no matter which team he is on,
// so comparing a roster before and after a trade is not blurred by luck.

export const SIMULATED_WEEKS = 200;
/** Share of weeks in which an NBA team plays this many games. */
const WEEK_SHAPES = [
  { games: 2, share: 0.1 },
  { games: 3, share: 0.55 },
  { games: 4, share: 0.35 },
];
/** Early in a season "played 3 of 3" proves little: blend in a typical rate. */
const AVAILABILITY_PRIOR = { rate: 0.85, games: 5 };
/** Players with few games are pulled toward a replacement-level player. */
const RELIABILITY_GAMES = 3;

export interface ModelPlayer extends PlayerRef {
  games: number;
  /** Fantasy points per game, for display. */
  average: number;
  /** Share of his team's games he is expected to play. */
  availability: number;
  /** Expected weekly value if he never missed a game. */
  healthy: number;
  /** Expected weekly value allowing for missed games. */
  expected: number;
  /** Which lineup slots he may fill, in slot order. */
  eligible: boolean[];
  /** His value in each imaginary week. */
  weeks: Float64Array;
}

export interface StrengthModel {
  slots: string[];
  players: Map<string, ModelPlayer>;
  /** Free agents, most valuable first. */
  freeAgentIds: string[];
  /** Projected weekly score of the two reference teams. */
  replacementProjection: number;
  idealProjection: number;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A repeatable number in [0, 1) for a player, a week and a purpose. */
function uniform(seed: number, week: number, purpose: number): number {
  let t = (seed + Math.imul(week + 1, 0x9e3779b1) + Math.imul(purpose + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function modelPlayer(
  ref: PlayerRef,
  stats: PlayerStats | undefined,
  slots: string[],
  replacementValue: number,
  weeks: number,
): ModelPlayer {
  const eligible = slots.map((slot) => slotAccepts(slot, ref.positions));
  const draws = new Float64Array(weeks);
  if (!stats || stats.games === 0) {
    return { ...ref, games: 0, average: 0, availability: 0, healthy: 0, expected: 0, eligible, weeks: draws };
  }

  // Pull thin samples toward a replacement-level player.
  const trust = stats.games / (stats.games + RELIABILITY_GAMES);
  const typical = stats.lockInByGames[2] ?? stats.lockInValue;
  const scale = typical > 0 ? trust + ((1 - trust) * replacementValue) / typical : 1;
  const byGames = stats.lockInByGames.map((value) => value * scale);

  const availability = Math.min(
    1,
    (stats.games + AVAILABILITY_PRIOR.rate * AVAILABILITY_PRIOR.games) /
      (Math.max(stats.teamGames, stats.games) + AVAILABILITY_PRIOR.games),
  );

  const seed = hash(ref.id);
  let sum = 0;
  for (let week = 0; week < weeks; week++) {
    let roll = uniform(seed, week, 0);
    let scheduled = WEEK_SHAPES[WEEK_SHAPES.length - 1]!.games;
    for (const shape of WEEK_SHAPES) {
      if (roll < shape.share) {
        scheduled = shape.games;
        break;
      }
      roll -= shape.share;
    }
    let played = 0;
    for (let game = 0; game < scheduled; game++) {
      if (uniform(seed, week, game + 1) < availability) played++;
    }
    draws[week] = played > 0 ? (byGames[Math.min(played, byGames.length) - 1] ?? 0) : 0;
    sum += draws[week]!;
  }

  const healthy = WEEK_SHAPES.reduce(
    (total, shape) => total + shape.share * (byGames[Math.min(shape.games, byGames.length) - 1] ?? 0),
    0,
  );
  return {
    ...ref,
    games: stats.games,
    average: stats.fantasyAvg,
    availability,
    healthy,
    expected: weeks > 0 ? sum / weeks : 0,
    eligible,
    weeks: draws,
  };
}

export function buildModel(
  snapshot: LeagueSnapshot,
  report: StatsReport,
  weeks: number = SIMULATED_WEEKS,
): StrengthModel {
  const slots = startingSlots(snapshot);
  const rosterRefs = snapshot.teams.flatMap(rosterPlayers);
  const rostered = new Set(rosterRefs.map((player) => player.id));

  // Replacement level: the middle one of the best free agents, one per team.
  const bestFree = Object.values(report.players)
    .filter((player) => !rostered.has(player.id))
    .sort((a, b) => b.lockInValue - a.lockInValue)
    .slice(0, Math.max(1, snapshot.teams.length));
  const replacementValue = bestFree[Math.floor(bestFree.length / 2)]?.lockInValue ?? 0;

  const players = new Map<string, ModelPlayer>();
  for (const stats of Object.values(report.players)) {
    players.set(stats.id, modelPlayer(stats, stats, slots, replacementValue, weeks));
  }
  for (const ref of rosterRefs) {
    if (!players.has(ref.id)) players.set(ref.id, modelPlayer(ref, undefined, slots, replacementValue, weeks));
  }

  const freeAgentIds = [...players.values()]
    .filter((player) => !rostered.has(player.id) && player.games > 0)
    .sort((a, b) => b.expected - a.expected)
    .map((player) => player.id);

  const model: StrengthModel = { slots, players, freeAgentIds, replacementProjection: 0, idealProjection: 0 };

  const rosterSize = Math.max(slots.length, Math.round(rosterRefs.length / Math.max(1, snapshot.teams.length)));
  model.replacementProjection = projectedWeekly(model, freeAgentIds.slice(0, rosterSize));
  const everyone = [...players.values()];
  model.idealProjection = assignSlots(
    everyone.map((player) => player.eligible),
    everyone.map((player) => player.healthy),
    slots.length,
  ).total;
  return model;
}

/** Average best-lineup score over the imaginary weeks (or the first `weeks` of them). */
export function projectedWeekly(model: StrengthModel, playerIds: string[], weeks?: number): number {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const eligible = roster.map((player) => player.eligible);
  const count = Math.min(weeks ?? Infinity, roster[0]?.weeks.length ?? 0);
  if (count === 0) return 0;
  const values = new Float64Array(roster.length);
  let total = 0;
  for (let week = 0; week < count; week++) {
    for (let index = 0; index < roster.length; index++) values[index] = roster[index]!.weeks[week]!;
    total += assignSlots(eligible, values, model.slots.length).total;
  }
  return total / count;
}

/** Converts a projected weekly score to the 1 to 1000 scale. */
export function strengthScore(model: StrengthModel, projected: number): number {
  const span = model.idealProjection - model.replacementProjection;
  if (span <= 0) return 1;
  const share = (projected - model.replacementProjection) / span;
  return Math.round(1 + 999 * Math.min(1, Math.max(0, share)));
}

export interface TeamStrength {
  rosterId: number;
  rank: number;
  /** 1 to 1000. */
  score: number;
  /** Projected weekly score, the number behind `score`. */
  projected: number;
  /** Best lineup's value if nobody ever missed a game. */
  fullHealth: number;
  /** Points per week lost to missed games, after the bench fills in. */
  lostToAbsences: number;
  /** Average share of games the full-health starters are expected to play. */
  starterAvailability: number;
  /** Combined value of the three best players outside the full-health lineup. */
  bench: number;
}

export function rosterStrength(model: StrengthModel, playerIds: string[]): Omit<TeamStrength, "rosterId" | "rank"> {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const lineup = assignSlots(
    roster.map((player) => player.eligible),
    roster.map((player) => player.healthy),
    model.slots.length,
  );
  const starters = lineup.picks.filter((index) => index >= 0).map((index) => roster[index]!);
  const starting = new Set(starters.map((player) => player.id));
  const bench = roster
    .filter((player) => !starting.has(player.id))
    .map((player) => player.healthy)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, value) => sum + value, 0);
  const projected = projectedWeekly(model, playerIds);
  return {
    score: strengthScore(model, projected),
    projected,
    fullHealth: lineup.total,
    lostToAbsences: lineup.total - projected,
    starterAvailability:
      starters.length > 0 ? starters.reduce((sum, player) => sum + player.availability, 0) / starters.length : 0,
    bench,
  };
}

/** Every team's strength, strongest first. */
export function leagueStrength(snapshot: LeagueSnapshot, model: StrengthModel): TeamStrength[] {
  return snapshot.teams
    .map((team) => ({
      rosterId: team.rosterId,
      rank: 0,
      ...rosterStrength(model, rosterPlayers(team).map((player) => player.id)),
    }))
    .sort((a, b) => b.projected - a.projected)
    .map((strength, index) => ({ ...strength, rank: index + 1 }));
}
