import { rosterPlayers } from "./analysis.ts";
import {
  MARKET_GAP_NOTE,
  marketGap,
  positionProfile,
  type PositionNote,
  type TeamSituation,
} from "./insight.ts";
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
  /** 0 to 1: a rough estimate of how likely the other manager is to accept. */
  chance: number;
  /** Short explanations of why this trade came up. */
  reasons: string[];
}

export interface FinderOptions {
  /** Only trades that bring back a player at this position. */
  getPosition?: string;
  /** Only trades that send away a player at this position. */
  givePosition?: string;
  /** Only trades that send away this player (one of the user's). */
  givePlayerId?: string;
  /** Only trades that bring back this player (on another team). */
  getPlayerId?: string;
}

/** Weeks used for the first pass over every possible swap. */
const SCREEN_WEEKS = 40;

/**
 * A rough estimate of whether the other manager says yes. Three parts with
 * fixed shares, so none can dominate:
 *   55%  how much the trade helps their team, by this app's projection
 *   30%  whether it looks fair on the averages they can see
 *   15%  how much pressure their team is under
 * It is a reasoned guess, not a measured probability.
 */
export function acceptanceChance(theirs: TradeSide, urgency: number): number {
  const helps = 1 / (1 + Math.exp(-(theirs.projectedAfter - theirs.projectedBefore) / GRADE_STEP));
  const sum = (list: ModelPlayer[]) => list.reduce((total, player) => total + player.average, 0);
  const sent = sum(theirs.gives);
  // 20% less on average looks bad, 20% more looks great.
  const looksFair = sent > 0 ? Math.min(1, Math.max(0, (sum(theirs.gets) / sent - 0.8) / 0.4)) : 1;
  return 0.55 * helps + 0.3 * looksFair + 0.15 * Math.min(1, Math.max(0, urgency));
}

const points = (value: number) => value.toFixed(2);

function reasonsFor(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  result: TradeResult,
  mine: PositionNote[],
  theirs: PositionNote[],
  situation: TeamSituation | undefined,
): string[] {
  const reasons: string[] = [];
  const team = snapshot.teams.find((candidate) => candidate.rosterId === result.b.rosterId);
  const topNeed = (profile: PositionNote[]) => [...profile].sort((a, b) => b.need - a.need)[0];
  const topCover = (profile: PositionNote[]) => [...profile].sort((a, b) => b.cover - a.cover)[0];

  const myNeed = topNeed(mine);
  if (myNeed && myNeed.need > 0.5 && result.a.gets.some((player) => player.positions.includes(myNeed.position))) {
    reasons.push(`Fills your thinnest spot, ${myNeed.position}.`);
  }
  const myDepth = topCover(mine);
  if (myDepth && myDepth.cover > 1 && result.a.gives.some((player) => player.positions.includes(myDepth.position))) {
    reasons.push(`You have ${myDepth.position} to spare: your roster makes up ${points(myDepth.cover)} a week if your best one leaves.`);
  }
  for (const player of result.a.gives) {
    if (marketGap(player) <= -MARKET_GAP_NOTE) {
      reasons.push(`Sell high: ${player.name} averages ${points(player.average)} but projects to ${points(player.projected)}.`);
    }
  }
  for (const player of result.a.gets) {
    if (marketGap(player) >= MARKET_GAP_NOTE) {
      reasons.push(`Buy low: ${player.name} averages ${points(player.average)} but projects to ${points(player.projected)}.`);
    }
  }
  const theirNeed = topNeed(theirs);
  if (theirNeed && theirNeed.need > 0.5 && result.b.gets.some((player) => player.positions.includes(theirNeed.position))) {
    reasons.push(`${team?.teamName ?? "They"} are thin at ${theirNeed.position}, which this fills.`);
  }
  if (situation && team) {
    const out = situation.longTermOut[0];
    if (out) reasons.push(`${team.teamName} have ${out.name} out for a stretch, so they may want help now.`);
    else if (situation.winShare < 0.4) reasons.push(`${team.teamName} are ${team.wins}-${team.losses} and may want a change.`);
  }
  return reasons.slice(0, 4);
}

/**
 * Trades for `rosterId`, best first. "Best" is the weekly points the trade
 * adds for the user multiplied by the chance it is accepted, so a big win
 * nobody would agree to ranks below a smaller one that is realistic.
 *
 * With no options it looks at every one-for-one swap in the league. Naming
 * a player to send or to get narrows the search, and when a target player
 * is named, two-for-one offers for him are tried as well.
 */
