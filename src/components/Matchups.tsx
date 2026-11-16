import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  onOpenTeam: (rosterId: number) => void;
}

export function Matchups({ snapshot, onOpenTeam }: Props) {
  const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team]));

  if (snapshot.matchups.length === 0) {
    return <p className="quiet">No matchups are scheduled for week {snapshot.week}.</p>;
  }

  return (
    <section aria-label={`Week ${snapshot.week} matchups`}>
      <h2 className="section-title">Week {snapshot.week}</h2>
      <ul className="matchups">
        {snapshot.matchups.map((matchup) => {
          const top = Math.max(...matchup.sides.map((side) => side.points));
          const decided = matchup.sides.some((side) => side.points !== top);
          return (
            <li key={matchup.matchupId} className="matchup">
              {matchup.sides.map((side) => {
                const team = teams.get(side.rosterId);
                const leading = decided && side.points === top;
                return (
                  <div key={side.rosterId} className={`matchup-side${leading ? " leading" : ""}`}>
                    <div className="team-cell">
                      <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
                      <div>
                        <button type="button" className="team-link" onClick={() => onOpenTeam(side.rosterId)}>
                          {team?.teamName ?? `Roster ${side.rosterId}`}
                        </button>
                        {team && (
                          <span className="quiet manager">
                            {formatRecord(team.wins, team.losses, team.ties)}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="num matchup-points">{formatPoints(side.points)}</span>
                  </div>
                );
              })}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
