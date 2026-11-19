// Three-team trades. Every team is measured exactly as in a two-team trade
// (measureSide: its roster before and after, each run through fillRoster),
// so a team's grade and strength change mean the same thing either way. What
// is new is only the shape of the deal and the acceptance: both other
// managers have to say yes, so the chance is their two chances multiplied,
// each worked out as for a two-team trade (acceptance in shared/trade.ts).
//
// The finder uses three-team trades only when asked (the toggle on the
// Trades tab). It looks for triangles: you send a player to one team, that
// team sends a player to a third, and the third sends a player to you. A
// triangle earns its place when a straight swap fails because the team with
// the player you want has no use for what you offer, but another team does,
// and has something the first team wants.

import type { TeamSituation } from "./insight.ts";
import { type ModelPlayer, projectedWeekly, type StrengthModel } from "./strength.ts";
import {
  acceptance,
  BIG_LOSS,
  type Chance,
  chanceFrom,
  droppedOnArrival,
  EXPAND,
  type FinderOptions,
  type FinderResult,
  ideaRank,
  isInjuredTarget,
  LIKELY,
  type Likelihood,
  likelihood,
  limitRepeats,
  MAX_PRICE,
  measureSide,
  MIN_GAIN,
  MIN_LIFT,
  MISS_FLOOR,
  NOTABLE_FIT,
  noReserveNote,
  OPEN_SCREEN_WEEKS,
  pickIdeas,
  pickupNote,
  players,
  playerValue,
  quickRosterAfter,
  REAL_CHANGE,
  rosterIds,
  SCREEN_FLOOR,
  SCREEN_WEEKS,
  sumAverage,
  SWEETENERS,
  type TradeIdea,
  tradePhases,
  type TradeSide,
  type TradeStory,
} from "./trade.ts";
import type { LeagueSnapshot } from "./types.ts";

export interface ThreeTeamMove {
  playerId: string;
  from: number;
  to: number;
}

export interface ThreeTeamOffer {
  /** The three roster IDs. The first is the team the trade is judged for: yours, in the finder. */
  teams: [number, number, number];
  /** Every player in the deal, where he comes from and where he goes. */
  moves: ThreeTeamMove[];
}

export interface ThreeTeamResult {
  /** One side per team, in the offer's order. */
  sides: [TradeSide, TradeSide, TradeSide];
}

/** Players a team sends and receives in a three-team offer. */
export function movesFor(offer: ThreeTeamOffer, rosterId: number): { gives: string[]; gets: string[] } {
  return {
    gives: offer.moves.filter((move) => move.from === rosterId).map((move) => move.playerId),
    gets: offer.moves.filter((move) => move.to === rosterId).map((move) => move.playerId),
  };
}

/**
 * What is wrong with an offer, in plain words, or null when it can be
 * measured: three different teams, every move between two of them, and
 * every team in the deal (sending or receiving at least one player).
 */
export function threeTeamProblem(offer: ThreeTeamOffer, teamName: (rosterId: number) => string): string | null {
  const [a, b, c] = offer.teams;
  if (a === b || b === c || a === c) return "Choose three different teams.";
  if (offer.moves.some((move) => move.from === move.to || !offer.teams.includes(move.from) || !offer.teams.includes(move.to))) {
    return "Every player has to go to one of the other two teams.";
  }
  const left = offer.teams.filter((rosterId) => !offer.moves.some((move) => move.from === rosterId || move.to === rosterId));
  if (left.length > 0) return `${left.map(teamName).join(" and ")} ${left.length === 1 ? "is" : "are"} not in the trade yet: tick a player to send, or send one there.`;
  return null;
}

export function evaluateThreeTeam(model: StrengthModel, snapshot: LeagueSnapshot, offer: ThreeTeamOffer): ThreeTeamResult {
  // As in a two-team trade: each team looks at the waiver wire as it is, and
  // no player in the deal is a free agent for anyone.
  const traded = new Set(offer.moves.map((move) => move.playerId));
  const sides = offer.teams.map((rosterId) => {
    const { gives, gets } = movesFor(offer, rosterId);
    return measureSide(model, rosterId, rosterIds(snapshot, rosterId), gives, gets, new Set(traded));
  });
  return { sides: sides as [TradeSide, TradeSide, TradeSide] };
}

export interface ThreeTeamChance {
  /** The chance both other managers accept: their two chances multiplied. */
  chance: number;
  /** Each other manager's chance, with its parts, worked out as for a two-team trade. */
  each: { rosterId: number; chance: Chance }[];
}

