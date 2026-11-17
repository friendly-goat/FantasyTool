import type { LeagueSnapshot, Transaction, TransactionSide } from "../../shared/types.ts";
import { formatDate } from "../format.ts";
import { type Move, PlayerMoves } from "./PlayerMoves.tsx";

const TYPE_NAMES: Record<Transaction["type"], string> = {
  trade: "Trade",
  waiver: "Waiver claim",
  free_agent: "Free agent move",
  other: "Roster move",
};

/** What one team gained (+) and gave up (−) in a transaction. */
function moves(side: TransactionSide): Move[] {
  return [
    ...side.adds.map((player) => ({ player, joins: true })),
    ...side.picks.map((pick) => ({ player: pick, joins: true, note: "Draft pick" })),
    ...side.drops.map((player) => ({ player, joins: false })),
  ];
}

export function Activity({ snapshot }: { snapshot: LeagueSnapshot }) {
  const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team.teamName]));

  if (snapshot.transactions.length === 0) {
    return <p className="quiet">No trades, waiver claims or free agent moves in the last three weeks.</p>;
  }

  return (
    <section aria-label="Recent activity">
      <ul className="activity">
        {snapshot.transactions.map((transaction) => (
          <li key={transaction.id} className={`activity-item type-${transaction.type}`}>
            <div className="activity-head">
              <span className="activity-type">{TYPE_NAMES[transaction.type]}</span>
              <time className="quiet" dateTime={transaction.createdAt}>
                {formatDate(transaction.createdAt)}
              </time>
            </div>
            <div className={transaction.sides.length > 1 ? "activity-sides activity-sides-split" : "activity-sides"}>
              {transaction.sides.map((side) => (
                <div key={side.rosterId} className="activity-side">
                  <strong className="activity-team">{teams.get(side.rosterId) ?? `Roster ${side.rosterId}`}</strong>
                  <PlayerMoves moves={moves(side)} empty="No players changed hands." />
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
