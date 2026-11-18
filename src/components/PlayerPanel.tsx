import { useEffect, useRef, useState } from "react";
import { returnOutlook } from "../../shared/injury.ts";
import type { LeagueSnapshot, PlayerDetail, PlayerRef, StatsReport } from "../../shared/types.ts";
import { getPlayerDetail } from "../api.ts";
import { formatAverage, formatDay, formatGameDate, formatPoints, formatSigned } from "../format.ts";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
import { PositionChip } from "./PositionChip.tsx";
import { InjuryNote } from "./InjuryNote.tsx";
import { absenceFor, ProjectionChart } from "./ProjectionChart.tsx";
import { TeamTag } from "./TeamTag.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  stats: StatsReport | null;
  player: PlayerRef;
  onClose: () => void;
}

function fantasyTeamOf(snapshot: LeagueSnapshot, playerId: string): string | null {
  for (const team of snapshot.teams) {
    const onTeam =
      team.starters.some((starter) => starter.player?.id === playerId) ||
      team.bench.some((player) => player.id === playerId) ||
      team.reserve.some((player) => player.id === playerId);
    if (onTeam) return team.teamName;
  }
  return null;
}

/** Details for one player: season numbers and game log. Opens over the page. */
export function PlayerPanel({ snapshot, stats, player, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    getPlayerDetail(snapshot.league.id, player.id)
      .then((loaded) => current && setDetail(loaded))
      .catch((cause) => current && setError(cause instanceof Error ? cause.message : "Could not load this player."));
    return () => {
      current = false;
    };
  }, [snapshot.league.id, player.id]);

  const shown = detail?.player ?? player;
  const fantasyTeam = fantasyTeamOf(snapshot, player.id);
  const season = detail?.stats ?? null;
  const recentLabel = `Last ${stats?.recentWindow ?? 5}`;
  // The injury report entry comes with the league's stats report.
  const injury = stats?.players[player.id]?.injury ?? null;
  const outlook = injury ? returnOutlook(injury) : null;

  return (
    <dialog
      ref={dialog}
      className="player-panel"
      aria-labelledby="player-panel-name"
      onClose={onClose}
      onClick={(event) => {
        // A click on the dimmed area outside the panel closes it.
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="panel-body">
        <div className="panel-head">
          <div>
            <h2 id="player-panel-name" className="team-title">
              {shown.name}
            </h2>
            <p className="player-tags">
              {shown.positions.map((name) => (
                <PositionChip key={name} label={name} />
              ))}
              <TeamTag team={shown.team} empty="No NBA team" size="md" />
              {shown.injuryStatus && <span className="injury">{shown.injuryStatus}</span>}
            </p>
            <p className="quiet">{fantasyTeam ? `On ${fantasyTeam}` : "Free agent in this league"}</p>
          </div>
          <button type="button" className="button button-plain" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </div>

        {injury && <InjuryNote injury={injury} />}

        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {!detail && !error && <p className="quiet">Loading…</p>}

        {detail && !season && (
          <p className="notice">
            {stats?.status === "unconfigured"
              ? "Player stats are off, so there is no game log to show."
              : stats?.status === "syncing"
                ? "Game stats are still downloading. Open this player again in a minute."
                : "No games played this season."}
          </p>
        )}

        {detail && season && (
          <>
            <dl className="figures">
              <div>
                <dt>Fantasy avg</dt>
                <dd>{formatPoints(season.fantasyAvg)}</dd>
              </div>
              <div>
                <dt>{recentLabel}</dt>
                <dd>{season.recentAvg != null ? formatPoints(season.recentAvg) : "–"}</dd>
              </div>
              <div>
                <dt>Projected</dt>
                <dd>{formatPoints(season.projection.perGame)}</dd>
              </div>
              <div>
                <dt>Games</dt>
                <dd>{season.games}</dd>
              </div>
              <div>
                <dt>Minutes</dt>
                <dd>{formatAverage(season.minutes)}</dd>
              </div>
            </dl>

            {formatPoints(season.sleeperAvg) !== formatPoints(season.fantasyAvg) && (
              <p className="quiet panel-note">
                Sleeper's app shows {formatPoints(season.sleeperAvg)} as this player's average. Sleeper counts
                each scoring bonus once against season totals, so its number differs from the average of the
                games below.
              </p>
            )}

            <h3 className="panel-heading">Rest of season</h3>
            <ProjectionChart
              stats={season}
              games={detail.games}
              absence={
                injury && outlook?.kind === "season"
                  ? absenceFor(season, injury.asOf, null, null)
                  : injury && outlook?.kind === "window"
                    ? absenceFor(season, injury.asOf, outlook.window.expected, formatDay(outlook.window.expected, injury.asOf))
                    : null
              }
            />
            <p className="quiet panel-note">
              {season.projection.factors.length > 0 ? (
                <>
                  Starts from his average of {formatPoints(season.fantasyAvg)}.{" "}
                  {season.projection.factors.map((factor) => (
                    <span key={factor.label}>
                      {factor.label}: {formatSigned(factor.effect)}.{" "}
                    </span>
                  ))}
                </>
              ) : (
                <>Projected to keep his average. </>
              )}
              {season.projection.lastSeason
                ? `Last season he averaged ${formatPoints(season.projection.lastSeason.average)} over ${season.projection.lastSeason.games} games. `
                : stats?.lastSeason === "loading"
                  ? "Last season's stats are still downloading and are not in this projection yet. "
                  : "No last season on record for him. "}
              {outlook?.kind === "season"
                ? "He is out for the season, so he counts for nothing in the weeks left."
                : outlook?.kind === "window" && injury
                  ? `He counts for nothing until he is back (about ${formatDay(outlook.window.expected, injury.asOf)}), then is expected to play ${percent.format(season.playRate ?? season.availability)} of his team's games.`
                  : season.longTermOut
                    ? `He has missed his team's last ${season.missedStreak} games, so he is expected to play only ${percent.format(season.availability)} of the rest.`
                    : `Expected to play ${percent.format(season.availability)} of his team's remaining games.`}
            </p>

            <h3 className="panel-heading">Game log</h3>
            <div className="table-scroll">
              <table className="players-table log-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Opponent</th>
                    <th scope="col" className="num">Min</th>
                    <th scope="col" className="num">Pts</th>
                    <th scope="col" className="num">Reb</th>
                    <th scope="col" className="num">Ast</th>
                    <th scope="col" className="num">Stl</th>
                    <th scope="col" className="num">Blk</th>
                    <th scope="col" className="num">TO</th>
                    <th scope="col" className="num">Fantasy</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.games.map((game) => (
                    <tr key={game.date}>
                      <th scope="row">{formatGameDate(game.date)}</th>
                      <td>
                        {game.opponent ? `${game.home === false ? "at" : "vs"} ${game.opponent}` : "–"}
                      </td>
                      <td className="num">{Math.round(game.minutes)}</td>
                      <td className="num">{game.stats.pts}</td>
                      <td className="num">{game.stats.reb}</td>
                      <td className="num">{game.stats.ast}</td>
                      <td className="num">{game.stats.stl}</td>
                      <td className="num">{game.stats.blk}</td>
                      <td className="num">{game.stats.tov}</td>
                      <td className="num strong">{formatPoints(game.fantasyPoints)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      Season average
                    </th>
                    <td className="num">{formatAverage(season.minutes)}</td>
                    <td className="num">{formatAverage(season.averages.pts)}</td>
                    <td className="num">{formatAverage(season.averages.reb)}</td>
                    <td className="num">{formatAverage(season.averages.ast)}</td>
                    <td className="num">{formatAverage(season.averages.stl)}</td>
                    <td className="num">{formatAverage(season.averages.blk)}</td>
                    <td className="num">{formatAverage(season.averages.tov)}</td>
                    <td className="num strong">{formatPoints(season.fantasyAvg)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
