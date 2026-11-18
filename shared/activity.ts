import { rosterPlayers } from "./analysis.ts";
import { fillRoster, projectedWeekly, type StrengthModel, strengthScore } from "./strength.ts";
import type { LeagueSnapshot, Transaction, TransactionSide } from "./types.ts";

/**
 * What one team's side of a transaction does to its strength, measured on
 * today's projections: the team's roster as it is now with the move made,
 * against the same roster with the move undone. Measuring both from today's
 * roster keeps it fair whatever happened since (a pickup later dropped, a
 * player since traded); both are run through fillRoster, as trades are, so a
 * pickup the team would make either way is not credited to the move.
 *
 * Display only, for the Activity tab: never fed into strength, grades or
 * trade ideas.
 */
export interface MoveEffect {
  rosterId: number;
  /** Projected weekly score with the move undone, and with it made. */
  without: number;
  with: number;
  /** Weekly points the move adds (negative: costs). */
  change: number;
  /** The same on the 1 to 1000 strength scale. */
  strengthWithout: number;
  strengthWith: number;
  strengthChange: number;
  /** Players the team got who are no longer on its roster. */
  since: { gone: string[]; back: string[] };
}

export function moveEffect(model: StrengthModel, currentIds: string[], side: TransactionSide): MoveEffect {
  const adds = side.adds.map((player) => player.id);
  const drops = side.drops.map((player) => player.id);
  const involved = new Set([...adds, ...drops]);
  const current = new Set(currentIds);

  const withMove = [...new Set([...currentIds.filter((id) => !drops.includes(id)), ...adds])];
  const withoutMove = [...new Set([...currentIds.filter((id) => !adds.includes(id)), ...drops])];
  // Neither roster may refill an open spot with a player from this move.
  const baseline = fillRoster(model, withoutMove, new Set(involved));
  const filled = fillRoster(
    model,
    withMove,
    new Set(involved),
    baseline.adds.map((add) => add.player.id),
  );
  const without = projectedWeekly(model, baseline.ids);
  const withScore = projectedWeekly(model, filled.ids);
  const strengthWithout = strengthScore(model, without);
  const strengthWith = strengthScore(model, withScore);
  return {
    rosterId: side.rosterId,
    without,
    with: withScore,
    change: withScore - without,
    strengthWithout,
    strengthWith,
    strengthChange: strengthWith - strengthWithout,
    since: {
      gone: adds.filter((id) => !current.has(id)),
      back: drops.filter((id) => current.has(id)),
    },
  };
}

/** Every side of every transaction, keyed by transaction id then roster id. */
export function activityEffects(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  transactions: Transaction[] = snapshot.transactions,
): Map<string, Map<number, MoveEffect>> {
  const rosters = new Map(snapshot.teams.map((team) => [team.rosterId, rosterPlayers(team).map((player) => player.id)]));
  const result = new Map<string, Map<number, MoveEffect>>();
  for (const transaction of transactions) {
    const sides = new Map<number, MoveEffect>();
    for (const side of transaction.sides) {
      const ids = rosters.get(side.rosterId);
      if (!ids || (side.adds.length === 0 && side.drops.length === 0)) continue;
      sides.set(side.rosterId, moveEffect(model, ids, side));
    }
    result.set(transaction.id, sides);
  }
  return result;
}
