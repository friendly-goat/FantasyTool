import { SIMULATED_WEEKS, type StrengthModel, type TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot, StatsReport } from "../../shared/types.ts";
import { useProfiles } from "./TeamCharts.tsx";
import { formatPoints, formatSigned, formatStrength } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { StrengthStars } from "./StrengthStars.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  strengths: TeamStrength[] | null;
  model: StrengthModel | null;
  stats: StatsReport | null;
  myRosterId: number | null;
  onOpenTeam: (rosterId: number) => void;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

/** Every team's rest-of-season strength, shown out of 5 (formatStrength), with what is behind it. */
const NO_PLAYERS = {};

export function Strength({ snapshot, strengths, model, stats, myRosterId, onOpenTeam }: Props) {
  // Expect a week, the same figure as on My team (shared with it through the profiles cache).
  const profiles = useProfiles(snapshot, model, strengths, stats?.players ?? NO_PLAYERS, stats?.allowed);
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
              <th scope="col" className="num hide-narrow">Locks a week</th>
              <th scope="col" className="num hide-narrow">Best nine alone</th>
              <th scope="col" className="num hide-narrow">Bench adds</th>
              <th scope="col" className="num hide-narrow">Best nine play</th>
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
                      <span className="num strength-score">{formatStrength(strength.score)}</span>
                      <StrengthStars score={strength.score} size="sm" />
                    </div>
                  </td>
                  <td className="num strong">
                    {profiles?.get(strength.rosterId)?.ahead ? (
                      formatPoints(profiles.get(strength.rosterId)!.ahead!.average)
                    ) : (
                      <span className="team-chart-placeholder strength-expect-placeholder" aria-label="Working it out" />
                    )}
                  </td>
                  <td className="num hide-narrow">{formatPoints(strength.projected)}</td>
                  <td className="num hide-narrow">{formatPoints(strength.bestNine)}</td>
                  <td className="num hide-narrow">{formatSigned(strength.benchAdds)}</td>
                  <td className="num hide-narrow">{percent.format(strength.starterAvailability)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="quiet legend explain">
        <p>
          Strength rates each roster for the rest of the season, out of 5 stars. A roster of the best free agents
          rates about 0, and the league's best players on one roster would rate over 8, so real teams sit around 3
          to 4.5; above 5 is rare, and the stars turn gold.
        </p>
        <p>
          Projected weekly is what each team can expect a week: its locks a week at the share of its projections
          it is expected to really score (the league's rate so far, moved toward the team's own as its weeks add
          up, since a few weeks are mostly luck), the same figure as Expect a week on My team. So it can rank a
          team differently from its roster.
        </p>
        <p>
          Strength itself comes from locks a week: the points a team locks in an average week if every lineup is
          set as well as it can be. The
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
