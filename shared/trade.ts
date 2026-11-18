import { rosterPlayers } from "./analysis.ts";
import {
  deepestSpot,
  MARKET_GAP_NOTE,
  marketGap,
  positionProfile,
  type PositionNote,
  type TeamSituation,
  thinnestSpot,
} from "./insight.ts";
import {
  fillRoster,
  type ModelPlayer,
  type Pickup,
  projectByWeek,
  projectedWeekly,
  standIn,
  strengthScore,
  type StrengthModel,
} from "./strength.ts";
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
  /** The same pickups, each noting whether he plays only until a player on IR is back. */
  pickups: Pickup[];
  /** Players the trade puts on injured reserve. */
  toReserve: ModelPlayer[];
  /** Players already on the roster who, after the trade, are dropped when a player on IR is back. */
  leaving: { player: ModelPlayer; when: ModelPlayer }[];
  /** Players received who could go on IR, but every IR slot is taken (by `reserve`), so they use a bench spot. */
  noReserve: ModelPlayer[];
  /** Who is on IR after the trade. */
  reserve: ModelPlayer[];
  /** The rosters the projection plays before and after (stand-ins by their stand-in IDs). */
  beforeIds: string[];
  afterIds: string[];
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

/**
 * A player's own weekly value above a typical free agent. Never below zero.
 * An injured player counts only in the weeks he plays: while he is out, an
 * IR slot and a pickup cover his spot, so the zeros are not held against him
 * here (the team effect still counts them).
 */
