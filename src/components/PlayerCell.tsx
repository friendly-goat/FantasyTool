import type { ReactNode } from "react";
import type { PlayerRef } from "../../shared/types.ts";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChips } from "./PositionChip.tsx";
import { TeamTag } from "./TeamTag.tsx";

/**
 * A player in a list: name and injury tag, then position chips and NBA team
 * (logo and abbreviation) underneath. Used everywhere a list names players, so they all read alike.
 */
export function PlayerCell({ player, extra }: { player: PlayerRef; extra?: ReactNode }) {
  return (
    <span className="pcell">
      <span className="pcell-name">
        <PlayerName player={player} />
        {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
      </span>
      <span className="pcell-meta">
        <PositionChips positions={player.positions} />
        <TeamTag team={player.team} />
        {extra && <span className="quiet">{extra}</span>}
      </span>
    </span>
  );
}
