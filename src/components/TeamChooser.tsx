import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";

/** Asks which team is the user's own. Shown once per league, and again on request. */
export function TeamChooser({ snapshot, onChoose }: { snapshot: LeagueSnapshot; onChoose: (rosterId: number) => void }) {
  return (
    <section className="chooser" aria-labelledby="chooser-title">
      <h2 id="chooser-title" className="team-title">
        Which team is yours?
      </h2>
      <p className="quiet">
        Your team gets its own tab, and lineup and trade ideas are worked out from its point of view. You
        can change this later.
      </p>
      <ul className="league-list">
        {[...snapshot.teams]
          .sort((a, b) => a.teamName.localeCompare(b.teamName))
          .map((team) => (
            <li key={team.rosterId}>
              <button type="button" className="league-option chooser-option" onClick={() => onChoose(team.rosterId)}>
                <span className="team-cell">
                  <Avatar url={team.avatarUrl} name={team.teamName} />
                  <span>
                    <span className="league-option-name">{team.teamName}</span>
                    <span className="quiet manager">{team.managerName}</span>
                  </span>
                </span>
                <span className="quiet">{formatRecord(team.wins, team.losses, team.ties)}</span>
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}
