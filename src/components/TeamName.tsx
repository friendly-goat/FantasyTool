import { createContext, useContext } from "react";
import type { Team } from "../../shared/types.ts";

/** Lets a view open a fantasy team's card (charts and roster). Provided by App. */
export const OpenTeamContext = createContext<((rosterId: number) => void) | null>(null);

/** A fantasy team's name as a button that opens its card; plain text where no card can open. */
export function TeamName({ team, className }: { team: Team; className?: string }) {
  const openTeam = useContext(OpenTeamContext);
  if (!openTeam) return <span className={className}>{team.teamName}</span>;
  return (
    <button type="button" className={`team-link${className ? ` ${className}` : ""}`} onClick={() => openTeam(team.rosterId)}>
      {team.teamName}
    </button>
  );
}
