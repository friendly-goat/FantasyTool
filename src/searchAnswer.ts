// What the search worker (and, without workers, the page) answers a request
// with. Every trade search's answer is kept per team and options for as long
// as the model stands: the top moves rest on two of them ("see the best
// trades for my team" and "trade for an injured player"), so whichever of
// the top moves and the Trades tab asks second gets the answer at once.
import type { TeamSituation } from "../shared/insight.ts";
import { type Move, topMoves } from "../shared/moves.ts";
import type { StrengthModel } from "../shared/strength.ts";
import { type FinderOptions, type FinderResult, findTrades, type SearchProgress } from "../shared/trade.ts";
import type { LeagueSnapshot } from "../shared/types.ts";
import type { SearchRequest } from "./search.ts";

/** One key per team and set of options (unset options and their order do not count). */
function keyOf(rosterId: number, options: FinderOptions): string {
  const set = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `${rosterId}:${JSON.stringify(set)}`;
}

/** The top moves' share of progress for its main search; the injured search has the rest. */
const MAIN_SHARE = 0.75;

export function answer(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  situations: Map<number, TeamSituation>,
  request: SearchRequest,
  kept: Map<string, FinderResult>,
  progress?: SearchProgress,
): FinderResult | Move[] {
  const search = (options: FinderOptions, onProgress?: SearchProgress) => {
    const key = keyOf(request.rosterId, options);
    let found = kept.get(key);
    if (!found) {
      found = findTrades(model, snapshot, request.rosterId, situations, options, undefined, onProgress);
      kept.set(key, found);
    }
    return found;
  };
  if (request.kind === "trades") return search(request.options, progress);
  const part = (from: number, to: number): SearchProgress | undefined =>
    progress && ((share, stage) => progress(from + (to - from) * share, stage));
  const best = search({}, part(0, MAIN_SHARE));
  const injured = search({ getInjured: true }, part(MAIN_SHARE, 1));
  return topMoves(model, snapshot, request.rosterId, situations, undefined, progress, best, injured);
}
