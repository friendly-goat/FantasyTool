import { SIMULATED_WEEKS, type TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatPoints, formatSigned } from "../format.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  strengths: TeamStrength[] | null;
  myRosterId: number | null;
  onOpenTeam: (rosterId: number) => void;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

/** Every team's rest-of-season strength on the 1 to 1000 scale, with what is behind it. */
export function Strength({ snapshot, strengths, myRosterId, onOpenTeam }: Props) {
  if (!strengths) return <p className="quiet">Team strength appears once player stats have loaded.</p>;
  const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team]));

  return (
    <section aria-label="Team strength">
      <div className="table-scroll">
        <table className="players-table strength-table">
          <thead>
            <tr>
              <th scope="col" className="num">Rank</th>
              <th scope="col">Team</th>
              <th scope="col">Strength</th>
              <th scope="col" className="num">Projected weekly</th>
              <th scope="col" className="num">Best nine alone</th>
              <th scope="col" className="num">Bench adds</th>
              <th scope="col" className="num">Best nine play</th>
            </tr>
          </thead>
          <tbody>
            {strengths.map((strength) => {
              const team = teams.get(strength.rosterId);
              return (
                <tr key={strength.rosterId}>
                  <td className="num rank">{strength.rank}</td>
                  <th scope="row">
                    <div className="team-cell">
                      <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
                      <div>
                        <button type="button" className="team-link" onClick={() => onOpenTeam(strength.rosterId)}>
                          {team?.teamName ?? `Roster ${strength.rosterId}`}
                        </button>
                        <span className="quiet manager">
                          {team?.managerName}
                          {strength.rosterId === myRosterId && <span className="mine">Your team</span>}
                        </span>
                      </div>
                    </div>
                  </th>
                  <td>
                    <div className="strength-cell">
                      <span className="num strength-score">{strength.score}</span>
                      <span className="meter" aria-hidden="true">
                        <span className="meter-fill" style={{ width: `${strength.score / 10}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="num strong">{formatPoints(strength.projected)}</td>
                  <td className="num">{formatPoints(strength.bestNine)}</td>
                  <td className="num">{formatSigned(strength.benchAdds)}</td>
                  <td className="num">{percent.format(strength.starterAvailability)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="quiet legend explain">
        <p>
          Strength rates each roster for the rest of the season. 1 is a roster of the best free agents; 1000 is
          the league's best players on one roster.
        </p>
        <p>
          It comes from the projected weekly score: the points a team is expected to lock in an average week. The
          app plays out {SIMULATED_WEEKS} weeks day by day. Each day the players with a game go into the open
          starting slots, best first, whatever lineup is set in Sleeper right now. After the games, a slot is
          locked when its score beats what that slot can still expect from the rest of the week; a locked slot is
          done. Players score around their projected level with their own ups and downs, and miss games as often
          as they are expected to.
        </p>
        <p>
          Because an open slot can take a different player each day, bench players are extra chances at a big
          game, not just cover for injuries. Bench adds is how much higher the projection is with the whole roster
          than with the best nine alone. Best nine play is how often those nine are expected to play.
        </p>
      </div>
    </section>
  );
}
