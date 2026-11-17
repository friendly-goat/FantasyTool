import { assignSlots, rosterPlayers, slotAccepts, startingSlots } from "./analysis.ts";
import { lockInValue } from "./lockin.ts";
import type { LeagueSnapshot, PlayerRef, PlayerStats, StatsReport } from "./types.ts";

const POSITIONS = ["PG", "SG", "SF", "PF", "C"];

// Team strength for the rest of the season, on a scale of 1 to 1000.
//
// The core number is a team's PROJECTED WEEKLY SCORE: the points it is
// expected to lock in an average week. It is found by playing out many
// imaginary weeks, day by day, the way a lock-in week is actually managed:
//
//   * Each NBA team has 2, 3 or 4 games on set days. A player plays each of
//     his team's games as often as he is expected to, and scores around his
//     projected level, with his own game-to-game spread.
//   * Each day, the manager puts the players who have a game into the open
//     starting slots, best first. The lineup set in Sleeper is ignored: the
//     model assumes the best possible lineup every day.
//   * After the games, a slot is locked when its score beats what that slot
//     can still expect from the rest of the week, from everyone left on the
//     roster. A locked slot and its player are done for the week.
//   * At the end of the week an open slot keeps the last game played in it.
//
// Because open slots can be filled by different players on different days,
// bench players are extra chances at a big game, not just injury cover. A
// deep bench raises the projection; how much is reported as "bench adds".
//
// The 1 to 1000 scale is fixed by two reference rosters from the same league:
//   1    = a roster of the best free agents
//   1000 = the league's best players on one roster
//
// Every player sees the same imaginary weeks on any roster, so comparing a
// roster before and after a trade is not blurred by luck, and results are
// identical on every run.

export const SIMULATED_WEEKS = 200;
const DAYS = 7;
const MAX_GAMES = 4;
/** Share of weeks in which an NBA team plays this many games. */
const WEEK_SHAPES = [
  { games: 2, share: 0.1 },
  { games: 3, share: 0.55 },
  { games: 4, share: 0.35 },
];
/** Players with few games, and no last season to lean on, are pulled toward a replacement-level player. */
const RELIABILITY_GAMES = 3;
/**
 * Game-to-game spread, as a share of a player's average. Measured from his
 * own games, blended with the league's typical spread until he has played
 * enough, and kept between these limits.
 */
const SPREAD_WEIGHT_GAMES = 6;
const SPREAD_LIMITS = [0.1, 0.6] as const;
/** E[(X - mean)+] for a normal distribution is 0.3989 standard deviations. */
const HALF_MEAN_DEVIATION = 0.3989;
/** Standard normal quantiles used to turn a spread into lock-in values. */
const QUANTILES = Array.from({ length: 25 }, (_, index) => normalQuantile((index + 0.5) / 25));

export interface ModelPlayer extends PlayerRef {
  games: number;
  /** Fantasy points per game so far, which is what other managers see. */
  average: number;
  /** Projected fantasy points per game for the rest of the season. */
  projected: number;
  longTermOut: boolean;
  /** Share of his team's games he is expected to play. */
  availability: number;
  /** Game-to-game spread as a share of his projected level. */
  spread: number;
  /** Expected locked score on his own in a week where he plays every game. */
  healthy: number;
  /** Expected locked score on his own in an average week, allowing for missed games. */
  expected: number;
  /** Which lineup slots he may fill, in slot order. */
  eligible: boolean[];
  /** Expected locked score with 0, 1, 2, 3 or 4 games left to choose from. */
  waitValue: Float64Array;
  /** Per imaginary week, up to four games: the day (-1 for none) and the score. */
  gameDay: Int8Array;
  gameScore: Float32Array;
}

