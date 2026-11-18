// The lock-in state of a live matchup, worked out from what Sleeper reports
// (each starter's counted score, with no word on whether it is locked), the
// NBA schedule and the box scores.
//
// Sleeper shows an unlocked starter's latest game as his score. So:
// - a score that matches an earlier game this week is locked (if it were not,
//   it would have moved on to his newer game);
// - a score that matches his latest game is final once his team has no games
//   left this week, and otherwise could still be locked (or already is: the
//   manager knows, the data does not say);
// - no games yet means he is waiting to play.
//
// Box scores lack technical and flagrant fouls, which Sleeper deducts, so a
// score a few whole foul deductions below a game still matches it.

import { nbaTeam } from "./nbaTeams.ts";
import type { NbaGame, WeekLine } from "./types.ts";

export type SlotState =
  /** Counts an earlier game this week: fixed. */
  | "locked"
  /** His last game of the week is over: fixed, locked or not. */
  | "final"
  /** Counts his latest game, with games still to come: can still be locked, or already is. */
  | "open"
  /** His game is being played. */
  | "live"
  /** Has not played yet this week, with games to come. */
  | "waiting"
  /** No games left and nothing to count. */
  | "done"
  /** Sleeper's score matches none of his games we know of (box scores not loaded yet). */
  | "unclear";

export interface TeamGame {
  game: NbaGame;
  opponent: string | null;
  home: boolean;
  /** His box score for this game, if he played and it has loaded. */
  line: WeekLine | null;
}

export interface SlotStatus {
  state: SlotState;
  /** Index into `games` of the game Sleeper is counting, when known. */
  counted: number | null;
  games: TeamGame[];
  /** Games not started yet, or null when the schedule is unavailable. */
  gamesLeft: number | null;
  nextGame: TeamGame | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => {
  const left = nbaTeam(a)?.abbr ?? a?.toUpperCase() ?? null;
  const right = nbaTeam(b)?.abbr ?? b?.toUpperCase() ?? null;
  return left !== null && left === right;
};

/**
 * A player's NBA team's games this week, each with his box score when he has
 * one. Without a schedule, his box scores stand in for the games played.
 */
export function teamWeek(games: NbaGame[], team: string | null, lines: WeekLine[], scheduleKnown: boolean): TeamGame[] {
  if (!scheduleKnown) {
    return lines.map((line, index) => ({
      game: {
        id: `line-${index}`,
        date: line.date,
        startTime: null,
        home: line.home ? team : line.opponent,
        away: line.home ? line.opponent : team,
        state: line.final ? "final" : "in_progress",
        homeScore: null,
        awayScore: null,
        statusText: null,
      },
      opponent: line.opponent,
      home: line.home === true,
      line,
    }));
  }
  return games
    .filter((game) => same(game.home, team) || same(game.away, team))
    .sort((a, b) => (a.startTime ?? a.date).localeCompare(b.startTime ?? b.date))
    .map((game) => {
      const home = same(game.home, team);
      return {
        game,
        opponent: home ? game.away : game.home,
        home,
        line: lines.find((line) => line.date === game.date) ?? null,
      };
    });
}

const EXACT = 0.051;

/** Every total of up to three foul deductions, e.g. [2, 3] -> 2, 3, 4, 5, 6, 7, 8, 9. */
export function foulDeductions(steps: number[]): number[] {
  const sizes = steps.map(Math.abs).filter((size) => size > 0);
  const totals = new Set<number>();
  const add = (sum: number, depth: number) => {
    if (depth > 0) totals.add(Math.round(sum * 100) / 100);
    if (depth === 3) return;
    for (const size of sizes) add(sum + size, depth + 1);
  };
  add(0, 0);
  return [...totals].sort((a, b) => a - b);
}

function matchesGame(sleeperPoints: number, boxPoints: number, deductions: number[], allowFouls: boolean): boolean {
  const gap = boxPoints - sleeperPoints;
  if (Math.abs(gap) < EXACT) return true;
  return allowFouls && deductions.some((deduction) => Math.abs(gap - deduction) < EXACT);
}

/** Works out where one starter stands this week. */
export function slotStatus(
  sleeperPoints: number,
  games: TeamGame[],
  scheduleKnown: boolean,
  deductions: number[],
): SlotStatus {
  const played = games.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.game.state !== "scheduled");
  const upcoming = games.filter((entry) => entry.game.state === "scheduled");
  const gamesLeft = scheduleKnown ? upcoming.length : null;
  const nextGame = upcoming[0] ?? null;
  const base = { games, gamesLeft, nextGame };