export function playerValue(model: StrengthModel, player: ModelPlayer): number {
  const playing = 1 - player.outShare;
  if (player.outShare > 0) {
    return playing > 0 ? Math.max(0, player.expected / playing - model.replacementWeekly) * playing : 0;
  }
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

function side(
  model: StrengthModel,
  rosterId: number,
  before: string[],
  gives: string[],
  gets: string[],
  claimed: Set<string>,
): TradeSide {
  // Both rosters are run the same way (IR, then waivers), so the trade is
  // credited only with the spots it opens. See fillRoster.
  const baseline = fillRoster(model, before, new Set(claimed));
  const filled = fillRoster(
    model,
    [...before.filter((id) => !gives.includes(id)), ...gets],
    new Set(claimed),
    baseline.adds.map((add) => add.player.id),
  );
  // A pickup the team makes either way is not the trade's doing, even if it
  // now covers a different player on IR.
  const key = (add: Pickup) => add.player.id;
  const already = new Set(baseline.adds.map(key));
  const pickups = filled.adds.filter((add) => !already.has(key(add)));
  const drops = filled.drops.filter((player) => !baseline.drops.includes(player)).map((player) => player.id);
  const adds = pickups.map((add) => add.player.id);
  const toReserve = filled.reserve.filter((player) => !baseline.reserve.includes(player));
  const leaving = filled.leaving.filter(({ player }) => !baseline.leaving.some((entry) => entry.player === player));
  const noReserve = filled.reserve.length > 0 ? players(model, gets).filter((player) => player.irEligible && !filled.reserve.includes(player)) : [];

  const projectedBefore = projectedWeekly(model, baseline.ids);
  const projectedAfter = projectedWeekly(model, filled.ids);
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
    pickups,
    toReserve,
    leaving,
    noReserve,
    reserve: filled.reserve,
    beforeIds: baseline.ids,
    afterIds: filled.ids,
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
  // Each team looks at the waiver wire as it is: both may want the same free
  // agent, but only for their own what-if, before and after alike. Players in
  // the trade are never free agents.
  const traded = [...offer.aGives, ...offer.bGives];
  const a = side(model, offer.teamA, rosterIds(snapshot, offer.teamA), offer.aGives, offer.bGives, new Set(traded));
  const b = side(model, offer.teamB, rosterIds(snapshot, offer.teamB), offer.bGives, offer.aGives, new Set(traded));
  const total = a.valueReceived + b.valueReceived;
  const valueBalance = total > 0 ? Math.min(97, Math.max(3, 50 + (50 * (b.valueReceived - a.valueReceived)) / total)) : 50;
  return { a, b, valueBalance };
}

// ---- Why a trade is the way it is -------------------------------------------
//
// An explanation only: nothing here changes a grade, a chance or a ranking.
// It compares the trade on player value alone with its effect on each team,
// and names what explains the gap.

/**
 * A team effect smaller than this (points a week) counts as no real change.
 * It is where the letter grade turns from C+ ("About even") to B- ("Win"),
 * so the labels and the letters always agree.
 */
const REAL_CHANGE = GRADE_STEP * Math.log(57 / 43);
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
/** A traded player's injury in two parts: the weeks he is out and the weeks after he is back. */
export interface TradePhases {
  /** The injured player the split is about. */
  player: ModelPlayer;
  /** Middle of his return window, YYYY-MM-DD. */
  backAround: string;
  /** Real weeks (from the current one) before he is more likely back than not. */
  weeksOut: number;
  /** Change in this side's projected weekly score while he is out, and after. */
  whileOut: number;
  afterBack: number;
}

/** Players this out share or more are "injured" for trades (a few days away is not). */
export const INJURED_SHARE = 0.05;

/** The injured player who matters most in a trade side: received or sent, out the largest share of the weeks left. */
function injuredIn(side: TradeSide): ModelPlayer | null {
  const candidates = [...side.gets, ...side.gives].filter(
    (player) => player.back && player.outShare >= INJURED_SHARE && player.outShare < 0.98,
  );
  return candidates.reduce<ModelPlayer | null>((most, player) => (!most || player.outShare > most.outShare ? player : most), null);
}

/**
 * The trade's effect on one side split at an injured player's return: the
 * weeks he is out, then the rest. Null when no traded player is out with a
 * return date inside the weeks left. An explanation only: the grade uses the
 * whole rest of the season.
 */
export function tradePhases(model: StrengthModel, side: TradeSide): TradePhases | null {
  const player = injuredIn(side);
  if (!player?.back || !player.returnExpected || player.returnExpected === "season") return null;
  const weeksOut = player.back.findIndex((chance) => chance >= 0.5);
  if (weeksOut <= 0) return null;
  const before = projectByWeek(model, side.beforeIds);
  const after = projectByWeek(model, side.afterIds);
  const change = after.map((value, index) => value - (before[index] ?? 0));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return {
    player,
    backAround: player.returnExpected,
    weeksOut,
    whileOut: mean(change.slice(0, weeksOut)),
    afterBack: mean(change.slice(weeksOut)),
  };
}

/** Why a received injured player takes a bench spot: the IR slots are full. */
export function noReserveNote(player: ModelPlayer, reserve: ModelPlayer[]): string {
  const names = reserve.map((entry) => entry.name).join(" and ");
  return `Your IR is taken by ${names}, so ${player.name} uses a bench spot while out and no waiver pickup covers him.`;
}

/** One line on a waiver pickup a trade leads to. */
export function pickupNote(pickup: Pickup): string {
  return pickup.forInjured
    ? `You pick up ${pickup.player.name} from waivers until ${pickup.forInjured.name} is back from IR.`
    : `You pick up ${pickup.player.name} from waivers for the open spot.`;
}

const shortDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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

  // An injured player: what he costs while out, what he adds once back, and
  // the IR spot and pickup that cover the gap.
  const phases = tradePhases(model, a);
  if (phases) {
    const name = phases.player.name;
    notes.unshift(
      `${name} is back around ${shortDate(phases.backAround)}: ${signed(phases.whileOut)} a week for you until then, ${signed(phases.afterBack)} a week after.`,
    );
  }
  for (const pickup of a.pickups) notes.push(pickupNote(pickup));
  for (const { player, when } of a.leaving) notes.push(`${player.name} is dropped when ${when.name} is back from IR.`);
  for (const player of a.noReserve) notes.push(noReserveNote(player, a.reserve));

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
  /** Only trades that bring back a player who is out now with a return date this season. */
  getInjured?: boolean;
}

/** An injured trade target misses at least this share of the weeks left (about two weeks of eighteen). */
const INJURED_TARGET_SHARE = 0.1;

/** An injured player worth trading for: out a real share of the weeks left, but due back before the season ends. */
export function isInjuredTarget(player: ModelPlayer): boolean {
  return Boolean(player.back) && player.outShare >= INJURED_TARGET_SHARE && player.outShare < 0.95 && player.projected > 0;
}

/**
 * Weeks used for the first pass over every possible swap. The shortlist is
 * re-checked over all the weeks, so this only has to rank roughly; every
 * player sees the same weeks on any roster, which keeps the comparison fair.
 */
