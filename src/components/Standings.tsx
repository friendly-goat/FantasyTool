import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned } from "../format.ts";
import { Avatar } from "./Avatar.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  myRosterId: number | null;
  onOpenTeam: (rosterId: number) => void;
}

export function Standings({ snapshot, myRosterId, onOpenTeam }: Props) {
  const { teams } = snapshot;
  const scored = teams.map((team) => team.pointsFor);
  const average = scored.reduce((sum, value) => sum + value, 0) / Math.max(1, scored.length);

  // Teams are placed on a scale running from the lowest to the highest
  // scorer, so differences are visible even when totals are close.
  const low = Math.min(...scored);
  const high = Math.max(...scored);
  const position = (value: number) =>
    high > low ? 4 + ((value - low) / (high - low)) * 92 : 50;

  return (
    <section aria-label="Standings">
      <div className="table-scroll">
        <table className="standings">
          <thead>
            <tr>
              <th scope="col" className="num">Rank</th>
              <th scope="col">Team</th>
              <th scope="col" className="num">Record</th>
              <th scope="col">Points scored</th>
              <th scope="col" className="num">Points against</th>
              <th scope="col" className="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => {
              const difference = team.pointsFor - team.pointsAgainst;
              return (
                <tr key={team.rosterId}>
                  <td className="num rank">{team.rank}</td>
                  <th scope="row">
                    <div className="team-cell">
                      <Avatar url={team.avatarUrl} name={team.teamName} />
                      <div>
                        <button type="button" className="team-link" onClick={() => onOpenTeam(team.rosterId)}>
                          {team.teamName}
                        </button>
                        <span className="quiet manager">
                          {team.managerName}
                          {team.rosterId === myRosterId && <span className="mine">Your team</span>}
                        </span>
                      </div>
                    </div>
                  </th>
                  <td className="num record">{formatRecord(team.wins, team.losses, team.ties)}</td>
                  <td>
                    <div className="scored">
                      <span className="num scored-value">{formatPoints(team.pointsFor)}</span>
                      <span className="bar" aria-hidden="true">
                        <span className="bar-mark" style={{ left: `${position(average)}%` }} />
                        <span className="bar-dot" style={{ left: `${position(team.pointsFor)}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="num">{formatPoints(team.pointsAgainst)}</td>
                  <td className={`num ${difference >= 0 ? "up" : "down"}`}>{formatSigned(difference)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="quiet legend">
        Each dot places a team between the league's lowest and highest scorer. The line marks the league
        average, {formatPoints(average)}. Teams are ranked by wins, then points scored.
      </p>
    </section>
  );
}
