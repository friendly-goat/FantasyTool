import { createContext, type ReactNode, useContext } from "react";
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

/**
 * A larger click target that opens a player's details, such as a whole
 * draft card. Its content should name the player; use it in place of
 * PlayerName, never around it (a button cannot hold another button).
 */
export function PlayerButton({ player, className, children }: { player: PlayerRef; className?: string; children: ReactNode }) {
  const openPlayer = useContext(OpenPlayerContext);
  return (
    <button type="button" className={className} onClick={() => openPlayer(player)}>
      {children}
    </button>
  );
}