/** The chance both other teams (the second and third sides) accept. */
export function threeTeamAcceptance(result: ThreeTeamResult, urgencyOf: (rosterId: number) => number): ThreeTeamChance {
  const each = result.sides.slice(1).map((side) => ({ rosterId: side.rosterId, chance: acceptance(side, urgencyOf(side.rosterId)) }));
  return { chance: each.reduce((product, entry) => product * entry.chance.chance, 1), each };
}

const fixed = (value: number) => value.toFixed(2);
const signed = (value: number) => (value >= 0 ? `+${value.toFixed(2)}` : `−${(-value).toFixed(2)}`);
const shortDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Explains a three-team trade from the first team's point of view, in the
 * same voice as tradeStory. An explanation only: nothing here feeds a grade,
 * a chance or a ranking.
 */
export function threeTeamStory(model: StrengthModel, snapshot: LeagueSnapshot, result: ThreeTeamResult): TradeStory {
  const [you, ...others] = result.sides;
  const name = (side: TradeSide) => snapshot.teams.find((team) => team.rosterId === side.rosterId)?.teamName ?? "They";
  const gains = you.teamChange >= REAL_CHANGE;
  const evenOnValue = Math.abs(you.valueReceived - you.valueSent) <= Math.max(1, 0.1 * Math.max(you.valueReceived, you.valueSent));
  const kind: TradeStory["kind"] = gains
    ? others.every((side) => side.teamChange >= REAL_CHANGE)
      ? "win-win"
      : evenOnValue
        ? "fair-for-you"
        : you.valueChange >= NOTABLE_FIT
          ? "value-edge"
          : "fit-for-you"
    : you.teamChange <= -REAL_CHANGE
      ? "costs-you"
      : "even";
  const headline = {
    "win-win": "All three teams get stronger",
    "fair-for-you": "Even on paper, better for your roster",
    "value-edge": "You come out ahead on player value",
    "fit-for-you": "Worth more to your roster than on paper",
    "costs-you": "Costs your team strength",
    even: "About even all round",
    leverage: "You get more player value, because your side is worth more to them",
  }[kind];

  const notes: string[] = [];
  if (evenOnValue) notes.push(`Even on player value for you: about ${fixed(you.valueReceived)} a week in and out, above free-agent level.`);
  else if (you.valueChange > 0) notes.push(`You get ${fixed(you.valueChange)} a week more player value (${fixed(you.valueReceived)} for ${fixed(you.valueSent)}).`);
  else notes.push(`You give up ${fixed(-you.valueChange)} a week of player value (${fixed(you.valueSent)} for ${fixed(you.valueReceived)}).`);
  if (you.fit >= NOTABLE_FIT) notes.push(`Worth ${fixed(you.fit)} a week more to your roster than its player value.`);
  if (you.fit <= -NOTABLE_FIT) notes.push(`Fits your roster poorly: worth ${fixed(-you.fit)} a week less to you than its player value.`);
  for (const side of others) {
    if (side.teamChange >= REAL_CHANGE) notes.push(`${name(side)} get stronger too (${signed(side.teamChange)} a week).`);
    else if (side.teamChange <= -REAL_CHANGE) notes.push(`${name(side)} get weaker (${signed(side.teamChange)} a week).`);
  }
  const phases = tradePhases(model, you);
  if (phases) {
    notes.unshift(
      `${phases.player.name} is back around ${shortDate(phases.backAround)}: ${signed(phases.whileOut)} a week for you until then, ${signed(phases.afterBack)} a week after.`,
    );
  }
  for (const pickup of you.pickups) notes.push(pickupNote(pickup));
  for (const { player, when } of you.leaving) notes.push(`${player.name} is dropped when ${when.name} is back from IR.`);
  for (const player of you.noReserve) notes.push(noReserveNote(player, you.reserve));
  // Always said, last: a three-team trade lives or dies on two answers.
  return { kind, headline, points: [...notes.slice(0, 6), `Needs a yes from both ${name(others[0]!)} and ${name(others[1]!)}.`] };
}

export interface ThreeTeamIdea {
  kind: "three";
  offer: ThreeTeamOffer;
  result: ThreeTeamResult;
  /** 0 to 1: the chance both other managers accept. */
  chance: number;
  /** Each other manager's own chance. */
  chances: { rosterId: number; chance: number }[];
  likelihood: Likelihood;
  story: TradeStory;
  /** 1 a triangle of one player each; 2 one of your spare players added. */
  depth: number;
}

