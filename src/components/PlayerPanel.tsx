import { nbaDay } from "../../shared/weeks.ts";
import { useEffect, useRef, useState } from "react";
import { newsOutText, returnOutlook } from "../../shared/injury.ts";
import type { LeagueSnapshot, PlayerDetail, PlayerRef, StatsReport } from "../../shared/types.ts";
import { getPlayerDetail } from "../api.ts";
import { closeDialog } from "../closeDialog.ts";
import { fantasyTone, formatAverage, formatDay, formatGameDate, formatPoints, formatSigned, toneColor } from "../format.ts";

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });
import { PositionChip } from "./PositionChip.tsx";
import { InjuryNote } from "./InjuryNote.tsx";
import { DepthChart } from "./DepthChart.tsx";
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

// Game logs already opened this visit, so a second look is instant.
const DETAIL_MINUTES = 5;
const details = new Map<string, { detail: PlayerDetail; at: number }>();

/**
 * Details for one player: season numbers, projection and game log. Opens
 * over the page (a bottom sheet on a phone). Everything but the game log
 * comes with the league's stats report, so the panel opens at its full size
 * at once; only the game scores and log rows fill in when they arrive.
 */
/** One game's fantasy points, colored red to green against his own average (see fantasyTone). */
function FantasyCell({ points, average }: { points: number; average: number }) {
  const tone = fantasyTone(points, average);
  return (
    <td className="num strong log-fpts" style={tone === null ? undefined : { color: toneColor(tone) }}>
      {formatPoints(points)}
    </td>
  );
}

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
    const key = `${snapshot.league.id}:${player.id}`;
    const saved = details.get(key);
    setError(null);
    // A player opened before shows at once; an older copy is refreshed behind it.
    setDetail(saved?.detail ?? null);
    if (saved && Date.now() - saved.at < DETAIL_MINUTES * 60_000) return;
    getPlayerDetail(snapshot.league.id, player.id)
      .then((loaded) => {
        details.set(key, { detail: loaded, at: Date.now() });
        if (current) setDetail(loaded);
      })
      .catch((cause) => current && !saved && setError(cause instanceof Error ? cause.message : "Could not load this player."));
    return () => {
      current = false;
    };
  }, [snapshot.league.id, player.id]);

  const shown = detail?.player ?? player;
  const fantasyTeam = fantasyTeamOf(snapshot, player.id);
  // Season numbers come from the league's stats report, the same figures the
  // rest of the page shows, so nothing changes when the detail arrives; the
  // detail adds the game log (and the numbers for a player the report lacks).
  const season = stats?.players[player.id] ?? detail?.stats ?? null;
  const games = detail?.games ?? null;
  const recentLabel = `Last ${stats?.recentWindow ?? 5}`;
  // The injury report entry comes with the league's stats report.
  const injury = stats?.players[player.id]?.injury ?? null;
  const outlook = injury ? returnOutlook(injury) : null;
  // How long he is out, as everywhere a player who is out is named.
  const outTag = newsOutText(injury, shown.injuryStatus, nbaDay(Date.now()));

  return (
    <dialog
      ref={dialog}
      className="player-panel"
      aria-labelledby="player-panel-name"
      onClose={onClose}
      onCancel={(event) => {
        // Escape: close the same way as the button, sliding down on a phone.
        event.preventDefault();
        closeDialog(dialog.current);
      }}
      onClick={(event) => {
        // A click on the dimmed area outside the panel closes it.
        if (event.target === dialog.current) closeDialog(dialog.current);
      }}
    >
      {/* Stays at the top right while the panel scrolls. */}
      <div className="panel-close">
        <button type="button" className="button button-plain panel-close-button" onClick={() => closeDialog(dialog.current)}>
          Close
        </button>
      </div>
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
              {outTag && <span className="injury">{outTag}</span>}
            </p>
            <p className="quiet">{fantasyTeam ? `On ${fantasyTeam}` : "Free agent in this league"}</p>
          </div>
        </div>

        {injury && <InjuryNote injury={injury} />}

        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {!season && !detail && !error && <p className="quiet">Loading…</p>}

        {detail && !season && (
          <p className="notice">
            {stats?.status === "unconfigured"
              ? "Player stats are off, so there is no game log to show."
              : stats?.status === "syncing"
                ? "Game stats are still downloading. Open this player again in a minute."
                : "No games played this season."}
          </p>
        )}

        {season && (
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
              games={games}
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
                    <th scope="col" className="num">Fpts</th>
                    <th scope="col" className="num">Min</th>
                    <th scope="col" className="num">Pts</th>
                    <th scope="col" className="num">Reb</th>
                    <th scope="col" className="num">Ast</th>
                    <th scope="col" className="num">Stl</th>
                    <th scope="col" className="num">Blk</th>
                    <th scope="col" className="num">TO</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Rows the size of the real ones hold the space until the log arrives. */}
                  {!games &&
                    Array.from({ length: Math.min(season.games, 82) }, (_, index) => (
                      <tr key={`loading-${index}`} className="log-loading" aria-hidden="true">
                        <th scope="row">
                          <span className="skeleton" />
                        </th>
                        <td>
                          <span className="skeleton skeleton-wide" />
                        </td>
                        {Array.from({ length: 8 }, (_, cell) => (
                          <td key={cell} className="num">
                            <span className="skeleton" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  {games?.map((game) => (
                    <tr key={game.date}>
                      <th scope="row">{formatGameDate(game.date)}</th>
                      <td>
                        {game.opponent ? `${game.home === false ? "at" : "vs"} ${game.opponent}` : "–"}
                      </td>
                      <FantasyCell points={game.fantasyPoints} average={season.fantasyAvg} />
                      <td className="num">{Math.round(game.minutes)}</td>
                      <td className="num">{game.stats.pts}</td>
                      <td className="num">{game.stats.reb}</td>
                      <td className="num">{game.stats.ast}</td>
                      <td className="num">{game.stats.stl}</td>
                      <td className="num">{game.stats.blk}</td>
                      <td className="num">{game.stats.tov}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      Season average
                    </th>
                    <td className="num strong">{formatPoints(season.fantasyAvg)}</td>
                    <td className="num">{formatAverage(season.minutes)}</td>
                    <td className="num">{formatAverage(season.averages.pts)}</td>
                    <td className="num">{formatAverage(season.averages.reb)}</td>
                    <td className="num">{formatAverage(season.averages.ast)}</td>
                    <td className="num">{formatAverage(season.averages.stl)}</td>
                    <td className="num">{formatAverage(season.averages.blk)}</td>
                    <td className="num">{formatAverage(season.averages.tov)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        {shown.team && <DepthChart team={shown.team} stats={stats} playerId={player.id} />}
      </div>
    </dialog>
  );
}
