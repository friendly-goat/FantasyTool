import { assignSlots, rosterPlayers, slotAccepts, startingSlots } from "./analysis.ts";
import { lockInValue } from "./lockin.ts";
import { returnOutlook, weeklyChanceBack } from "./injury.ts";
import type { LeagueSnapshot, PlayerRef, PlayerStats, ReserveAllows, StatsReport } from "./types.ts";
import { weekRange } from "./weeks.ts";

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
//
// The imaginary weeks also stand for the real weeks left in the regular
// season, in turn (imaginary week w is real week w mod the weeks left). That
// is how an injury with a return date counts: he plays none of the weeks he
// is out and his usual share once he is back (shared/injury.ts), so a player
// out four of eighteen weeks is worth about fourteen eighteenths of himself.

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
  /** Chance he is back, for each real week left (the model's calendar); null when he is not out with a return date. */
  back: Float32Array | null;
  /** Share of the weeks left he is expected to miss through his injury: 0 when he is not out with a date. */
  outShare: number;
  /** Middle of his return window (YYYY-MM-DD), "season" when he is out for it, or null. */
  returnExpected: string | null;
  /** He may sit in an injured reserve slot: Sleeper or the injury report lists him as out. */
  irEligible: boolean;
}

/** The real weeks the imaginary weeks stand for: from the current week to the end of the regular season. */
export interface ModelCalendar {
  /** The day the model was built for, YYYY-MM-DD. */
  today: string;
  weeks: { week: number; start: string; end: string }[];
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
  /** Weekly value of a typical pickup: the middle one of the best free agents, one per team. */
  replacementWeekly: number;
  calendar: ModelCalendar;
  /** Roster spots: active (starters and bench) and injured reserve. */
  rosterLimits: { active: number; reserve: number };
  /** Stand-in pickups made while a player is on injured reserve (see `standIn`), by ID. */
  extra: Map<string, ModelPlayer>;
}

/** A player by ID, including stand-ins. */
export function modelPlayer(model: StrengthModel, id: string): ModelPlayer | undefined {
  return model.players.get(id) ?? model.extra.get(id);
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
  /** Chance he is back, per real week left; null when he is not out with a return date. */
  back?: number[] | null;
  returnExpected?: string | null;
  irEligible?: boolean;
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
  const back = inputs.back && inputs.back.length > 0 ? inputs.back : null;
  const seed = hash(ref.id);
  const waitValue = waitValues(level, spread);
  const gameDay = new Int8Array(weeks * MAX_GAMES).fill(-1);
  const gameScore = new Float32Array(weeks * MAX_GAMES);
  for (let week = 0; week < weeks; week++) {
    let slot = 0;
    const playing = availability * (back ? back[week % back.length]! : 1);
    for (let game = 0; game < MAX_GAMES; game++) {
      const day = schedule[week * MAX_GAMES + game]!;
      if (day < 0 || uniform(seed, week, 10 + game) >= playing) continue;
      // A normal draw around his level, never below zero.
      const u1 = Math.max(1e-9, uniform(seed, week, 20 + 2 * game));
      const u2 = uniform(seed, week, 21 + 2 * game);
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      gameDay[week * MAX_GAMES + slot] = day;
      gameScore[week * MAX_GAMES + slot] = Math.max(0, level * (1 + spread * z));
      slot++;
    }
  }
  const expectedAt = (rate: number) => {
    let total = 0;
    for (const shape of WEEK_SHAPES) {
      for (let played = 1; played <= shape.games; played++) {
        total += shape.share * binomial(played, shape.games, rate) * waitValue[played]!;
      }
    }
    return total;
  };
  let healthy = 0;
  for (const shape of WEEK_SHAPES) healthy += shape.share * waitValue[shape.games]!;
  // An average week over the weeks left: with an injury, the weeks he is out count as zero.
  const meanBack = back ? back.reduce((sum, chance) => sum + chance, 0) / back.length : 1;
  const expected = back ? back.reduce((sum, chance) => sum + expectedAt(availability * chance), 0) / back.length : expectedAt(availability);
  return {
    ...ref,
    ...base,
    availability: availability * meanBack,
    spread,
    healthy,
    expected,
    eligible: slots.map((slot) => slotAccepts(slot, ref.positions)),
    waitValue,
    gameDay,
    gameScore,
    back: back ? Float32Array.from(back) : null,
    outShare: 1 - meanBack,
    returnExpected: inputs.returnExpected ?? null,
    irEligible: inputs.irEligible ?? false,
  };
}

