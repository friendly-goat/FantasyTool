import type { LeagueSnapshot, PlayerRef, Transaction, TransactionSide } from "../../shared/types.ts";
import { formatDate } from "../format.ts";

const TYPE_NAMES: Record<Transaction["type"], string> = {
  trade: "Trade",
  waiver: "Waiver claim",
  free_agent: "Free agent move",
  other: "Roster move",
};

function names(players: PlayerRef[], picks: string[] = []): string {
  return [...players.map((player) => player.name), ...picks].join(", ");
}

function describe(side: TransactionSide, isTrade: boolean): string {
  const gained = names(side.adds, side.picks);
  const lost = names(side.drops);
  if (isTrade) return gained ? `receives ${gained}` : "receives nothing";
  if (gained && lost) return `added ${gained} and dropped ${lost}`;
  if (gained) return `added ${gained}`;
  if (lost) return `dropped ${lost}`;
  return "made a roster move";
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
            {transaction.sides.map((side) => (
              <p key={side.rosterId} className="activity-line">
                <strong>{teams.get(side.rosterId) ?? `Roster ${side.rosterId}`}</strong>{" "}
                {describe(side, transaction.type === "trade")}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
