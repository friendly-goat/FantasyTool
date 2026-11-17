import { SIMULATED_WEEKS, type TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot } from "../../shared/types.ts";
import { formatPoints } from "../format.ts";
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
              <th scope="col" className="num">Full-health lineup</th>
              <th scope="col" className="num">Lost to absences</th>
              <th scope="col" className="num">Starters play</th>
              <th scope="col" className="num">Bench top 3</th>
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
                  <td className="num">{formatPoints(strength.fullHealth)}</td>
                  <td className="num">{formatPoints(strength.lostToAbsences)}</td>
                  <td className="num">{percent.format(strength.starterAvailability)}</td>
                  <td className="num">{formatPoints(strength.bench)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="quiet legend explain">
        <p>
          Strength rates each roster for the rest of the season. 1 is a team built only from the best free
          agents; 1000 is the nine best players in the league never missing a game.
        </p>
        <p>
          It comes from the projected weekly score: the points a team's best lineup is expected to lock in an
          average week. The app plays out {SIMULATED_WEEKS} weeks. In each, every player's team has two to four
          games, he plays them as often as he has this season, he is worth his lock-in value for the games he
          plays, and the team fields its best legal lineup from whoever is available. Star power, positional
          fit, depth and durability all end up in that one number.
        </p>
        <p>
          The other columns show where it comes from: the lineup if nobody missed a game, the points lost to
          missed games after the bench fills in, how often the starters play, and the bench's best three.
          Players with only a few games are pulled toward an average free agent. Injuries are judged by games
          missed so far, so a player who was just ruled out for months is still overrated.
        </p>
      </div>
    </section>
  );
}
