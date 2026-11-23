import type { ReactNode } from "react";
import type { PlayerRef } from "../../shared/types.ts";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChips } from "./PositionChip.tsx";
import { TeamTag } from "./TeamTag.tsx";

/**
 * A player in a list: name and injury tag, then position chips and NBA team
 * (logo and abbreviation) underneath. Used everywhere a list names players, so they all read alike.
 */
export function PlayerCell({
  player,
  extra,
  tag,
}: {
  player: PlayerRef;
  extra?: ReactNode;
  /** In place of the injury report's status, such as how long he is out ("Out 3 weeks"); null for none. */
  tag?: string | null;
}) {
  const shown = tag === undefined ? player.injuryStatus : tag;
  return (
    <span className="pcell">
      <span className="pcell-name">
        <PlayerName player={player} />
        {shown && <span className="injury">{shown}</span>}
      </span>
      <span className="pcell-meta">
        <PositionChips positions={player.positions} />
        <TeamTag team={player.team} />
        {extra && <span className="quiet">{extra}</span>}
      </span>
    </span>
  );
}