export interface StrengthModel {
  slots: string[];
  /** Slot indices from the most restrictive (one position) to the least (UTIL). */
  slotOrder: number[];
  weeks: number;
  players: Map<string, ModelPlayer>;
  /** Free agents, most valuable first. */
  freeAgentIds: string[];
  /** Projected weekly score of the two reference rosters. */
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

/** A repeatable number in [0, 1) for a seed, a week and a purpose. */
function uniform(seed: number, week: number, purpose: number): number {
  let t = (seed + Math.imul(week + 1, 0x9e3779b1) + Math.imul(purpose + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Inverse of the standard normal distribution (Acklam's approximation). */
function normalQuantile(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Expected locked score with 0 to 4 games left, for a level and spread. */
function waitValues(level: number, spread: number): Float64Array {
  const scores = QUANTILES.map((z) => Math.max(0, level * (1 + spread * z)));
  const values = new Float64Array(MAX_GAMES + 1);
  for (let games = 1; games <= MAX_GAMES; games++) values[games] = lockInValue(scores, games);
  return values;
}

function binomial(k: number, n: number, p: number): number {
  let ways = 1;
  for (let i = 0; i < k; i++) ways = (ways * (n - i)) / (i + 1);
  return ways * p ** k * (1 - p) ** (n - k);
}

/** Each NBA team's games for each imaginary week: team -> days, MAX_GAMES per week (-1 for none). */
function teamSchedule(team: string, weeks: number): Int8Array {
  const seed = hash(`team:${team}`);
  const days = new Int8Array(weeks * MAX_GAMES).fill(-1);
  for (let week = 0; week < weeks; week++) {
    let roll = uniform(seed, week, 0);
    let count = WEEK_SHAPES[WEEK_SHAPES.length - 1]!.games;
    for (const shape of WEEK_SHAPES) {
      if (roll < shape.share) {
        count = shape.games;
        break;
      }
      roll -= shape.share;
    }
    // Pick `count` distinct days, kept in order.
    const pool = [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i < DAYS - 1; i++) {
      const j = i + Math.floor(uniform(seed, week, i + 1) * (DAYS - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    pool.slice(0, count).sort((x, y) => x - y).forEach((day, game) => {
      days[week * MAX_GAMES + game] = day;
    });
  }
  return days;
}

interface PlayerInputs {
  level: number;
  spread: number;
  availability: number;
}

function finishPlayer(
  ref: PlayerRef,
  base: Pick<ModelPlayer, "games" | "average" | "projected" | "longTermOut">,
  inputs: PlayerInputs,
  slots: string[],
  schedule: Int8Array,
  weeks: number,
): ModelPlayer {
  const { level, spread, availability } = inputs;
  const seed = hash(ref.id);
  const waitValue = waitValues(level, spread);
  const gameDay = new Int8Array(weeks * MAX_GAMES).fill(-1);
  const gameScore = new Float32Array(weeks * MAX_GAMES);
  for (let week = 0; week < weeks; week++) {
    let slot = 0;
    for (let game = 0; game < MAX_GAMES; game++) {
      const day = schedule[week * MAX_GAMES + game]!;
      if (day < 0 || uniform(seed, week, 10 + game) >= availability) continue;
      // A normal draw around his level, never below zero.
      const u1 = Math.max(1e-9, uniform(seed, week, 20 + 2 * game));
      const u2 = uniform(seed, week, 21 + 2 * game);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      gameDay[week * MAX_GAMES + slot] = day;
      gameScore[week * MAX_GAMES + slot] = Math.max(0, level * (1 + spread * z));
      slot++;
    }
  }
  let healthy = 0;
  let expected = 0;
  for (const shape of WEEK_SHAPES) {
    healthy += shape.share * waitValue[shape.games]!;
    for (let played = 1; played <= shape.games; played++) {
      expected += shape.share * binomial(played, shape.games, availability) * waitValue[played]!;
    }
  }
  return {
    ...ref,
    ...base,
    availability,
    spread,
    healthy,
    expected,
    eligible: slots.map((slot) => slotAccepts(slot, ref.positions)),
    waitValue,
    gameDay,
    gameScore,
  };
}

/** Spread from a player's own games: lock-in value with two games minus one. */
function ownSpread(stats: PlayerStats): number | null {
  const [one, two] = stats.lockInByGames;
  if (one === undefined || two === undefined || one <= 0 || stats.games < 2) return null;
  return (two - one) / HALF_MEAN_DEVIATION / one;
}

export function buildModel(
  snapshot: LeagueSnapshot,
  report: StatsReport,
  weeks: number = SIMULATED_WEEKS,
): StrengthModel {
  const slots = startingSlots(snapshot);
  const breadth = (slot: string) => POSITIONS.filter((position) => slotAccepts(slot, [position])).length;
  const slotOrder = slots.map((_, index) => index).sort((a, b) => breadth(slots[a]!) - breadth(slots[b]!));
  const rosterRefs = snapshot.teams.flatMap(rosterPlayers);
  const rostered = new Set(rosterRefs.map((player) => player.id));
  const all = Object.values(report.players);

  // Replacement level: the middle one of the best free agents, one per team.
  const bestFree = all
    .filter((player) => !rostered.has(player.id))
    .sort((a, b) => b.projection.perGame - a.projection.perGame)
    .slice(0, Math.max(1, snapshot.teams.length));
  const replacementLevel = bestFree[Math.floor(bestFree.length / 2)]?.projection.perGame ?? 0;
  // The league's typical spread: the middle value among players with enough games.
  const spreads = all
    .filter((player) => player.games >= SPREAD_WEIGHT_GAMES)
    .flatMap((player) => ownSpread(player) ?? [])
    .sort((a, b) => a - b);
  const typicalSpread = spreads[Math.floor(spreads.length / 2)] ?? 0.25;

  const schedules = new Map<string, Int8Array>();
  const scheduleFor = (team: string) => {
    if (!schedules.has(team)) schedules.set(team, teamSchedule(team, weeks));
    return schedules.get(team)!;
  };

  const players = new Map<string, ModelPlayer>();
  for (const stats of all) {
    let level = stats.projection.perGame;
    if (!stats.projection.lastSeason) {
      const trust = stats.games / (stats.games + RELIABILITY_GAMES);
      level = trust * level + (1 - trust) * replacementLevel;
    }
    const own = ownSpread(stats);
    const weight = own === null ? 0 : stats.games / (stats.games + SPREAD_WEIGHT_GAMES);
    const spread = Math.min(SPREAD_LIMITS[1], Math.max(SPREAD_LIMITS[0], weight * (own ?? 0) + (1 - weight) * typicalSpread));
    players.set(
      stats.id,
      finishPlayer(
        stats,
        { games: stats.games, average: stats.fantasyAvg, projected: stats.projection.perGame, longTermOut: stats.longTermOut },
        { level, spread, availability: stats.availability },
        slots,
        scheduleFor(stats.team ?? `none:${stats.id}`),
        weeks,
      ),
    );
  }
  for (const ref of rosterRefs) {
    if (players.has(ref.id)) continue;
    players.set(
      ref.id,
      finishPlayer(
        ref,
        { games: 0, average: 0, projected: 0, longTermOut: false },
        { level: 0, spread: 0, availability: 0 },
        slots,
        scheduleFor(ref.team ?? `none:${ref.id}`),
        weeks,
      ),
    );
  }

  const freeAgentIds = [...players.values()]
    .filter((player) => !rostered.has(player.id) && player.games > 0)
    .sort((a, b) => b.expected - a.expected)
    .map((player) => player.id);

  const model: StrengthModel = {
    slots, slotOrder, weeks, players, freeAgentIds, replacementProjection: 0, idealProjection: 0,
  };
  const rosterSize = Math.max(slots.length, Math.round(rosterRefs.length / Math.max(1, snapshot.teams.length)));
  model.replacementProjection = projectedWeekly(model, freeAgentIds.slice(0, rosterSize));
  const best = [...players.values()].sort((a, b) => b.expected - a.expected).slice(0, rosterSize);
  model.idealProjection = projectRoster(model, best);
  return model;
}

/** A made-up player at a fixed level who plays three games every week, for what-if checks. */
export function steadyPlayer(model: StrengthModel, id: string, positions: string[], level: number): ModelPlayer {
  const schedule = new Int8Array(model.weeks * MAX_GAMES).fill(-1);
  for (let week = 0; week < model.weeks; week++) {
    [1, 3, 5].forEach((day, game) => {
      schedule[week * MAX_GAMES + game] = day;
    });
  }
  return finishPlayer(
    { id, name: id, team: null, positions, injuryStatus: null },
    { games: 1, average: level, projected: level, longTermOut: false },
    { level, spread: 0, availability: 1 },
    model.slots,
    schedule,
    model.weeks,
  );
}

// ---- The week, day by day -------------------------------------------------

/** Working space for simulating one roster, reused across weeks to keep it fast. */
interface Scratch {
  open: Uint8Array;
  last: Float64Array;
  lastBy: Int32Array;
  done: Uint8Array;
  waits: Float64Array;
  today: Float64Array;
  taken: Uint8Array;
  used: Uint8Array;
  placedPlayer: Int32Array;
  placedSlot: Int32Array;
  byLevel: number[];
  byWait: number[];
}

function scratchFor(model: StrengthModel, roster: ModelPlayer[]): Scratch {
  const n = roster.length;
  const slots = model.slots.length;
  return {
    open: new Uint8Array(slots),
    last: new Float64Array(slots),
    lastBy: new Int32Array(slots),
    done: new Uint8Array(n),
    waits: new Float64Array(n),
    today: new Float64Array(n),
    taken: new Uint8Array(slots),
    used: new Uint8Array(slots),
    placedPlayer: new Int32Array(slots),
    placedSlot: new Int32Array(slots),
    // Players by level, best first, for placing them in slots.
    byLevel: roster.map((_, index) => index).sort((a, b) => roster[b]!.waitValue[1]! - roster[a]!.waitValue[1]!),
    byWait: roster.map((_, index) => index),
  };
}

/**
 * Best total of "wait values" that the open slots can still expect, filling
 * the most restrictive slots first. A quick estimate used only to decide
 * whether a game is worth locking; the score itself is always simulated.
 */
function stillToCome(model: StrengthModel, roster: ModelPlayer[], work: Scratch, skipPlayer: number, skipSlot: number): number {
  const { waits, open, used, byWait } = work;
  used.fill(0);
  let total = 0;
  for (const index of byWait) {
    if (waits[index]! <= 0) break; // sorted, so nobody after this has anything left
    if (index === skipPlayer) continue;
    const eligible = roster[index]!.eligible;
    for (const slot of model.slotOrder) {
      if (slot === skipSlot || !open[slot] || used[slot] || !eligible[slot]) continue;
      used[slot] = 1;
      total += waits[index]!;
      break;
    }
  }
  return total;
}

export interface WeekResult {
  total: number;
  /** For each slot, the roster index of the player whose game counted, or -1. */
  lockedBy: number[];
}

/** Plays out one imaginary week for a roster and returns its locked score. */
export function simulateWeek(
  model: StrengthModel,
  roster: ModelPlayer[],
  week: number,
  work: Scratch = scratchFor(model, roster),
): WeekResult {
  const slotCount = model.slots.length;
  const n = roster.length;
  const { open, last, lastBy, done, waits, today, taken, placedPlayer, placedSlot, byLevel, byWait } = work;
  open.fill(1);
  last.fill(0);
  lastBy.fill(-1);
  done.fill(0);
  const lockedBy = new Array<number>(slotCount).fill(-1);
  const base = week * MAX_GAMES;
  let total = 0;

  for (let day = 0; day < DAYS; day++) {
    // Who plays today, and what each player is worth with the games he has left after today.
    let anyone = false;
    for (let i = 0; i < n; i++) {
      today[i] = -1;
      if (done[i]) {
        waits[i] = 0;
        continue;
      }
      const player = roster[i]!;
      let after = 0;
      for (let game = 0; game < MAX_GAMES; game++) {
        const gameDay = player.gameDay[base + game]!;
        if (gameDay === day) {
          today[i] = player.gameScore[base + game]!;
          anyone = true;
        } else if (gameDay > day) {
          after++;
        }
      }
      waits[i] = player.waitValue[after]!;
    }
    if (!anyone) continue;

    // Put today's players into open slots, best players first, tightest slots first.
    let placed = 0;
    taken.fill(0);
    for (const i of byLevel) {
      if (today[i]! < 0) continue;
      for (const slot of model.slotOrder) {
        if (!open[slot] || taken[slot] || !roster[i]!.eligible[slot]) continue;
        taken[slot] = 1;
        placedPlayer[placed] = i;
        placedSlot[placed] = slot;
        placed++;
        break;
      }
    }
    if (placed === 0) continue;

    // Decide the day's best games first.
    for (let a = 1; a < placed; a++) {
      const player = placedPlayer[a]!;
      const slot = placedSlot[a]!;
      let b = a - 1;
      while (b >= 0 && today[placedPlayer[b]!]! < today[player]!) {
        placedPlayer[b + 1] = placedPlayer[b]!;
        placedSlot[b + 1] = placedSlot[b]!;
        b--;
      }
      placedPlayer[b + 1] = player;
      placedSlot[b + 1] = slot;
    }

    // Lock a game when it beats what the slot can still expect from the rest of the week.
    byWait.sort((x, y) => waits[y]! - waits[x]!);
    for (let k = 0; k < placed; k++) {
      const player = placedPlayer[k]!;
      const slot = placedSlot[k]!;
      const score = today[player]!;
      const threshold = stillToCome(model, roster, work, -1, -1) - stillToCome(model, roster, work, player, slot);
      if (score >= threshold) {
        open[slot] = 0;
        done[player] = 1;
        waits[player] = 0;
        byWait.sort((x, y) => waits[y]! - waits[x]!);
        lockedBy[slot] = player;
        total += score;
      } else {
        last[slot] = score;
        lastBy[slot] = player;
      }
    }
  }

  // An open slot keeps the last game played in it.
  for (let slot = 0; slot < slotCount; slot++) {
    if (!open[slot]) continue;
    total += last[slot]!;
    lockedBy[slot] = lastBy[slot]!;
  }
  return { total, lockedBy };
}

const memo = new WeakMap<StrengthModel, Map<string, number>>();

/** Average weekly score over the imaginary weeks (or the first `weeks` of them). */
export function projectedWeekly(model: StrengthModel, playerIds: string[], weeks?: number): number {
  const count = Math.min(weeks ?? model.weeks, model.weeks);
  const key = `${count}|${[...playerIds].sort().join(",")}`;
  let cache = memo.get(model);
  if (!cache) memo.set(model, (cache = new Map()));
  const known = cache.get(key);
  if (known !== undefined) return known;
  const value = projectRoster(model, playerIds.flatMap((id) => model.players.get(id) ?? []), count);
  if (cache.size > 5000) cache.clear();
  cache.set(key, value);
  return value;
}

/** The same, for a list of players rather than IDs. */
export function projectRoster(model: StrengthModel, roster: ModelPlayer[], weeks?: number): number {
  const count = Math.min(weeks ?? model.weeks, model.weeks);
  if (count === 0 || roster.length === 0) return 0;
  const work = scratchFor(model, roster);
  let total = 0;
  for (let week = 0; week < count; week++) total += simulateWeek(model, roster, week, work).total;
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
  /** Projected weekly score of the best legal nine alone, with no bench to rotate in. */
  bestNine: number;
  /** What the rest of the roster adds: rotating into open slots and covering missed games. */
  benchAdds: number;
  /** The best nine's combined value if each locked only his own games and never missed one. */
  fullHealth: number;
  /** Average share of games the best nine are expected to play. */
  starterAvailability: number;
}

export function rosterStrength(model: StrengthModel, playerIds: string[]): Omit<TeamStrength, "rosterId" | "rank"> {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const lineup = assignSlots(
    roster.map((player) => player.eligible),
    roster.map((player) => player.healthy),
    model.slots.length,
  );
  const starters = lineup.picks.filter((index) => index >= 0).map((index) => roster[index]!);
  const projected = projectedWeekly(model, playerIds);
  const bestNine = projectedWeekly(model, starters.map((player) => player.id));
  return {
    score: strengthScore(model, projected),
    projected,
    bestNine,
    benchAdds: projected - bestNine,
    fullHealth: lineup.total,
    starterAvailability:
      starters.length > 0 ? starters.reduce((sum, player) => sum + player.availability, 0) / starters.length : 0,
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
