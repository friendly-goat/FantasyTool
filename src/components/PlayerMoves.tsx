import type { ReactNode } from "react";
import type { PlayerRef } from "../../shared/types.ts";
import { PlayerCell } from "./PlayerCell.tsx";

export interface Move {
  /** The player who moves, or a label for something else (such as a draft pick). */
  player: PlayerRef | string;
  joins: boolean;
  note?: string;
  /** Shown on the right, such as a player value. */
  value?: ReactNode;
}

/**
 * Players joining (green +) and leaving (red −) a team: used for trades and
 * for roster moves, so both read the same way.
 */
export function PlayerMoves({ moves, empty = "No players change hands." }: { moves: Move[]; empty?: string }) {
  if (moves.length === 0) return <p className="quiet">{empty}</p>;
  return (
    <ul className="moves">
      {moves.map(({ player, joins, note, value }, index) => (
        <li
          key={`${joins ? "in" : "out"}-${typeof player === "string" ? `${player}-${index}` : player.id}`}
          className={`move ${joins ? "move-in" : "move-out"}`}
        >
          <span className="move-sign" aria-hidden="true">
            {joins ? "+" : "−"}
          </span>
          <span className="visually-hidden">{joins ? "Joins: " : "Leaves: "}</span>
          {typeof player === "string" ? (
            <span className="pcell">
              <span className="pcell-name">{player}</span>
              {note && <span className="pcell-meta quiet">{note}</span>}
            </span>
          ) : (
            <PlayerCell player={player} extra={note} />
          )}
          {value !== undefined ? <span className="move-value">{value}</span> : <span />}
        </li>
      ))}
    </ul>
  );
}
