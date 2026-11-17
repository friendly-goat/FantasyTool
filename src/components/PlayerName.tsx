import { createContext, useContext } from "react";
import type { PlayerRef } from "../../shared/types.ts";

/** Lets any view open the player details panel. Provided by App. */
export const OpenPlayerContext = createContext<(player: PlayerRef) => void>(() => {});

/**
 * A player's name as a button that opens their details. Use it wherever a
 * player is named. "stacked" puts the first name on a small line above the
 * rest, as on a draft card.
 */
export function PlayerName({ player, stacked = false }: { player: PlayerRef; stacked?: boolean }) {
  const openPlayer = useContext(OpenPlayerContext);
  const space = player.name.indexOf(" ");
  return (
    <button
      type="button"
      className={stacked ? "player-link player-link-stacked" : "player-link"}
      onClick={() => openPlayer(player)}
    >
      {stacked && space > 0 ? (
        <>
          <span className="name-first">{player.name.slice(0, space)}</span>
          <span className="name-last">{player.name.slice(space + 1)}</span>
        </>
      ) : (
        player.name
      )}
    </button>
  );
}
