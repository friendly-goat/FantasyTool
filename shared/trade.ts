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
  /**
   * Player value this side sends and receives: each player's own weekly
   * value above a typical free agent, added up. No team context at all.
   */
  valueSent: number;
  valueReceived: number;
  valueChange: number;
  /** Change in this team's projected weekly score: the trade in context. */
  teamChange: number;
  /**
   * How much more (or less) the trade is worth to this team than its player
   * value says: teamChange minus valueChange. Positive when the players fit
   * the roster (a thin position, depth, injuries); negative when they do not.
   */
  fit: number;
  /** 1 to 100: how good the trade is for this manager. 50 means no real change. */
  grade: number;
  letter: string;
}

export interface TradeResult {
  a: TradeSide;
  b: TradeSide;
  /**
   * Who the trade favors on player value alone, 0 to 100: 50 is even, lower
   * favors team A, higher favors team B.
   */
  valueBalance: number;
}

/** A player's own weekly value above a typical free agent. Never below zero. */
export function playerValue(model: StrengthModel, player: ModelPlayer): number {
  return Math.max(0, player.expected - model.replacementWeekly);
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
  const value = (ids: string[]) => players(model, ids).reduce((sum, player) => sum + playerValue(model, player), 0);
  const valueSent = value(gives);
  const valueReceived = value(gets);
  const teamChange = projectedAfter - projectedBefore;
  return {
    valueSent,
    valueReceived,
    valueChange: valueReceived - valueSent,
    teamChange,
    fit: teamChange - (valueReceived - valueSent),
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
  const a = side(model, offer.teamA, rosterIds(snapshot, offer.teamA), offer.aGives, offer.bGives, claimed);
  const b = side(model, offer.teamB, rosterIds(snapshot, offer.teamB), offer.bGives, offer.aGives, claimed);
  const total = a.valueReceived + b.valueReceived;
  const valueBalance = total > 0 ? Math.min(97, Math.max(3, 50 + (50 * (b.valueReceived - a.valueReceived)) / total)) : 50;
  return { a, b, valueBalance };
}

// ---- Why a trade is the way it is -------------------------------------------
//
// An explanation only: nothing here changes a grade, a chance or a ranking.
// It compares the trade on player value alone with its effect on each team,
// and names what explains the gap.

/** A team effect smaller than this (points a week) counts as no real change. */
const REAL_CHANGE = 0.5;
/** Fit this large (points a week) is worth pointing out. */
const NOTABLE_FIT = 1;

export type TradeKind =
  | "leverage"
  | "win-win"
  | "fair-for-you"
  | "value-edge"
  | "fit-for-you"
  | "costs-you"
  | "even";

export interface TradeStory {
  kind: TradeKind;
  headline: string;
  points: string[];
}

/** True when the two sides are within 10% (or a point a week) on player value. */
export function evenOnValue(result: TradeResult): boolean {
  const gap = Math.abs(result.a.valueReceived - result.b.valueReceived);
  return gap <= Math.max(1, 0.1 * Math.max(result.a.valueReceived, result.b.valueReceived));
}

/** The kind of trade, from team A's point of view. */
export function tradeKind(result: TradeResult): TradeKind {
  const { a, b } = result;
  const gains = a.teamChange >= REAL_CHANGE;
  // You get more player value, and they still come out about even or better
  // because your side fits their roster.
  if (gains && a.valueChange >= NOTABLE_FIT && b.fit >= NOTABLE_FIT && b.teamChange > -REAL_CHANGE) return "leverage";
  if (gains && b.teamChange >= REAL_CHANGE) return "win-win";
  if (gains && evenOnValue(result)) return "fair-for-you";
  if (gains && a.valueChange >= NOTABLE_FIT) return "value-edge";
  if (gains) return "fit-for-you";
  if (a.teamChange <= -REAL_CHANGE) return "costs-you";
  return "even";
}

const HEADLINES: Record<TradeKind, string> = {
  leverage: "You get more player value, because your side is worth more to them",
  "win-win": "Win-win: both teams get stronger",
  "fair-for-you": "Even on paper, better for your roster",
  "value-edge": "You come out ahead on player value",
  "fit-for-you": "Worth more to your roster than on paper",
  "costs-you": "Costs your team strength",
  even: "About even all round",
};

const fixed = (value: number) => value.toFixed(2);
const signed = (value: number) => (value >= 0 ? `+${value.toFixed(2)}` : `\u2212${(-value).toFixed(2)}`);

/**
 * Explains a trade from team A's point of view: the kind of trade, then
 * short points in order of importance. `profiles` and `situation` add the
 * roster and team details behind the numbers when they are available.
 */
export function tradeStory(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  result: TradeResult,
  profiles?: { mine: PositionNote[]; theirs: PositionNote[] },
  situation?: TeamSituation,
): TradeStory {
  const { a, b } = result;
  const kind = tradeKind(result);
  const them = snapshot.teams.find((team) => team.rosterId === b.rosterId)?.teamName ?? "They";
  const notes: string[] = [];

  if (evenOnValue(result)) {
    notes.push(`Even on player value: about ${fixed(a.valueReceived)} a week each way, above free-agent level.`);
  } else if (a.valueChange > 0) {
    notes.push(`You get ${fixed(a.valueChange)} a week more player value (${fixed(a.valueReceived)} for ${fixed(a.valueSent)}).`);
  } else {
    notes.push(`You give up ${fixed(-a.valueChange)} a week of player value (${fixed(a.valueSent)} for ${fixed(a.valueReceived)}).`);
  }
  if (a.fit >= NOTABLE_FIT) notes.push(`Worth ${fixed(a.fit)} a week more to your roster than its player value.`);
  if (a.fit <= -NOTABLE_FIT) notes.push(`Fits your roster poorly: worth ${fixed(-a.fit)} a week less to you than its player value.`);
  if (b.fit >= NOTABLE_FIT) notes.push(`Worth ${fixed(b.fit)} a week more to ${them} than its player value.`);
  if (b.teamChange >= REAL_CHANGE) notes.push(`${them} get stronger too (${signed(b.teamChange)} a week).`);
  else if (b.teamChange <= -REAL_CHANGE) notes.push(`${them} get weaker (${signed(b.teamChange)} a week).`);

  if (profiles) {
    for (const reason of reasonsFor(model, snapshot, result, profiles.mine, profiles.theirs, situation)) {
      if (!notes.includes(reason)) notes.push(reason);
    }
  }
  return { kind, headline: HEADLINES[kind], points: notes.slice(0, 7) };
}

export interface TradeIdea {
  offer: TradeOffer;
  result: TradeResult;
  /** 0 to 1: a rough estimate of how likely the other manager is to accept. */
  chance: number;
  likelihood: Likelihood;
  /** What kind of trade it is and why it came up. */
  story: TradeStory;
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

/**
 * Weeks used for the first pass over every possible swap. The shortlist is
 * re-checked over all the weeks, so this only has to rank roughly; every
 * player sees the same weeks on any roster, which keeps the comparison fair.
 */
const SCREEN_WEEKS = 24;
/** An open search tries many more swaps, so it screens on fewer weeks. */
const OPEN_SCREEN_WEEKS = 16;

/**
 * A rough estimate of whether the other manager says yes. Three parts with
 * fixed shares, so none can dominate:
 *   55%  how much the trade helps their team, by this app's projection
 *   30%  whether it looks fair on the averages they can see
 *   15%  how much pressure their team is under
 * It is a reasoned guess, not a measured probability.
 */
export function chanceFrom(theirWeeklyGain: number, receivedAverage: number, sentAverage: number, urgency: number): number {
  const helps = 1 / (1 + Math.exp(-theirWeeklyGain / GRADE_STEP));
  // Getting back as much on average as they send looks fair; 25% less looks bad.
  const looksFair = sentAverage > 0 ? Math.min(1, Math.max(0, (receivedAverage / sentAverage - 0.75) / 0.25)) : 1;
  return 0.55 * helps + 0.3 * looksFair + 0.15 * Math.min(1, Math.max(0, urgency));
}

const sumAverage = (list: ModelPlayer[]) => list.reduce((total, player) => total + player.average, 0);

export function acceptanceChance(theirs: TradeSide, urgency: number): number {
  // They know a two-for-one costs them a roster spot, so the player they
  // would drop is subtracted and any pickup is added.
  const received = sumAverage(theirs.gets) + sumAverage(theirs.adds) - sumAverage(theirs.drops);
  return chanceFrom(theirs.projectedAfter - theirs.projectedBefore, received, sumAverage(theirs.gives), urgency);
}

/** How likely an idea is to be accepted, in three plain bands. */
export type Likelihood = "likely" | "possible" | "long shot";
export const LIKELY = 0.5;
export const POSSIBLE = 0.4;

export function likelihood(chance: number): Likelihood {
  return chance >= LIKELY ? "likely" : chance >= POSSIBLE ? "possible" : "long shot";
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
  const myGain = result.a.projectedAfter - result.a.projectedBefore;
  if (myGain <= -0.05) reasons.push(`Costs you ${points(-myGain)} a week: the price of making this move.`);
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
  return reasons.slice(0, 5);
}

export interface FinderResult {
  ideas: TradeIdea[];
  /**
   * likely:    at least one idea is likely to be accepted
   * possible:  none is likely, but some stand a fair chance
   * long-shot: only long shots were found; they are shown, fewer of them
   * none:      nothing worth showing
   */
  outlook: "likely" | "possible" | "long-shot" | "none";
}

/** With no player named, a trade must add at least this much a week for you. */
const MIN_GAIN = 0.3;
/** With a player named, you may pay up to this much a week for the move. */
const MAX_PRICE = 1;
/** Ideas below this estimated chance are dropped at the first pass. */
const SCREEN_FLOOR = 0.25;

/**
 * Trades for `rosterId`. Ideas are grouped by how likely they are to be
 * accepted and, within a group, ranked by the weekly points they add for you
 * times that chance. Likely ideas always come first. Only when none are
 * likely are less likely ones shown, and long shots are shown only when there
 * is nothing better, and then just a few, so the list never pretends.
 *
 * With no options it looks at every one-for-one swap in the league. Naming
 * a player to send or to get narrows the search, allows a small price for
 * the move, and, for a named target, tries two-for-one offers as well.
 */
export function findTrades(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation>,
  options: FinderOptions = {},
  limit = 8,
): FinderResult {
  const targeted = Boolean(options.givePlayerId || options.getPlayerId);
  const minGain = targeted ? -MAX_PRICE : MIN_GAIN;
  const screenWeeks = targeted ? SCREEN_WEEKS : OPEN_SCREEN_WEEKS;
  const mine = rosterIds(snapshot, rosterId);
  const at = (position: string | undefined) => (player: ModelPlayer) =>
    !position || player.positions.includes(position);
  const givers = players(model, mine).filter(
    (player) => player.games > 0 && at(options.givePosition)(player) && (!options.givePlayerId || player.id === options.givePlayerId),
  );
  const mineBefore = projectedWeekly(model, mine, screenWeeks);
  const screened: { offer: TradeOffer; quick: number }[] = [];
  // A real gain is weighed by its chance. Ideas that gain you nothing (or
  // cost a little, when a player is named) rank below every real gain, the
  // more likely and cheaper ones first.
  const rank = (gain: number, chance: number) => (gain >= 0.05 ? gain * chance : gain + chance - 1);

  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const theirs = rosterPlayers(team).map((player) => player.id);
    const targets = players(model, theirs).filter(
      (player) => player.games > 0 && at(options.getPosition)(player) && (!options.getPlayerId || player.id === options.getPlayerId),
    );
    if (targets.length === 0) continue;
    const theirsBefore = projectedWeekly(model, theirs, screenWeeks);
    const urgency = situations.get(team.rosterId)?.urgency ?? 0;
    const weakest = players(model, theirs).reduce((a, b) => (b.expected < a.expected ? b : a));

    const consider = (gives: ModelPlayer[], get: ModelPlayer) => {
      const giveIds = gives.map((player) => player.id);
      const myAfter = [...mine.filter((id) => !giveIds.includes(id)), get.id];
      // A one-for-two leaves you a spot short; the full evaluation picks the free agent.
      const gain = projectedWeekly(model, myAfter, screenWeeks) - mineBefore;
      if (gain < minGain - (gives.length - 1) * 2) return;
      // Receiving two for one, they drop their weakest player.
      let theirAfter = [...theirs.filter((id) => id !== get.id), ...giveIds];
      const dropped = gives.length > 1 ? weakest : null;
      if (dropped) theirAfter = theirAfter.filter((id) => id !== dropped.id);
      const theirGain = projectedWeekly(model, theirAfter, screenWeeks) - theirsBefore;
      const received = sumAverage(gives) - (dropped?.average ?? 0);
      const chance = chanceFrom(theirGain, received, get.average, urgency);
      if (chance < SCREEN_FLOOR) return;
      screened.push({
        offer: { teamA: rosterId, teamB: team.rosterId, aGives: giveIds, bGives: [get.id] },
        quick: rank(gain, chance),
      });
    };

    for (const get of targets) {
      for (const give of givers) {
        // Without a named player, skip swaps of players worlds apart (they cannot suit both
        // teams) and swaps for a clearly lesser player (they rarely help you).
        if (!targeted && Math.abs(give.expected - get.expected) > 0.4 * Math.max(give.expected, get.expected)) continue;
        if (!targeted && get.expected < 0.85 * give.expected) continue;
        consider([give], get);
      }
      // Two of the user's players for a named target.
      if (options.getPlayerId) {
        const pool = players(model, mine).filter((player) => player.games > 0 && player.expected < get.expected);
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const pair = [pool[i]!, pool[j]!];
            if (options.givePlayerId && !pair.some((player) => player.id === options.givePlayerId)) continue;
            const combined = pair[0]!.expected + pair[1]!.expected;
            if (combined < 0.9 * get.expected || combined > 1.8 * get.expected) continue;
            consider(pair, get);
          }
        }
      }
    }
  }

  const gain = (side: TradeSide) => side.projectedAfter - side.projectedBefore;
  const order: Likelihood[] = ["likely", "possible", "long shot"];
  const evaluated = screened
    .sort((a, b) => b.quick - a.quick)
    .slice(0, limit * 4)
    .map(({ offer }) => {
      const result = evaluateTrade(model, snapshot, offer);
      const chance = acceptanceChance(result.b, situations.get(offer.teamB)?.urgency ?? 0);
      return { offer, result, chance, likelihood: likelihood(chance) };
    })
    .filter(({ result }) => gain(result.a) >= minGain)
    .sort(
      (a, b) =>
        order.indexOf(a.likelihood) - order.indexOf(b.likelihood) ||
        rank(gain(b.result.a), b.chance) - rank(gain(a.result.a), a.chance),
    )
    // Variety: no single player may appear in more than two ideas (a named player excepted).
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
    );

  // Show likely ideas; fill out a short list with possible ones; long shots only if nothing else.
  const likely = evaluated.filter((idea) => idea.likelihood === "likely");
  const possible = evaluated.filter((idea) => idea.likelihood === "possible");
  const longShots = evaluated.filter((idea) => idea.likelihood === "long shot");
  let chosen: typeof evaluated;
  let outlook: FinderResult["outlook"];
  if (likely.length > 0) {
    chosen = [...likely, ...possible.slice(0, Math.max(0, 3 - likely.length))].slice(0, limit);
    outlook = "likely";
  } else if (possible.length > 0) {
    chosen = possible.slice(0, Math.min(limit, 5));
    outlook = "possible";
  } else if (longShots.length > 0) {
    chosen = longShots.slice(0, 3);
    outlook = "long-shot";
  } else {
    chosen = [];
    outlook = "none";
  }

  const myProfile = positionProfile(model, snapshot, mine);
  const theirProfiles = new Map<number, PositionNote[]>();
  const profileOf = (id: number) => {
    if (!theirProfiles.has(id)) theirProfiles.set(id, positionProfile(model, snapshot, rosterIds(snapshot, id)));
    return theirProfiles.get(id)!;
  };
  return {
    outlook,
    ideas: chosen.map((idea) => ({
      ...idea,
      story: tradeStory(
        model,
        snapshot,
        idea.result,
        { mine: myProfile, theirs: profileOf(idea.offer.teamB) },
        situations.get(idea.offer.teamB),
      ),
    })),
  };
}

/** Plain words for a grade, so "C" reads as "about even" rather than as a poor mark. */
export function gradeWord(grade: number): string {
  if (grade >= 80) return "Big win";
  if (grade >= 57) return "Win";
  if (grade >= 43) return "About even";
  if (grade >= 20) return "Loss";
  return "Big loss";
}