/** Spread from a player's own games: lock-in value with two games minus one. */
function ownSpread(stats: PlayerStats): number | null {
  const [one, two] = stats.lockInByGames;
  if (one === undefined || two === undefined || one <= 0 || stats.games < 2) return null;
  return (two - one) / HALF_MEAN_DEVIATION / one;
}

/**
 * The real weeks left: the current week to the last week of the regular
 * season (the week before the playoffs start, from the league's settings).
 * Without a season start date there is no calendar, and injuries fall back
 * on how long a player has already been out.
 */
export function modelCalendar(snapshot: LeagueSnapshot): ModelCalendar {
  const today = snapshot.fetchedAt.slice(0, 10);
  const seasonStart = snapshot.league.seasonStartDate;
  const playoffStart = snapshot.league.playoffs?.startWeek;
  if (!seasonStart || !playoffStart || snapshot.week < 1) return { today, weeks: [] };
  const first = snapshot.week;
  const last = Math.max(first, playoffStart - 1);
  const weeks = Array.from({ length: last - first + 1 }, (_, index) => ({
    week: first + index,
    ...weekRange(seasonStart, first + index),
  }));
  return { today, weeks };
}

/** Games an NBA team plays in a typical week, to turn missed games into weeks. */
const GAMES_PER_WEEK = 3.5;
/** A player just ruled out, with no date and no run of missed games, is taken to miss this much of a week. */
const JUST_OUT_WEEKS = 0.5;

/** Chance back per week for a player marked out with no return date: out as long again as he has been. */
function undatedBack(stats: PlayerStats, weeks: number): number[] {
  const weeksOut = stats.longTermOut ? stats.missedStreak / GAMES_PER_WEEK : JUST_OUT_WEEKS;
  return Array.from({ length: weeks }, (_, index) => Math.min(1, Math.max(0, index + 1 - weeksOut)));
}

/**
 * Whether an injury status lets a player onto injured reserve, under the
 * league's rules (Sleeper: out by default; doubtful, suspended and
 * day-to-day only if the league allows them). Statuses come from Sleeper or
 * the injury report.
 */
export function reserveEligible(status: string | null | undefined, allows: ReserveAllows | undefined): boolean {
  const rules = allows ?? { out: true, doubtful: false, suspended: false, dayToDay: false };
  const value = (status ?? "").trim().toLowerCase();
  if (!value) return false;
  if (/^(out|o|ir|inj|injured reserve)$/.test(value)) return rules.out;
  if (value.startsWith("doubt")) return rules.doubtful;
  if (value.startsWith("sus")) return rules.suspended;
  if (value === "dtd" || value.startsWith("day")) return rules.dayToDay;
  return false;
}