export type FinderIdea = TradeIdea | ThreeTeamIdea;

export function isThreeTeam(idea: FinderIdea): idea is ThreeTeamIdea {
  return "kind" in idea && idea.kind === "three";
}

/** Your side of any idea: the team the finder works for. */
export function yourSide(idea: FinderIdea): TradeSide {
  return isThreeTeam(idea) ? idea.result.sides[0] : idea.result.a;
}

/** The other teams' sides of any idea. */
export function otherSides(idea: FinderIdea): TradeSide[] {
  return isThreeTeam(idea) ? idea.result.sides.slice(1) : [idea.result.b];
}

/** Every player in an idea. */
export function ideaPlayerIds(idea: FinderIdea): string[] {
  return isThreeTeam(idea) ? idea.offer.moves.map((move) => move.playerId) : [...idea.offer.aGives, ...idea.offer.bGives];
}

/** How many of your best swaps (most gain for you) each look for a third team to make them work. */
const ROUTES = 30;
/** With a player named, the search is narrower, so more of them. */
const TARGETED_ROUTES = 60;
/** Players tried on each go-between team to close a triangle: the closest in value. */
const LINKS = 4;
/** In a triangle each team swaps one player for one: they must be this close in weekly value (as in a two-team swap). */
const SWAP_SPREAD = 0.4;

interface Candidate {
  offer: ThreeTeamOffer;
  gain: number;
  chance: number;
  chances: number[];
  quick: number;
  depth: number;
}

/**
 * Three-team trades for `rosterId`, for the finder's toggle. Searched in two
 * layers, like the two-team search:
 *
 *   1. Triangles: for each of your best swaps (you send one player, a team
 *      sends you one), every other team that could sit between: it takes
 *      your player and sends the team you are trading with one of its own,
 *      close in value to both. Each team gives one and gets one.
 *   2. Only if no triangle is likely to be accepted: the most promising near
 *      misses grow by one of your spare players, sent to whichever of the two
 *      teams is less keen.
 *
 * Every idea is then measured in full, with the same rules as two-team
 * ideas: worth it for you, never a big loss (F) for either other team, no
 * player dropped as soon as he arrives, no near-copies. The chance is both
 * managers' chances multiplied, so a three-team idea has to be good for both
 * to rank: it is ranked with the two-team ideas by gain times that chance
 * (withThreeTeam).
 */
