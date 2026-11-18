import type { StrengthModel } from "../../shared/strength.ts";
import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { MatchupDetail } from "./MatchupDetail.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  /** Only the admin may mark locks; viewers see the results without the buttons. */
  canMarkLocks: boolean;
  myRosterId: number | null;
  openMatchupId: number | null;
  onOpenMatchup: (matchupId: number | null) => void;
  onOpenTeam: (rosterId: number) => void;
}

export function Matchups({ snapshot, model, canMarkLocks, myRosterId, openMatchupId, onOpenMatchup, onOpenTeam }: Props) {
  const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team]));

  if (snapshot.matchups.length === 0) {
    return <p className="quiet">No matchups are scheduled for week {snapshot.week}.</p>;
  }

  const open = snapshot.matchups.find((matchup) => matchup.matchupId === openMatchupId);
  if (open) {
    return (
      <MatchupDetail
        snapshot={snapshot}
        model={model}
        canMarkLocks={canMarkLocks}
        matchup={open}
        myRosterId={myRosterId}
        onBack={() => onOpenMatchup(null)}
        onOpenTeam={onOpenTeam}
      />
    );
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
                      <div className="matchup-team">
                        <button
                          type="button"
                          className="team-link"
                          title={team?.teamName}
                          onClick={() => onOpenTeam(side.rosterId)}
                        >
                          {team?.teamName ?? `Roster ${side.rosterId}`}
                        </button>
                        {team && (
                          <span className="quiet manager">
                            {formatRecord(team.wins, team.losses, team.ties)}
                            {side.rosterId === myRosterId && <span className="mine">Your team</span>}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="num matchup-points">{formatPoints(side.points)}</span>
                  </div>
                );
              })}
              <button type="button" className="matchup-open" onClick={() => onOpenMatchup(matchup.matchupId)}>
                View matchup
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