export function buildModel(
  snapshot: LeagueSnapshot,
  report: StatsReport,
  weeks: number = SIMULATED_WEEKS,
): StrengthModel {
  const calendar = modelCalendar(snapshot);
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
    // With a return date, his usual share of games once back, week by week.
    // Marked out with no date: out as long again as he has been (half a week
    // if he has only just been ruled out). Otherwise the share that allows
    // for an absence still going on.
    // Sleeper allows injured reserve only for players marked out.
    const allows = snapshot.league.reserveAllows;
    const irEligible = reserveEligible(stats.injuryStatus, allows) || reserveEligible(stats.injury?.status, allows);
    const outlook = stats.injury ? returnOutlook(stats.injury) : null;
    let back = outlook ? weeklyChanceBack(outlook, calendar.weeks, calendar.today) : null;
    if (!back && irEligible && calendar.weeks.length > 0) back = undatedBack(stats, calendar.weeks.length);
    players.set(
      stats.id,
      finishPlayer(
        stats,
        {
          games: stats.games,
          // What other managers see: this season's average, or last season's before he has played.
          average: stats.games > 0 ? stats.fantasyAvg : (stats.projection.lastSeason?.average ?? 0),
          projected: stats.projection.perGame,
          longTermOut: stats.longTermOut,
        },
        {
          level,
          spread,
          availability: back ? (stats.playRate ?? stats.availability) : stats.availability,
          back,
          returnExpected: outlook?.kind === "season" ? "season" : outlook?.kind === "window" ? outlook.window.expected : null,
          irEligible,
        },
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
        { level: 0, spread: 0, availability: 0, irEligible: reserveEligible(ref.injuryStatus, snapshot.league.reserveAllows) },
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

  // Active spots are the starting and bench slots; IR slots come from the league settings.
  const positions = snapshot.league.rosterPositions.filter((slot) => slot !== "IR");
  const reserve = snapshot.league.reserveSlots ?? 0;
  const model: StrengthModel = {
    slots, slotOrder, weeks, players, freeAgentIds, replacementProjection: 0, idealProjection: 0,
    replacementWeekly: 0,
    calendar,
    rosterLimits: { active: positions.length > 0 ? positions.length : slots.length, reserve },
    extra: new Map(),
  };
  const pickups = freeAgentIds.slice(0, Math.max(1, snapshot.teams.length));
  model.replacementWeekly = players.get(pickups[Math.floor(pickups.length / 2)] ?? "")?.expected ?? 0;
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
  const value = projectRoster(model, playerIds.flatMap((id) => modelPlayer(model, id) ?? []), count);
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

/** Average weekly score for each real week left (the model's calendar), from the same imaginary weeks. */
export function projectByWeek(model: StrengthModel, playerIds: string[]): number[] {
  const count = model.calendar.weeks.length;
  if (count === 0) return [];
  const roster = playerIds.flatMap((id) => modelPlayer(model, id) ?? []);
  const totals = new Array<number>(count).fill(0);
  const seen = new Array<number>(count).fill(0);
  if (roster.length === 0) return totals;
  const work = scratchFor(model, roster);
  for (let week = 0; week < model.weeks; week++) {
    totals[week % count]! += simulateWeek(model, roster, week, work).total;
    seen[week % count]!++;
  }
  return totals.map((total, index) => (seen[index] ? total / seen[index]! : 0));
}

// ---- Injured reserve and waiver pickups ----------------------------------
//
// A roster is judged as its manager would run it. A player who may sit on
// injured reserve goes there (most out first, up to the league's IR slots)
// and takes no active spot. Open active spots are filled from waivers with
// the free agent who helps most. Too many active players (after receiving
// more than you send) means dropping the least valuable.
//
// When a player on IR is back, the roster has one player too many, so the
// least valuable active player (a pickup or not) plays only until then
// (`standIn`). A player out for the season never comes back, so nobody has
// to go.
//
// Rosters before and after a trade are filled the same way, so a trade is
// credited only with the spots it opens.

/** Weeks used when trying out free agents, to keep it quick. */
const PICKUP_TRIAL_WEEKS = 60;
const PICKUP_CANDIDATES = 6;

/**
 * A player kept only for as long as `injured` is out: he plays only the
 * weeks the injured player misses, chosen with the injured player's chances
 * (the same weeks on any roster, so results stay repeatable).
 */
export function standIn(model: StrengthModel, player: ModelPlayer, injured: ModelPlayer): ModelPlayer {
  const id = `${player.id}~${injured.id}`;
  const known = model.extra.get(id);
  if (known) return known;
  const back = injured.back;
  const gameDay = Int8Array.from(player.gameDay);
  const seed = hash(id);
  if (back) {
    for (let week = 0; week < model.weeks; week++) {
      if (uniform(seed, week, 77) >= back[week % back.length]!) continue;
      for (let game = 0; game < MAX_GAMES; game++) gameDay[week * MAX_GAMES + game] = -1;
    }
  }
  const share = back ? injured.outShare : 1;
  const made: ModelPlayer = {
    ...player,
    id,
    gameDay,
    expected: player.expected * share,
    availability: player.availability * share,
  };
  model.extra.set(id, made);
  return made;
}

export interface Pickup {
  player: ModelPlayer;
  /** He plays only until this player is back from IR (he is the one who makes way), or null when he stays. */
  forInjured: ModelPlayer | null;
}

export interface FilledRoster {
  /** The roster the projection plays: everyone kept, players who leave later by their stand-in IDs. */
  ids: string[];
  /** Players put on injured reserve. */
  reserve: ModelPlayer[];
  /** Free agents picked up. */
  adds: Pickup[];
  /** Players dropped now to make room. */
  drops: ModelPlayer[];
  /** Players already on the roster who are dropped when a player on IR is back. */
  leaving: { player: ModelPlayer; when: ModelPlayer }[];
}

export function fillRoster(
  model: StrengthModel,
  playerIds: string[],
  /** Free agents not available (taken, or part of a trade). */
  claimed: Set<string> = new Set(),
  /** Free agents to keep if they are still wanted: the pickups the roster made before a trade. */
  prefer: string[] = [],
): FilledRoster {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const reserve = roster
    .filter((player) => player.irEligible)
    .sort((a, b) => b.outShare - a.outShare)
    .slice(0, model.rosterLimits.reserve);
  let active = roster.filter((player) => !reserve.includes(player));
  const drops: ModelPlayer[] = [];
  while (active.length > model.rosterLimits.active) {
    const weakest = active.reduce((a, b) => (b.expected < a.expected ? b : a));
    drops.push(weakest);
    active = active.filter((player) => player !== weakest);
  }

  // Open spots: pickups who stay.
  let ids = [...active, ...reserve].map((player) => player.id);
  const picked: ModelPlayer[] = [];
  const unavailable = (id: string) => claimed.has(id) || ids.includes(id) || playerIds.includes(id);
  for (let open = model.rosterLimits.active - active.length; open > 0; open--) {
    const kept = prefer.map((id) => model.players.get(id)).find((player): player is ModelPlayer => !!player && !unavailable(player.id));
    const options = model.freeAgentIds.filter((id) => !unavailable(id)).slice(0, PICKUP_CANDIDATES);
    if (!kept && options.length === 0) break;
    const best =
      kept ??
      options
        .map((id) => ({ id, projected: projectedWeekly(model, [...ids, id], PICKUP_TRIAL_WEEKS) }))
        .reduce((a, b) => (b.projected > a.projected ? b : a)).id;
    const player = model.players.get(typeof best === "string" ? best : best.id)!;
    picked.push(player);
    ids = [...ids, player.id];
  }

  // Each player on IR who is back this season pushes out the least valuable active player then.
  const adds: Pickup[] = picked.map((player) => ({ player, forInjured: null }));
  const leaving: FilledRoster["leaving"] = [];
  const going = new Set<string>();
  const returning = reserve.filter((player) => player.back && player.outShare > 0 && player.outShare < 1);
  for (const injured of returning) {
    const candidates = [...active, ...picked].filter((player) => !going.has(player.id));
    if (candidates.length === 0) break;
    const weakest = candidates.reduce((low, player) => (player.expected < low.expected ? player : low));
    going.add(weakest.id);
    ids = ids.map((id) => (id === weakest.id ? standIn(model, weakest, injured).id : id));
    const pickup = adds.find((add) => add.player === weakest);
    if (pickup) pickup.forInjured = injured;
    else leaving.push({ player: weakest, when: injured });
  }
  return { ids, reserve, adds, drops, leaving };
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

function bestNinePicks(model: StrengthModel, roster: ModelPlayer[]) {
  return assignSlots(
    roster.map((player) => player.eligible),
    roster.map((player) => player.healthy),
    model.slots.length,
  );
}

/**
 * The best legal starting nine, slot by slot in the league's slot order: the
 * same lineup the strength score calls "best nine". A slot nobody can fill
 * has a null player.
 */
export function bestNineLineup(model: StrengthModel, playerIds: string[]): { slot: string; player: ModelPlayer | null }[] {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const { picks } = bestNinePicks(model, roster);
  return model.slots.map((slot, index) => ({ slot, player: picks[index]! >= 0 ? roster[picks[index]!]! : null }));
}

export function rosterStrength(model: StrengthModel, playerIds: string[]): Omit<TeamStrength, "rosterId" | "rank"> {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const lineup = bestNinePicks(model, roster);
  const starters = lineup.picks.filter((index) => index >= 0).map((index) => roster[index]!);
  // Run as its manager would: injured players on IR, open spots filled from waivers.
  const projected = projectedWeekly(model, fillRoster(model, playerIds).ids);
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