  if (played.length === 0) {
    if (sleeperPoints > 0) return { ...base, state: "unclear", counted: null };
    return { ...base, state: gamesLeft === 0 ? "done" : "waiting", counted: null };
  }

  // A finished game with no box score for him counts as zero (he did not play).
  const pointsOf = (entry: TeamGame) => entry.line?.points ?? 0;
  let match: number | null = null;
  for (const allowFouls of [false, true]) {
    for (let i = played.length - 1; i >= 0 && match === null; i--) {
      if (matchesGame(sleeperPoints, pointsOf(played[i]!.entry), deductions, allowFouls)) match = i;
    }
    if (match !== null) break;
  }
  if (match === null) return { ...base, state: "unclear", counted: null };

  const counted = played[match]!.index;
  if (match < played.length - 1) return { ...base, state: "locked", counted };
  if (played[match]!.entry.game.state === "in_progress") return { ...base, state: "live", counted };
  // A latest game he sat out leaves nothing to lock: he is waiting for his next one.
  const sat = !played[match]!.entry.line || played[match]!.entry.line!.minutes <= 0;
  if (sat && sleeperPoints === 0) return { ...base, state: gamesLeft === 0 ? "done" : "waiting", counted: null };
  if (gamesLeft === 0) return { ...base, state: "final", counted };
  return { ...base, state: "open", counted };
}

/**
 * Starters whose score is not settled and who still have a game to come:
 * Sleeper's "yet to play" count.
 */
export function stillToPlay(statuses: (SlotStatus | null)[]): number {
  return statuses.filter((status) => status && !isFixed(status.state) && (status.gamesLeft ?? 0) > 0).length;
}

/** Points that are settled for the week: locked, final, or nothing to come. */
export function settledPoints(statuses: (SlotStatus | null)[], points: (number | null)[]): number {
  return statuses.reduce((sum, status, index) => sum + (status && isFixed(status.state) ? (points[index] ?? 0) : 0), 0);
}

/** Whether a starter's score is settled for the week. */
export function isFixed(state: SlotState): boolean {
  return state === "locked" || state === "final" || state === "done";
}

function binomial(k: number, n: number, p: number): number {
  let ways = 1;
  for (let i = 0; i < k; i++) ways = (ways * (n - i)) / (i + 1);
  return ways * p ** k * (1 - p) ** (n - k);
}

/**
 * What waiting is worth with `gamesLeft` games to come: his expected locked
 * score from those games (`waitValue`, which assumes he plays them all),
 * weighted by his chance of playing each one.
 */
export function waitWorth(waitValue: ArrayLike<number>, availability: number, gamesLeft: number): number {
  const most = Math.min(gamesLeft, waitValue.length - 1);
  let worth = 0;
  for (let played = 1; played <= most; played++) worth += binomial(played, most, availability) * waitValue[played]!;
  return worth;
}

export interface LockAdvice {
  lock: boolean;
  current: number;
  /** Expected locked score if he waits for his remaining games. */
  waiting: number;
}

/** Lock now when the score in hand beats what waiting is expected to bring. */
export function lockAdvice(
  current: number,
  gamesLeft: number,
  player: { waitValue: ArrayLike<number>; availability: number },
  injury: InjuryKind = null,
): LockAdvice {
  const waiting = waitWorth(player.waitValue, mean(gameChances(player.availability, gamesLeft, injury)), gamesLeft);
  return { lock: current >= waiting, current, waiting };
}

/**
 * Injury tags from Sleeper, applied to this week's remaining games only.
 * Out: misses his next game; later games this week at half his usual rate.
 * Day-to-day: next game at 60% of his usual rate. Fixed sizes, so a tag
 * cannot outweigh the rest of the forecast.
 */
export const INJURY_EFFECT = { outNext: 0, outLater: 0.5, dayToDayNext: 0.6 } as const;

export type InjuryKind = "out" | "day-to-day" | null;

export function injuryKind(tag: string | null | undefined): InjuryKind {
  const value = (tag ?? "").trim().toUpperCase();
  if (!value) return null;
  if (["OUT", "O", "IR", "SUS", "SUSP", "SUSPENDED", "INJURED RESERVE"].includes(value)) return "out";
  if (["DTD", "GTD", "Q", "QUESTIONABLE", "D", "DOUBTFUL", "DAY-TO-DAY", "GAME TIME DECISION"].includes(value)) return "day-to-day";
  return null;
}

