// The best moves a team could make, trades and waiver pickups together,
// ranked by how much each raises the team's strength over the rest of the
// season. Trades come from the same search as "see the best trades for my
// team" (findTrades, which leaves long injuries out), plus the best trade
// for an injured player (findTrades with getInjured); pickups from
// freeAgentPickups. All are measured the same way here: the change in
// strength from the full projection.

import { freeAgentPickups, type TeamSituation } from "./insight.ts";
import { rosterPlayers } from "./analysis.ts";
import { fillRoster, type ModelPlayer, projectedWeekly, type StrengthModel, strengthScore } from "./strength.ts";
import { type FinderResult, findTrades, type Likelihood, reserveMoves, type SearchProgress, type TradeIdea } from "./trade.ts";
import type { LeagueSnapshot } from "./types.ts";

export interface Move {
  kind: "trade" | "pickup";
  /** Players coming in: for a trade, those received; for a pickup, the free agent. */
  gets: ModelPlayer[];
  /** Players going out: for a trade, those sent; for a pickup, the drop. */
  gives: ModelPlayer[];
  /** For a trade, the roster moves you would make after it (IR, waiver pickups, drops), one line each. Not part of the offer. */
  management: string[];
  /** The other team in a trade; null for a pickup. */
  partner: number | null;
  /** Change in team strength (1 to 1000 scale). The ranking. */
  strengthChange: number;
  /** Change in projected weekly score, the number behind the strength change; breaks ties. */
  weeklyChange: number;
  /** Chance the other manager accepts; null for a pickup, which needs no one's yes. */
  chance: number | null;
  likelihood: Likelihood | null;
  /** The trade idea, to open it in the builder. */
  idea: TradeIdea | null;
  /** A trade for an injured player (from that search, given its own place). */
  forInjured?: boolean;
  /** A short note for some players, by ID. */
  notes: Record<string, string>;
}

/**
 * The `limit` best moves for `rosterId`, biggest strength gain first.
 * Trades are the ideas from "see the best trades for my team" (the same
 * search, `findTrades` with no options, so the page can share one answer
 * between this and the Trades tab; long injuries are left out of it) that
 * stand at least a fair chance (long shots are left out: they are not moves
 * you could make). Pickups earn a place on merit; when none does, the best
 * one that helps still gets a place, so the waiver wire is always in view.
 * The best trade for an injured player (the "trade for an injured player"
 * search) gets one place too, when one helps with a fair chance. Places
 * given this way come off the bottom of the list; the rest keep their order.
 */
export function topMoves(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation>,
  limit = 5,
  /** Told how far the trade search behind the moves has got, for a progress bar. */
  onProgress?: SearchProgress,
  /** That search's answer, when it has already been worked out. */
  best?: FinderResult,
  /** The trade-for-an-injured-player search's answer, when it has already been worked out. */
  injured?: FinderResult,
): Move[] {
  const team = snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  if (!team || limit <= 0) return [];
  const mine = rosterPlayers(team).map((player) => player.id);

  // Progress: the main search is most of the work, the injured search the rest.
  const part = (from: number, to: number): SearchProgress | undefined =>
    onProgress && ((share, stage) => onProgress(from + (to - from) * share, stage));
  const toMove = (idea: TradeIdea): Move => ({
      kind: "trade",
      notes: {},
      management: [
        ...reserveMoves(idea.result.a, team.reserve, model).map((line) => line.replace(/\.$/, "")),
        ...idea.result.a.pickups.map(({ player, forInjured }) =>
          forInjured ? `Pick up ${player.name} until ${forInjured.name} is back` : `Pick up ${player.name}`,
        ),
        ...idea.result.a.drops.map((player) => `Drop ${player.name}`),
        ...idea.result.a.leaving.map(({ player, when, pickedUp }) =>
          pickedUp ? `Pick up ${player.name} until ${when.name} is back` : `Drop ${player.name} when ${when.name} is back`,
        ),
      ],
      gets: idea.result.a.gets,
      gives: idea.result.a.gives,
      partner: idea.offer.teamB,
      strengthChange: idea.result.a.strengthChange,
      weeklyChange: idea.result.a.teamChange,
      chance: idea.chance,
      likelihood: idea.likelihood,
      idea,
    });
  const realistic = (result: FinderResult) => result.ideas.filter((idea) => idea.likelihood !== "long shot").map(toMove);
  const trades = realistic(best ?? findTrades(model, snapshot, rosterId, situations, {}, undefined, part(0, 0.75)));
  const injuredTrades = realistic(
    injured ?? findTrades(model, snapshot, rosterId, situations, { getInjured: true }, undefined, part(0.75, 1)),
  ).map((move) => ({ ...move, forInjured: true }));

  // Pickups are shortlisted on fewer weeks, then measured on all of them as
  // trades are: the roster run with IR and waivers before and after.
  const baseline = fillRoster(model, mine);
  const before = projectedWeekly(model, baseline.ids);
  const strengthBefore = strengthScore(model, before);
  const pickups: Move[] = freeAgentPickups(model, mine).map((pickup) => {
    const swapped = [...mine.filter((id) => id !== pickup.drop.id), pickup.player.id];
    const after = projectedWeekly(
      model,
      fillRoster(model, swapped, new Set([pickup.drop.id]), baseline.adds.map((add) => add.player.id)).ids,
    );
    return {
      kind: "pickup",
      gets: [pickup.player],
      gives: [pickup.drop],
      partner: null,
      strengthChange: strengthScore(model, after) - strengthBefore,
      weeklyChange: after - before,
      chance: null,
      likelihood: null,
      idea: null,
      notes: {},
      management: [],
    };
  });

  const byGain = (a: Move, b: Move) => b.strengthChange - a.strengthChange || b.weeklyChange - a.weeklyChange;
  const worthDoing = (move: Move) => move.weeklyChange > 0;
  const ranked = [...trades, ...pickups].filter(worthDoing).sort(byGain);
  // Given places: the best pickup when none makes the list on merit, and the best injured trade.
  const given: Move[] = [];
  if (!ranked.slice(0, limit).some((move) => move.kind === "pickup")) {
    const bestPickup = pickups.filter(worthDoing).sort(byGain)[0];
    if (bestPickup) given.push(bestPickup);
  }
  const sameOffer = (a: Move, b: Move) =>
    a.partner === b.partner &&
    a.gives.length === b.gives.length &&
    a.gets.length === b.gets.length &&
    a.gives.every((player) => b.gives.some((other) => other.id === player.id)) &&
    a.gets.every((player) => b.gets.some((other) => other.id === player.id));
  const bestInjured = injuredTrades.filter(worthDoing).sort(byGain).find((move) => !ranked.some((other) => sameOffer(move, other)));
  if (bestInjured) given.push(bestInjured);
  return [...ranked.slice(0, Math.max(0, limit - given.length)), ...given].slice(0, limit).sort(byGain);
}
