// The best moves a team could make, trades and waiver pickups together,
// ranked by how much each raises the team's strength over the rest of the
// season. Trades come from the same search as "see the best trades for my
// team" (findTrades); pickups from freeAgentPickups. Both are measured the
// same way here: the change in strength from the full projection.

import { freeAgentPickups, type TeamSituation } from "./insight.ts";
import { rosterPlayers } from "./analysis.ts";
import { type ModelPlayer, projectedWeekly, type StrengthModel, strengthScore } from "./strength.ts";
import { findTrades, type Likelihood, type TradeIdea } from "./trade.ts";
import type { LeagueSnapshot } from "./types.ts";

export interface Move {
  kind: "trade" | "pickup";
  /** Players coming in: for a trade, those received and any free agent picked up to refill the roster. */
  gets: ModelPlayer[];
  /** Players going out: for a trade, those sent and any dropped to make room; for a pickup, the drop. */
  gives: ModelPlayer[];
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
}

/** How many trade ideas the search returns before they are mixed with pickups. */
const TRADE_IDEAS = 12;

/**
 * The `limit` best moves for `rosterId`, biggest strength gain first.
 * Trades are the finder's ideas that stand at least a fair chance (long
 * shots are left out: they are not moves you could make). Pickups earn a
 * place on merit; when none does, the best pickup takes the last place, so
 * the waiver wire is always in view.
 */
export function topMoves(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation>,
  limit = 5,
): Move[] {
  const team = snapshot.teams.find((candidate) => candidate.rosterId === rosterId);
  if (!team || limit <= 0) return [];
  const mine = rosterPlayers(team).map((player) => player.id);

  const trades: Move[] = findTrades(model, snapshot, rosterId, situations, {}, TRADE_IDEAS)
    .ideas.filter((idea) => idea.likelihood !== "long shot")
    .map((idea) => ({
      kind: "trade",
      gets: [...idea.result.a.gets, ...idea.result.a.adds],
      gives: [...idea.result.a.gives, ...idea.result.a.drops],
      partner: idea.offer.teamB,
      strengthChange: idea.result.a.strengthChange,
      weeklyChange: idea.result.a.teamChange,
      chance: idea.chance,
      likelihood: idea.likelihood,
      idea,
    }));

  // Pickups are shortlisted on fewer weeks, then measured on all of them, as trades are.
  const before = projectedWeekly(model, mine);
  const strengthBefore = strengthScore(model, before);
  const pickups: Move[] = freeAgentPickups(model, mine).map((pickup) => {
    const after = projectedWeekly(model, [...mine.filter((id) => id !== pickup.drop.id), pickup.player.id]);
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
    };
  });

  const byGain = (a: Move, b: Move) => b.strengthChange - a.strengthChange || b.weeklyChange - a.weeklyChange;
  const worthDoing = (move: Move) => move.weeklyChange > 0;
  const ranked = [...trades, ...pickups].filter(worthDoing).sort(byGain);
  const top = ranked.slice(0, limit);
  if (top.some((move) => move.kind === "pickup")) return top;
  const bestPickup = pickups.filter(worthDoing).sort(byGain)[0];
  return bestPickup ? [...top.slice(0, limit - 1), bestPickup] : top;
}