/** His chance of playing each of his remaining games this week. */
export function gameChances(availability: number, gamesLeft: number, injury: InjuryKind): number[] {
  return Array.from({ length: Math.max(0, gamesLeft) }, (_, index) => {
    if (injury === "out") return availability * (index === 0 ? INJURY_EFFECT.outNext : INJURY_EFFECT.outLater);
    if (injury === "day-to-day" && index === 0) return availability * INJURY_EFFECT.dayToDayNext;
    return availability;
  });
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Whether another manager has probably locked an open score. Sleeper does not
 * share locks, so this applies the same rule as the lock advice: a score that
 * beats what waiting is expected to bring is one a manager would usually lock.
 */
export function probablyLocked(
  state: SlotState,
  points: number,
  gamesLeft: number | null,
  player: { waitValue: ArrayLike<number>; availability: number } | null,
  injury: InjuryKind = null,
): boolean {
  if (state !== "open" || !player || !gamesLeft || points <= 0) return false;
  return lockAdvice(points, gamesLeft, player, injury).lock;
}

/** A starter as the win-chance simulation sees him. */
export interface SimSlot {
  state: SlotState;
  /** Sleeper's current score. */
  points: number;
  gamesLeft: number;
  /** His model numbers, or null when he has no stats (his score then stays as it is). */
  player: { projected: number; spread: number; availability: number; waitValue: ArrayLike<number> } | null;
  injury?: InjuryKind;
}

/** Deterministic random numbers, so the same matchup always shows the same chance. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function finishSlot(slot: SimSlot, random: () => number): number {
  const { player } = slot;
  if (isFixed(slot.state) || !player || slot.gamesLeft <= 0) {
    // Nothing left to play: the score stands (a waiting player with no games scores 0).
    return slot.state === "waiting" ? 0 : slot.points;
  }
  const chances = gameChances(player.availability, slot.gamesLeft, slot.injury ?? null);
  const worth = (fromGame: number) =>
    waitWorth(player.waitValue, mean(chances.slice(fromGame)), slot.gamesLeft - fromGame);
  const holding = slot.state === "open" || slot.state === "live" || slot.state === "unclear";
  // Lock the score in hand if waiting is not expected to beat it.
  if (holding && slot.points >= worth(0)) return slot.points;
  for (let game = 0; game < slot.gamesLeft; game++) {
    const last = game === slot.gamesLeft - 1;
    if (random() >= chances[game]!) {
      if (last) return 0; // Missed his last game: Sleeper counts nothing.
      continue;
    }
    const u1 = Math.max(1e-9, random());
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
    const score = Math.max(0, player.projected * (1 + player.spread * z));
    if (last || score >= worth(game + 1)) return score;
  }
  return 0;
}

export interface MatchupForecast {
  /** Average final score for each side. */
  projected: [number, number];
  /** Chance each side wins (ties split evenly). */
  winChance: [number, number];
  /** Average final score for each starter, in the order given. */
  slotProjections: [number[], number[]];
}

/**
 * Plays out the rest of the week many times. Settled scores stay as they
 * are; every other starter plays his remaining games, and each manager locks
 * a score whenever it beats what waiting is expected to bring. Starters stay
 * in their slots (no bench swaps).
 */
export function forecastMatchup(sides: [SimSlot[], SimSlot[]], runs = 4000, seed = 1): MatchupForecast {
  const random = mulberry32(seed);
  const totals: [number, number] = [0, 0];
  const slotTotals: [number[], number[]] = [sides[0].map(() => 0), sides[1].map(() => 0)];
  let winsA = 0;
  for (let run = 0; run < runs; run++) {
    const score: [number, number] = [0, 0];
    for (const side of [0, 1] as const) {
      sides[side].forEach((slot, index) => {
        const value = finishSlot(slot, random);
        score[side] += value;
        slotTotals[side][index]! += value;
      });
      totals[side] += score[side];
    }
    winsA += score[0] > score[1] ? 1 : score[0] === score[1] ? 0.5 : 0;
  }
  const a = winsA / runs;
  return {
    projected: [totals[0] / runs, totals[1] / runs],
    winChance: [a, 1 - a],
    slotProjections: [slotTotals[0].map((total) => total / runs), slotTotals[1].map((total) => total / runs)],
  };
}
