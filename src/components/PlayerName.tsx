import { createContext, useContext } from "react";
import type { PlayerRef } from "../../shared/types.ts";

/** Lets any view open the player details panel. Provided by App. */
export const OpenPlayerContext = createContext<(player: PlayerRef) => void>(() => {});

/** A player's name as a button that opens their details. Use it wherever a player is named. */
export function PlayerName({ player }: { player: PlayerRef }) {
  const openPlayer = useContext(OpenPlayerContext);
  return (
    <button type="button" className="player-link" onClick={() => openPlayer(player)}>
      {player.name}
    </button>
  );
}