export function findTrades(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation>,
  options: FinderOptions = {},
  limit = 8,
): TradeIdea[] {
  const targeted = Boolean(options.givePlayerId || options.getPlayerId);
  const mine = rosterIds(snapshot, rosterId);
  const at = (position: string | undefined) => (player: ModelPlayer) =>
    !position || player.positions.includes(position);
  const givers = players(model, mine).filter(
    (player) => player.games > 0 && at(options.givePosition)(player) && (!options.givePlayerId || player.id === options.givePlayerId),
  );
  const mineBefore = projectedWeekly(model, mine, SCREEN_WEEKS);
  const screened: { offer: TradeOffer; quick: number }[] = [];

  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const theirs = rosterPlayers(team).map((player) => player.id);
    const targets = players(model, theirs).filter(
      (player) => player.games > 0 && at(options.getPosition)(player) && (!options.getPlayerId || player.id === options.getPlayerId),
    );
    if (targets.length === 0) continue;
    const theirsBefore = projectedWeekly(model, theirs, SCREEN_WEEKS);

    for (const get of targets) {
      for (const give of givers) {
        // Without a named player, skip swaps of players worlds apart: they cannot suit both teams.
        if (!targeted && Math.abs(give.expected - get.expected) > 0.4 * Math.max(give.expected, get.expected)) continue;
        const gain = projectedWeekly(model, [...mine.filter((id) => id !== give.id), get.id], SCREEN_WEEKS) - mineBefore;
        if (!targeted && gain < 0.3) continue;
        const theirGain = projectedWeekly(model, [...theirs.filter((id) => id !== get.id), give.id], SCREEN_WEEKS) - theirsBefore;
        if (!targeted && theirGain < -1) continue;
        screened.push({
          offer: { teamA: rosterId, teamB: team.rosterId, aGives: [give.id], bGives: [get.id] },
          quick: gain + Math.min(0, theirGain),
        });
      }
      // Two of the user's players for a named target.
      if (options.getPlayerId) {
        const pool = players(model, mine).filter((player) => player.games > 0 && player.expected < get.expected);
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const pair = [pool[i]!, pool[j]!];
            if (options.givePlayerId && !pair.some((player) => player.id === options.givePlayerId)) continue;
            const combined = pair[0]!.expected + pair[1]!.expected;
            if (combined < 0.9 * get.expected || combined > 1.7 * get.expected) continue;
            screened.push({
              offer: { teamA: rosterId, teamB: team.rosterId, aGives: pair.map((player) => player.id), bGives: [get.id] },
              quick: get.expected - Math.max(pair[0]!.expected, pair[1]!.expected),
            });
          }
        }
      }
    }
  }

  const myProfile = positionProfile(model, snapshot, mine);
  const theirProfiles = new Map<number, PositionNote[]>();
  const profileOf = (id: number) => {
    if (!theirProfiles.has(id)) theirProfiles.set(id, positionProfile(model, snapshot, rosterIds(snapshot, id)));
    return theirProfiles.get(id)!;
  };

  const gain = (side: TradeSide) => side.projectedAfter - side.projectedBefore;
  const evaluated = screened
    .sort((a, b) => b.quick - a.quick)
    .slice(0, limit * 6)
    .map(({ offer }) => {
      const result = evaluateTrade(model, snapshot, offer);
      return { offer, result, chance: acceptanceChance(result.b, situations.get(offer.teamB)?.urgency ?? 0) };
    })
    // Without a named player, show only trades that help the user and stand a chance.
    .filter(({ result, chance }) => targeted || (result.a.grade > 50 && chance >= 0.3))
    .sort((a, b) => {
      const score = (idea: typeof a) => (gain(idea.result.a) > 0 ? gain(idea.result.a) * idea.chance : gain(idea.result.a));
      return score(b) - score(a);
    })
    // Variety: without a named player, no single player may appear in more than two ideas.
    .filter(
      (() => {
        const seen = new Map<string, number>();
        return ({ offer }: { offer: TradeOffer }) => {
          const ids = [...offer.aGives, ...offer.bGives].filter(
            (id) => id !== options.givePlayerId && id !== options.getPlayerId,
          );
          if (ids.some((id) => (seen.get(id) ?? 0) >= 2)) return false;
          for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
          return true;
        };
      })(),
    )
    .slice(0, limit);

  return evaluated.map((idea) => ({
    ...idea,
    reasons: reasonsFor(model, snapshot, idea.result, myProfile, profileOf(idea.offer.teamB), situations.get(idea.offer.teamB)),
  }));
}