const SCREEN_WEEKS = 24;
/** An open search tries many more swaps, so it screens on fewer weeks. */
const OPEN_SCREEN_WEEKS = 16;

// ---- Will they accept? ------------------------------------------------------
//
// A reasoned estimate, not a measured probability. It starts from a manager's
// reluctance to give up his own players and adds three separate parts, each
// with a fixed limit, combined on the log-odds scale so that one bad part
// pulls the chance down however good the others look:
//
//   What they see:      the averages they get back against what they send,
//                       with their own players counted 8% higher (managers
//                       overvalue what they have). Up to +0.8 for a clear
//                       win, down to -2.0 for a clear loss.
//   Their team:         what the trade does to their projected weekly score.
//                       A manager senses this through his own needs: a thin
//                       position filled, an injury covered. A gain counts
//                       three quarters, a loss one and a half times (a loss
//                       is felt more). Up to +1.25, down to -2.0.
//   Pressure:           long absences, a losing record, a tough matchup this
//                       week. Up to +0.6, never negative.
//
// An even trade (equal averages, changes nothing, typical pressure) comes out
// at about a third: in fantasy even a fair offer is usually turned down.

/** Reluctance to trade at all, on the log-odds scale. */
const RELUCTANCE = -0.3;
/** Their own players look this much better to them than the same averages on someone else's roster. */
export const OWN_PLAYER_PREMIUM = 1.08;
const SEEN_SCALE = 6; // a 10% edge on averages is worth about 0.57
const SEEN_LIMITS = [-2, 0.8] as const;
const TEAM_SCALE = 2.5; // 2.5 points a week is worth 1.0, before the weights below
const TEAM_GAIN_WEIGHT = 0.75;
const TEAM_LOSS_WEIGHT = 1.5;
// A trade that clearly costs their team can pull the chance down further
// than a gain can lift it, as with what they see on averages.
const TEAM_LIMITS = [-2, 1.25] as const;
const PRESSURE_WEIGHT = 0.6;
/**
 * What a manager sees of an injured player: his average, scaled down by the
 * share of the weeks left he will miss, plus a near-term overreaction (the
 * zeros are in front of him). At most this much of his average is discounted.
 */
const INJURY_OVERREACTION = 0.1;
const INJURY_SEEN_LIMIT = 0.8;

/** A player's average as a manager weighing a trade sees it: lower while he is out injured. */
export function seenAverage(player: ModelPlayer): number {
  const discount = Math.min(INJURY_SEEN_LIMIT, player.outShare * (1 + INJURY_OVERREACTION));
  return player.average * (1 - discount);
}

export interface ChancePart {
  label: string;
  /** Percentage points the chance would lose if this part were left out (negative when it lowers it). */
  points: number;
}

