import { rosterPlayers } from "./analysis.ts";
import { projectedWeekly, strengthScore, type ModelPlayer, type StrengthModel } from "./strength.ts";
import type { LeagueSnapshot } from "./types.ts";

// Trade evaluation. A trade is judged by what it does to each team's
// projected weekly score for the rest of the season (shared/strength.ts).
//
// Rosters keep their size. A team that receives more players than it sends
// drops its least valuable players; a team that sends more than it receives
// picks up the free agents that help it most. Those moves are part of the
// result, because a two-for-one trade is really a trade plus a waiver pickup.

export interface TradeOffer {
  /** Roster IDs of the two teams. */
  teamA: number;
  teamB: number;
  /** Player IDs each team sends. */
  aGives: string[];
  bGives: string[];
}

export interface TradeSide {
  rosterId: number;
  gives: ModelPlayer[];
  gets: ModelPlayer[];
  /** Free agents assumed picked up to refill the roster. */
  adds: ModelPlayer[];
  /** Players assumed dropped to make room. */
  drops: ModelPlayer[];
  /** Team strength, 1 to 1000, before and after. */
  strengthBefore: number;
  strengthAfter: number;
  strengthChange: number;
  projectedBefore: number;
  projectedAfter: number;
  /** 1 to 100: how good the trade is for this manager. 50 means no real change. */
  grade: number;
  letter: string;
}

export interface TradeResult {
  a: TradeSide;
  b: TradeSide;
}

/** Weekly points that move a grade from 50 to about 73 (and twice that to about 88). */
const GRADE_STEP = 4;

/** 1 to 100 from the change in projected weekly score. */
export function tradeGrade(projectedChange: number): number {
  const grade = 100 / (1 + Math.exp(-projectedChange / GRADE_STEP));
  return Math.min(100, Math.max(1, Math.round(grade)));
}

const LETTERS: [number, string][] = [
  [95, "A+"], [88, "A"], [80, "A-"], [72, "B+"], [64, "B"], [57, "B-"],
  [53, "C+"], [48, "C"], [43, "C-"], [36, "D+"], [28, "D"], [20, "D-"],
];

export function letterGrade(grade: number): string {
  return LETTERS.find(([floor]) => grade >= floor)?.[1] ?? "F";
}

function players(model: StrengthModel, ids: string[]): ModelPlayer[] {
  return ids.flatMap((id) => model.players.get(id) ?? []);
}

/** Weeks used when trying out free agents, to keep it quick. */
const PICKUP_TRIAL_WEEKS = 60;
const PICKUP_CANDIDATES = 6;

function side(
  model: StrengthModel,
  rosterId: number,
  before: string[],
  gives: string[],
  gets: string[],
  claimed: Set<string>,
): TradeSide {
  let after = [...before.filter((id) => !gives.includes(id)), ...gets];
  const drops: string[] = [];
  const adds: string[] = [];

  while (after.length > before.length) {
    const weakest = players(model, after).reduce((a, b) => (b.expected < a.expected ? b : a));
    drops.push(weakest.id);
    after = after.filter((id) => id !== weakest.id);
  }
  while (after.length < before.length) {
    // Try the most valuable unclaimed free agents and keep the one that fits best.
    const options = model.freeAgentIds
      .filter((id) => !claimed.has(id) && !after.includes(id) && !gives.includes(id))
      .slice(0, PICKUP_CANDIDATES);
    if (options.length === 0) break;
    const roster = after;
    const best = options
      .map((id) => ({ id, projected: projectedWeekly(model, [...roster, id], PICKUP_TRIAL_WEEKS) }))
      .reduce((a, b) => (b.projected > a.projected ? b : a));
    adds.push(best.id);
    claimed.add(best.id);
    after = [...after, best.id];
  }

  const projectedBefore = projectedWeekly(model, before);
  const projectedAfter = projectedWeekly(model, after);
  const strengthBefore = strengthScore(model, projectedBefore);
  const strengthAfter = strengthScore(model, projectedAfter);
  const grade = tradeGrade(projectedAfter - projectedBefore);
  return {
    rosterId,
    gives: players(model, gives),
    gets: players(model, gets),
    adds: players(model, adds),
    drops: players(model, drops),
    strengthBefore,
    strengthAfter,
    strengthChange: strengthAfter - strengthBefore,
    projectedBefore,
    projectedAfter,
    grade,
    letter: letterGrade(grade),
  };
}

function rosterIds(snapshot: LeagueSnapshot, rosterId: number): string[] {
  const team = snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  return team ? rosterPlayers(team).map((player) => player.id) : [];
}

export function evaluateTrade(model: StrengthModel, snapshot: LeagueSnapshot, offer: TradeOffer): TradeResult {
  const claimed = new Set<string>();
  return {
    a: side(model, offer.teamA, rosterIds(snapshot, offer.teamA), offer.aGives, offer.bGives, claimed),
    b: side(model, offer.teamB, rosterIds(snapshot, offer.teamB), offer.bGives, offer.aGives, claimed),
  };
}

export interface TradeIdea {
  offer: TradeOffer;
  result: TradeResult;
}

/** Weeks used for the first pass over every possible swap. */
const SCREEN_WEEKS = 40;
/** A manager is unlikely to accept a player who looks clearly worse on average. */
const LOOKS_FAIR = 0.9;

/**
 * One-for-one trades that make `rosterId` stronger without making the other
 * team weaker, and where the player offered does not look clearly worse than
 * the player asked for. Best for `rosterId` first.
 */
export function suggestTrades(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  limit = 8,
): TradeIdea[] {
  const mine = rosterIds(snapshot, rosterId);
  const mineBefore = projectedWeekly(model, mine, SCREEN_WEEKS);
  const screened: { offer: TradeOffer; gain: number }[] = [];

  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const theirs = rosterPlayers(team).map((player) => player.id);
    const theirsBefore = projectedWeekly(model, theirs, SCREEN_WEEKS);
    for (const give of players(model, mine)) {
      if (give.games === 0) continue;
      for (const get of players(model, theirs)) {
        if (get.games === 0 || give.average < get.average * LOOKS_FAIR) continue;
        // A swap of two players worlds apart cannot help both teams.
        if (Math.abs(give.expected - get.expected) > 0.4 * Math.max(give.expected, get.expected)) continue;
        const mineAfter = projectedWeekly(model, [...mine.filter((id) => id !== give.id), get.id], SCREEN_WEEKS);
        if (mineAfter - mineBefore < 0.5) continue;
        const theirsAfter = projectedWeekly(model, [...theirs.filter((id) => id !== get.id), give.id], SCREEN_WEEKS);
        if (theirsAfter - theirsBefore < 0) continue;
        screened.push({
          offer: { teamA: rosterId, teamB: team.rosterId, aGives: [give.id], bGives: [get.id] },
          gain: mineAfter - mineBefore,
        });
      }
    }
  }

  // Re-check the most promising swaps over all the weeks.
  return screened
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit * 3)
    .map(({ offer }) => ({ offer, result: evaluateTrade(model, snapshot, offer) }))
    .filter(({ result }) => result.a.grade > 50 && result.b.grade >= 50)
    .sort((a, b) => b.result.a.projectedAfter - b.result.a.projectedBefore - (a.result.a.projectedAfter - a.result.a.projectedBefore))
    .slice(0, limit);
}