export function findThreeTeamTrades(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation>,
  options: FinderOptions = {},
  limit = 8,
): ThreeTeamIdea[] {
  const targeted = Boolean(options.givePlayerId || options.getPlayerId);
  const minGain = targeted ? -MAX_PRICE : MIN_GAIN;
  const screenWeeks = targeted ? SCREEN_WEEKS : OPEN_SCREEN_WEEKS;
  const mine = rosterIds(snapshot, rosterId);
  const myPlayers = players(model, mine);
  const at = (position: string | undefined) => (player: ModelPlayer) => !position || player.positions.includes(position);
  const givers = myPlayers.filter(
    (player) => player.games > 0 && at(options.givePosition)(player) && (!options.givePlayerId || player.id === options.givePlayerId),
  );
  const mineBefore = projectedWeekly(model, mine, screenWeeks);
  const urgency = (teamId: number) => situations.get(teamId)?.urgency ?? 0;

  interface TeamInfo {
    theirs: string[];
    before: number;
    byValue: ModelPlayer[];
  }
  const teams = new Map<number, TeamInfo>();
  const infoFor = (teamId: number): TeamInfo => {
    let info = teams.get(teamId);
    if (!info) {
      const theirs = rosterIds(snapshot, teamId);
      info = {
        theirs,
        before: projectedWeekly(model, theirs, screenWeeks),
        byValue: players(model, theirs).sort((x, y) => x.expected - y.expected),
      };
      teams.set(teamId, info);
    }
    return info;
  };
  const close = (x: ModelPlayer, y: ModelPlayer) => Math.abs(x.expected - y.expected) <= SWAP_SPREAD * Math.max(x.expected, y.expected);

  const candidates: Candidate[] = [];
  const misses: Candidate[] = [];
  const seen = new Set<string>();

  /** A quick read of an offer, as the two-team search does it: quick rosters on fewer weeks. */
  const consider = (offer: ThreeTeamOffer, depth: number, parentChance = 0) => {
    const key = offer.moves.map((move) => `${move.playerId}>${move.to}`).sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    const mineMoves = movesFor(offer, rosterId);
    const gain =
      projectedWeekly(model, quickRosterAfter(model, mine, mineMoves.gives, players(model, mineMoves.gets)), screenWeeks) - mineBefore;
    if (gain < minGain) return;
    const chances = offer.teams.slice(1).map((teamId) => {
      const info = infoFor(teamId);
      const { gives, gets } = movesFor(offer, teamId);
      const received = players(model, gets);
      const sent = players(model, gives);
      const theirGain = projectedWeekly(model, quickRosterAfter(model, info.theirs, gives, received), screenWeeks) - info.before;
      // What they see: the averages they get, less any player they would drop to make room.
      const dropped =
        received.length > sent.length
          ? info.byValue.filter((player) => !sent.includes(player)).slice(0, received.length - sent.length)
          : [];
      return chanceFrom(theirGain, sumAverage(received) - sumAverage(dropped), sumAverage(sent), urgency(teamId));
    });
    const chance = chances.reduce((product, value) => product * value, 1);
    if (depth > 1 && chance < parentChance + MIN_LIFT) return;
    const candidate: Candidate = { offer, gain, chance, chances, quick: ideaRank(gain, chance), depth };
    if (chance >= MISS_FLOOR && chance < LIKELY) misses.push(candidate);
    if (chance >= SCREEN_FLOOR) candidates.push(candidate);
  };

  // ---- Layer 1: triangles ----
  // Your side first: every swap that helps you, as the two-team search screens them.
  const routes: { give: ModelPlayer; get: ModelPlayer; from: number; gain: number }[] = [];
  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const targets = players(model, infoFor(team.rosterId).theirs).filter(
      (player) =>
        (player.games > 0 || isInjuredTarget(player)) &&
        at(options.getPosition)(player) &&
        (!options.getPlayerId || player.id === options.getPlayerId) &&
        (!options.getInjured || isInjuredTarget(player)),
    );
    for (const get of targets) {
      for (const give of givers) {
        if (!targeted && !close(give, get)) continue;
        if (!targeted && get.expected < 0.85 * give.expected) continue;
        const gain = projectedWeekly(model, quickRosterAfter(model, mine, [give.id], [get]), screenWeeks) - mineBefore;
        if (gain >= minGain) routes.push({ give, get, from: team.rosterId, gain });
      }
    }
  }
  routes.sort((x, y) => y.gain - x.gain);
  for (const route of routes.slice(0, targeted ? TARGETED_ROUTES : ROUTES)) {
    for (const middle of snapshot.teams) {
      if (middle.rosterId === rosterId || middle.rosterId === route.from) continue;
      // The go-between takes your player and sends the other team one of his own, close to both in value.
      const links = players(model, infoFor(middle.rosterId).theirs)
        .filter((player) => player.games > 0 && close(player, route.give) && close(player, route.get))
        .sort(
          (x, y) =>
            Math.abs(x.expected - route.give.expected) + Math.abs(x.expected - route.get.expected) -
            (Math.abs(y.expected - route.give.expected) + Math.abs(y.expected - route.get.expected)),
        )
        .slice(0, LINKS);
      for (const link of links) {
        consider(
          {
            teams: [rosterId, middle.rosterId, route.from],
            moves: [
              { playerId: route.give.id, from: rosterId, to: middle.rosterId },
              { playerId: link.id, from: middle.rosterId, to: route.from },
              { playerId: route.get.id, from: route.from, to: rosterId },
            ],
          },
          1,
        );
      }
    }
  }

  // ---- Layer 2: one of your spare players added, to the less keen team ----
  let depth = 1;
  if (!candidates.some((candidate) => candidate.chance >= LIKELY) && (options.maxDepth ?? 2) >= 2) {
    depth = 2;
    const parents = [...misses].sort((x, y) => y.quick - x.quick).slice(0, EXPAND);
    for (const parent of parents) {
      const sentByYou = new Set(movesFor(parent.offer, rosterId).gives);
      // As in the two-team search: worth a roster spot to them, cheap for you to replace.
      const spares = myPlayers
        .filter((player) => player.games > 0 && !player.irEligible && !sentByYou.has(player.id) && playerValue(model, player) > 0)
        .sort((x, y) => x.expected - y.expected)
        .slice(0, SWEETENERS);
      const lessKeen = parent.chances[0]! <= parent.chances[1]! ? parent.offer.teams[1] : parent.offer.teams[2];
      for (const spare of spares) {
        consider(
          { ...parent.offer, moves: [...parent.offer.moves, { playerId: spare.id, from: rosterId, to: lessKeen }] },
          2,
          parent.chance,
        );
      }
    }
  }

  // ---- Measure in full ----
  const byQuick = [...candidates].sort((x, y) => y.quick - x.quick);
  const shortlist = new Set([...byQuick.slice(0, limit * 4), ...byQuick.filter((candidate) => candidate.depth === depth).slice(0, limit * 2)]);
  const order: Likelihood[] = ["likely", "possible", "long shot"];
  const measured = [...shortlist].map((candidate) => {
    const result = evaluateThreeTeam(model, snapshot, candidate.offer);
    const both = threeTeamAcceptance(result, urgency);
    return {
      kind: "three" as const,
      offer: candidate.offer,
      result,
      chance: both.chance,
      chances: both.each.map((entry) => ({ rosterId: entry.rosterId, chance: entry.chance.chance })),
      likelihood: likelihood(both.chance),
      depth: candidate.depth,
    };
  });
  const yourGain = (idea: (typeof measured)[number]) => idea.result.sides[0].teamChange;
  const kept = measured
    .filter((idea) => yourGain(idea) >= minGain && idea.result.sides.slice(1).every((side) => side.grade >= BIG_LOSS))
    .filter((idea) => idea.result.sides.every((side) => !droppedOnArrival(side)))
    .sort((x, y) => order.indexOf(x.likelihood) - order.indexOf(y.likelihood) || ideaRank(yourGain(y), y.chance) - ideaRank(yourGain(x), x.chance))
    // No near-copies: the same players coming to you from the same team, built around the same main
    // piece you send. Which team sits in the middle is not a new idea, as swapping a filler is not.
    .filter(
      (() => {
        const keys = new Set<string>();
        return (idea: (typeof measured)[number]) => {
          const you = idea.result.sides[0];
          const named = options.givePlayerId ? you.gives.find((player) => player.id === options.givePlayerId) : undefined;
          const main = named ?? you.gives.reduce<ModelPlayer | null>((best, player) => (!best || player.expected > best.expected ? player : best), null);
          const sources = [...new Set(idea.offer.moves.filter((move) => move.to === rosterId).map((move) => move.from))].sort();
          const key = `${sources.join("+")}|${you.gets.map((player) => player.id).sort().join("+")}|${main?.id ?? ""}`;
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        };
      })(),
    )
    .slice(0, limit * 2);
  return kept.map((idea) => ({ ...idea, story: threeTeamStory(model, snapshot, idea.result) }));
}