export interface Chance {
  chance: number;
  parts: ChancePart[];
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function chanceParts(theirWeeklyGain: number, receivedAverage: number, sentAverage: number, urgency: number): Chance {
  const ratio = sentAverage > 0 ? Math.max(0.01, receivedAverage) / (sentAverage * OWN_PLAYER_PREMIUM) : 2;
  const seen = clamp(Math.log(ratio) * SEEN_SCALE, SEEN_LIMITS[0], SEEN_LIMITS[1]);
  const felt = theirWeeklyGain * (theirWeeklyGain >= 0 ? TEAM_GAIN_WEIGHT : TEAM_LOSS_WEIGHT);
  const team = clamp(felt / TEAM_SCALE, TEAM_LIMITS[0], TEAM_LIMITS[1]);
  const pressure = PRESSURE_WEIGHT * clamp(urgency, 0, 1);
  const total = RELUCTANCE + seen + team + pressure;
  const chance = logistic(total);
  const without = (term: number) => Math.round((chance - logistic(total - term)) * 100);
  return {
    chance,
    parts: [
      { label: "What they see on averages", points: without(seen) },
      { label: "What it does to their team", points: without(team) },
      { label: "Pressure on their team", points: without(pressure) },
    ],
  };
}

export function chanceFrom(theirWeeklyGain: number, receivedAverage: number, sentAverage: number, urgency: number): number {
  return chanceParts(theirWeeklyGain, receivedAverage, sentAverage, urgency).chance;
}

const sumAverage = (list: ModelPlayer[]) => list.reduce((total, player) => total + seenAverage(player), 0);

/** The chance the other side (`theirs`) accepts, with its parts. */
export function acceptance(theirs: TradeSide, urgency: number): Chance {
  // They know a two-for-one costs them a roster spot, so the player they
  // would drop is subtracted and any pickup is added (a stand-in only for
  // the share of weeks he plays).
  const pickups = theirs.pickups.reduce(
    (total, pickup) => total + seenAverage(pickup.player) * (pickup.forInjured ? pickup.forInjured.outShare : 1),
    0,
  );
  const received = sumAverage(theirs.gets) + pickups - sumAverage(theirs.drops);
  return chanceParts(theirs.teamChange, received, sumAverage(theirs.gives), urgency);
}

export function acceptanceChance(theirs: TradeSide, urgency: number): number {
  return acceptance(theirs, urgency).chance;
}

/** How likely an idea is to be accepted, in three plain bands. */
export type Likelihood = "likely" | "possible" | "long shot";
// Even a good offer is often turned down, so "likely" starts at even odds.
export const LIKELY = 0.5;
export const POSSIBLE = 0.35;

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
  const myNeed = thinnestSpot(mine);
  if (myNeed && result.a.gets.some((player) => player.positions.includes(myNeed.position))) {
    reasons.push(`Fills your thinnest spot, ${myNeed.position}.`);
  }
  const myDepth = deepestSpot(mine);
  if (myDepth && result.a.gives.some((player) => player.positions.includes(myDepth.position))) {
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
  const theirNeed = thinnestSpot(theirs);
  if (theirNeed && result.b.gets.some((player) => player.positions.includes(theirNeed.position))) {
    reasons.push(`${team?.teamName ?? "They"} are thin at ${theirNeed.position}, which this fills.`);
  }
  if (situation && team) {
    const out = situation.longTermOut[0];
    if (out) reasons.push(`${team.teamName} have ${out.name} out for a stretch, so they may want help now.`);
    else if (situation.winShare < 0.4) reasons.push(`${team.teamName} are ${team.wins}-${team.losses} and may want a change.`);
  }
  return reasons.slice(0, 5);
}

/**
 * Two offers with the same key are versions of one idea: the same partner,
 * the same players received, and the same main piece sent (your most
 * valuable player in the offer).
 */
export function similarityKey(offer: TradeOffer, result: TradeResult): string {
  const main = result.a.gives.reduce<ModelPlayer | null>((best, player) => (!best || player.expected > best.expected ? player : best), null);
  return `${offer.teamB}|${[...offer.bGives].sort().join("+")}|${main?.id ?? ""}`;
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
const SCREEN_FLOOR = 0.18;

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
  const seenOffers = new Set<string>();
  const profiles = new Map<number, PositionNote[]>();
  const profileOf = (id: number) => {
    if (!profiles.has(id)) profiles.set(id, positionProfile(model, snapshot, rosterIds(snapshot, id)));
    return profiles.get(id)!;
  };
  // A real gain is weighed by its chance. Ideas that gain you nothing (or
  // cost a little, when a player is named) rank below every real gain, the
  // more likely and cheaper ones first.
  const rank = (gain: number, chance: number) => (gain >= 0.05 ? gain * chance : gain + chance - 1);

  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const theirs = rosterPlayers(team).map((player) => player.id);
    const targets = players(model, theirs).filter(
      (player) =>
        (player.games > 0 || isInjuredTarget(player)) &&
        at(options.getPosition)(player) &&
        (!options.getPlayerId || player.id === options.getPlayerId) &&
        (!options.getInjured || isInjuredTarget(player)),
    );
    if (targets.length === 0) continue;
    const theirsBefore = projectedWeekly(model, theirs, screenWeeks);
    const urgency = situations.get(team.rosterId)?.urgency ?? 0;
    const weakest = players(model, theirs).reduce((a, b) => (b.expected < a.expected ? b : a));

    const consider = (gives: ModelPlayer[], get: ModelPlayer) => {
      const giveIds = gives.map((player) => player.id);
      const myAfter = [...mine.filter((id) => !giveIds.includes(id)), get.id];
      // An injured player you receive can go on IR while he is out, and the
      // best free agent stands in: a quick version of what the full
      // evaluation does (fillRoster). A one-for-two leaves you a spot short;
      // the full evaluation picks that free agent too.
      if (get.back && get.irEligible && get.outShare > 0) {
        const onReserve = players(model, myAfter).filter((player) => player.irEligible).length;
        const freeAgent = model.players.get(model.freeAgentIds[0] ?? "");
        if (onReserve <= model.rosterLimits.reserve && freeAgent) myAfter.push(standIn(model, freeAgent, get).id);
      }
      const gain = projectedWeekly(model, myAfter, screenWeeks) - mineBefore;
      if (gain < minGain - (gives.length - 1) * 2) return;
      // Receiving two for one, they drop their weakest player.
      let theirAfter = [...theirs.filter((id) => id !== get.id), ...giveIds];
      const dropped = gives.length > 1 ? weakest : null;
      if (dropped) theirAfter = theirAfter.filter((id) => id !== dropped.id);
      const theirGain = projectedWeekly(model, theirAfter, screenWeeks) - theirsBefore;
      const received = sumAverage(gives) - (dropped ? seenAverage(dropped) : 0);
      const chance = chanceFrom(theirGain, received, seenAverage(get), urgency);
      if (chance < SCREEN_FLOOR) return;
      const key = `${team.rosterId}:${[...giveIds].sort().join("+")}:${get.id}`;
      if (seenOffers.has(key)) return;
      seenOffers.add(key);
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
      // Two of the user's players for a named target, or for an injured
      // player (whose weekly value counts the weeks he is out, so his level
      // once back is what a package has to match).
      if (options.getPlayerId || options.getInjured) {
        const level = get.outShare > 0 ? get.expected / Math.max(0.2, 1 - get.outShare) : get.expected;
        const pool = players(model, mine).filter((player) => player.games > 0 && player.expected < level);
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            const pair = [pool[i]!, pool[j]!];
            if (options.givePlayerId && !pair.some((player) => player.id === options.givePlayerId)) continue;
            const combined = pair[0]!.expected + pair[1]!.expected;
            if (combined < 0.9 * level || combined > 1.8 * level) continue;
            consider(pair, get);
          }
        }
      }
    }

    // Selling to a need. When this team is thin at a position where you have
    // a player, offer him plus one of your spare players for one of their
    // better players at a position where they have depth. They fill a hole,
    // you consolidate two roster spots into an upgrade. Guided by measured
    // needs, so only a handful of packages per team are tried.
    if (!targeted && !options.givePosition) {
      const theirProfile = profileOf(team.rosterId);
      const needs = theirProfile.filter((note) => note.need >= NOTABLE_FIT).sort((a, b) => b.need - a.need).slice(0, 2);
      const depth = new Set(theirProfile.filter((note) => note.cover >= 0.8 * (note.best?.expected ?? Infinity)).map((note) => note.position));
      const myPlayers = players(model, mine).filter((player) => player.games > 0).sort((a, b) => b.expected - a.expected);
      const spares = myPlayers.slice(-4);
      const upgrades = targets
        .filter((player) => player.positions.some((position) => depth.has(position)))
        .sort((a, b) => b.expected - a.expected)
        .slice(0, 3);
      for (const need of needs) {
        const fillers = myPlayers.filter((player) => player.positions.includes(need.position)).slice(0, 2);
        for (const filler of fillers) {
          for (const spare of spares) {
            if (spare === filler) continue;
            for (const get of upgrades) {
              // An upgrade for you, and not so far above the package that it cannot work.
              if (get.expected <= filler.expected || get.expected > 1.6 * (filler.expected + spare.expected)) continue;
              consider([filler, spare], get);
            }
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
    // No near-copies: offers to the same team, for the same players, built
    // around the same main piece (your most valuable player sent) are one
    // idea; only the best version stays. Swapping the filler is not a new idea.
    .filter(
      (() => {
        const seen = new Set<string>();
        return ({ offer, result }: { offer: TradeOffer; result: TradeResult }) => {
          const key = similarityKey(offer, result);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        };
      })(),
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

  // When there are enough real wins for you (B- or better), leave out the
  // trades that are only about even for you; otherwise keep them.
  const wins = evaluated.filter((idea) => idea.result.a.teamChange >= REAL_CHANGE);
  if (!targeted && wins.length >= 3) evaluated.splice(0, evaluated.length, ...wins);

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

  const myProfile = profileOf(rosterId);
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
