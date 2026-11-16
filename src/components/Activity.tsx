import { Fragment, type ReactNode } from "react";
import type { LeagueSnapshot, PlayerRef, Transaction, TransactionSide } from "../../shared/types.ts";
import { formatDate } from "../format.ts";
import { PlayerName } from "./PlayerName.tsx";

const TYPE_NAMES: Record<Transaction["type"], string> = {
  trade: "Trade",
  waiver: "Waiver claim",
  free_agent: "Free agent move",
  other: "Roster move",
};

/** "A, B, 2027 2nd-round pick", with each player's name opening their details. */
function list(players: PlayerRef[], picks: string[] = []): ReactNode {
  const items: ReactNode[] = [
    ...players.map((player) => <PlayerName key={player.id} player={player} />),
    ...picks,
  ];
  return items.map((item, index) => (
    <Fragment key={index}>
      {index > 0 && ", "}
      {item}
    </Fragment>
  ));
}

function describe(side: TransactionSide, isTrade: boolean): ReactNode {
  const gained = side.adds.length + side.picks.length > 0;
  const lost = side.drops.length > 0;
  if (isTrade) return gained ? <>receives {list(side.adds, side.picks)}</> : "receives nothing";
  if (gained && lost) {
    return (
      <>
        added {list(side.adds, side.picks)} and dropped {list(side.drops)}
      </>
    );
  }
  if (gained) return <>added {list(side.adds, side.picks)}</>;
  if (lost) return <>dropped {list(side.drops)}</>;
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