export interface MixedFinderResult extends Omit<FinderResult, "ideas"> {
  ideas: FinderIdea[];
  /** The best three-team idea when none made the list (it ranked below the two-team ones), for a note. */
  bestThreeLeftOut: ThreeTeamIdea | null;
}

/**
 * The two-team ideas and the three-team ideas in one list, chosen by the
 * same rules as the two-team finder (pickIdeas): likely ideas first, then by
 * your gain times the chance, with the same variety rule across both kinds.
 * A three-team idea needs both managers, so it makes the list only when it
 * truly beats the two-team ideas.
 */
export function withThreeTeam(two: FinderResult, three: ThreeTeamIdea[], options: FinderOptions = {}, limit = 8): MixedFinderResult {
  const order: Likelihood[] = ["likely", "possible", "long shot"];
  const gain = (idea: FinderIdea) => yourSide(idea).teamChange;
  const sorted = [...two.ideas, ...three]
    .sort((x, y) => order.indexOf(x.likelihood) - order.indexOf(y.likelihood) || ideaRank(gain(y), y.chance) - ideaRank(gain(x), x.chance))
    .filter(limitRepeats(ideaPlayerIds, options));
  const { chosen, outlook } = pickIdeas(sorted, limit, {
    targeted: Boolean(options.givePlayerId || options.getPlayerId),
    yourChange: gain,
    theirWorstGrade: (idea) => Math.min(...otherSides(idea).map((side) => side.grade)),
  });
  const anyThree = chosen.some(isThreeTeam);
  return {
    ideas: chosen,
    outlook,
    depth: Math.max(two.depth, ...three.filter((idea) => chosen.includes(idea)).map((idea) => idea.depth)),
    bestThreeLeftOut: anyThree ? null : (three[0] ?? null),
  };
}
