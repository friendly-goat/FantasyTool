import type { ReactNode } from "react";
import type { PlayerRef } from "../../shared/types.ts";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChips } from "./PositionChip.tsx";

/**
 * A player in a list: name and injury tag, then position chips and NBA team
 * underneath. Used everywhere a list names players, so they all read alike.
 */
export function PlayerCell({
  player,
  showTeam = true,
  extra,
}: {
  player: PlayerRef;
  showTeam?: boolean;
  extra?: ReactNode;
}) {
  return (
    <span className="pcell">
      <span className="pcell-name">
        <PlayerName player={player} />
        {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
      </span>
      <span className="pcell-meta">
        <PositionChips positions={player.positions} />
        {showTeam && <span className="quiet">{player.team ?? "Free agent"}</span>}
        {extra && <span className="quiet">{extra}</span>}
      </span>
    </span>
  );
}
