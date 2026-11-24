import { nbaDay } from "../../shared/weeks.ts";
import { useEffect, useRef, useState } from "react";
import { newsOutText, returnOutlook } from "../../shared/injury.ts";
import type { DraftBoard, LeagueSnapshot, PlayerCareer, PlayerDetail, PlayerGame, MissedGame, PlayerRef, PlayerStats, StatsReport } from "../../shared/types.ts";
import { getDraft, getPlayerCareer, getPlayerDetail } from "../api.ts";
import { CareerChart } from "./CareerChart.tsx";
import { readSaved, savedKeys, writeSaved } from "../saved.ts";
import { closeDialog, openDialog } from "../closeDialog.ts";
import { useBackToClose, useSheetPull } from "../sheetGestures.ts";
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

/** Where he went in this league's draft, in Sleeper's words ("Round 2, pick 7: 19th overall by ..."), or why not. */
function draftLine(snapshot: LeagueSnapshot, board: DraftBoard | null | undefined, playerId: string): string | null {
  if (!board || board.picks.length === 0) return null;
  const pick = board.picks.find((entry) => entry.player.id === playerId);
  if (!pick) return board.status === "complete" ? "Undrafted in this league" : null;
  const by = snapshot.teams.find((team) => team.rosterId === pick.rosterId)?.teamName;
  const label = `${pick.round}.${String(pick.pickInRound).padStart(2, "0")}`;
  return `${pick.keeper ? "Kept at" : "Drafted"} ${label}, ${ordinal(pick.pickNo)} overall${by ? ` by ${by}` : ""}`;
}

function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
  return `${value}${suffix}`;
}

/** The draft board: the copy kept on the device at once, then a fresh one when there is none. */
function useDraftBoard(leagueId: string): DraftBoard | null | undefined {
  const [board, setBoard] = useState<DraftBoard | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    readSaved<DraftBoard | null>(savedKeys.draft(leagueId))
      .catch(() => undefined)
      .then((saved) => {
        if (!current) return;
        if (saved !== undefined) return setBoard(saved);
        getDraft(leagueId)
          .then((result) => {
            void writeSaved(savedKeys.draft(leagueId), result.board).catch(() => {});
            if (current) setBoard(result.board);
          })
          .catch(() => current && setBoard(null));
      });
    return () => {
      current = false;
    };
  }, [leagueId]);
  return board;
}

/** "2026-27 season" for Sleeper's season "2026". */
function seasonName(year: number): string {
  return `${year}-${String((year + 1) % 100).padStart(2, "0")} season`;
}

/**
 * A finished season's game log (`year`, null for none), fetched the first time it is picked and
 * then kept for the visit, since a finished season does not change. The server reads last season
 * from box scores it has already saved, and fetches an older one once and keeps it.
 */
function usePastSeason(leagueId: string, playerId: string, year: string | null): { detail: PlayerDetail | null; error: string | null } {
  const key = `${leagueId}:${playerId}:${year}`;
  const [state, setState] = useState<{ key: string; detail: PlayerDetail | null; error: string | null }>({ key, detail: null, error: null });
  useEffect(() => {
    if (!year) return;
    const saved = details.get(key);
    if (saved) return setState({ key, detail: saved.detail, error: null });
    let current = true;
    getPlayerDetail(leagueId, playerId, year)
      .then((loaded) => {
        details.set(key, { detail: loaded, at: Date.now() });
        if (current) setState({ key, detail: loaded, error: null });
      })
      .catch((cause) => current && setState({ key, detail: null, error: cause instanceof Error ? cause.message : "Could not load that season." }));
    return () => {
      current = false;
    };
  }, [key, year, leagueId, playerId]);
  return state.key === key ? state : { detail: null, error: null };
}

/** The picker's value for the career graph (seasons are years). */
const CAREER = "career";

/**
 * The season picker: the career graph first, set apart, then each season. A plain heading when he
 * has only this season (a rookie).
 */
function SeasonPick({ seasons, value, onChange }: { seasons: string[]; value: string; onChange: (season: string) => void }) {
  if (seasons.length <= 1) return <h3 className="panel-heading">{seasonName(Number(seasons[0] ?? value))}</h3>;
  return (
    <div className="panel-heading season-pick">
      <select
        aria-label="Season"
        className={value === CAREER ? "is-career" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value={CAREER}>Career graph</option>
        <optgroup label="Seasons">
          {seasons.map((year) => (
            <option key={year} value={year}>
              {seasonName(Number(year))}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}

// Careers already loaded this visit.
const careers = new Map<string, PlayerCareer>();
/** How often to ask again while his earlier seasons are fetched. */
const CAREER_POLL_MS = 2500;

/**
 * A player's career for the graph, fetched when picked. While the server fetches his earlier
 * seasons it answers "loading", and this asks again every few seconds until they are in.
 */
function useCareer(leagueId: string, playerId: string, wanted: boolean): PlayerCareer | null {
  const key = `${leagueId}:${playerId}`;
  const [state, setState] = useState<{ key: string; career: PlayerCareer | null }>({ key, career: null });
  useEffect(() => {
    if (!wanted) return;
    const saved = careers.get(key);
    if (saved) return setState({ key, career: saved });
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      getPlayerCareer(leagueId, playerId)
        .then((loaded) => {
          if (!current) return;
          if (loaded.status === "ready") careers.set(key, loaded);
          setState({ key, career: loaded });
          if (loaded.status === "loading") timer = setTimeout(ask, CAREER_POLL_MS);
        })
        .catch((cause) => {
          if (current) setState({ key, career: { status: "error", error: cause instanceof Error ? cause.message : "Could not load his career.", seasons: [], games: [], missed: [] } });
        });
    void ask();
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, wanted, leagueId, playerId]);
  return state.key === key ? state.career : null;
}

/** Games he played and missed, newest first, for the game log. */
type LogRow = { kind: "game"; game: PlayerGame } | { kind: "out"; game: MissedGame };
function logRows(games: PlayerGame[], missed: MissedGame[]): LogRow[] {
  return [...games.map((game) => ({ kind: "game" as const, game })), ...missed.map((game) => ({ kind: "out" as const, game }))].sort((a, b) =>
    b.game.date.localeCompare(a.game.date),
  );
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

/** Rows held for a finished season's log while it loads. */
const PAST_LOADING_ROWS = 30;

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

/** One game he played in the game log. */
function GameRow({ game, average }: { game: PlayerGame; average: number }) {
  return (
    <tr>
      <th scope="row">{formatGameDate(game.date)}</th>
      <td>{game.opponent ? `${game.home === false ? "at" : "vs"} ${game.opponent}` : "–"}</td>
      <FantasyCell points={game.fantasyPoints} average={average} />
      <td className="num">{Math.round(game.minutes)}</td>
      <td className="num">{game.stats.pts}</td>
      <td className="num">{game.stats.reb}</td>
      <td className="num">{game.stats.ast}</td>
      <td className="num">{game.stats.stl}</td>
      <td className="num">{game.stats.blk}</td>
      <td className="num">{game.stats.tov}</td>
    </tr>
  );
}

/** The game log for one season: every game he played, and every game his team played without him. */
function GameLog({
  stats,
  games,
  missedGames,
  loadingRows,
}: {
  stats: PlayerStats | null;
  games: PlayerGame[] | null;
  missedGames: MissedGame[] | null;
  /** Rows to hold the space while the log loads. */
  loadingRows: number;
}) {
  return (
    <>
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
              Array.from({ length: Math.min(loadingRows, 82) }, (_, index) => (
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
            {games &&
              stats &&
              logRows(games, missedGames ?? []).map((row) =>
                row.kind === "out" ? (
                  <tr key={row.game.date} className="log-out">
                    <th scope="row">{formatGameDate(row.game.date)}</th>
                    <td>{row.game.opponent ? `${row.game.home === false ? "at" : "vs"} ${row.game.opponent}` : "–"}</td>
                    <td className="num log-fpts log-out-tag">Out</td>
                    <td colSpan={7} />
                  </tr>
                ) : (
                  <GameRow key={row.game.date} game={row.game} average={stats.fantasyAvg} />
                ),
              )}
          </tbody>
          {stats && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={2}>
                Season average
              </th>
              <td className="num strong">{formatPoints(stats.fantasyAvg)}</td>
              <td className="num">{formatAverage(stats.minutes)}</td>
              <td className="num">{formatAverage(stats.averages.pts)}</td>
              <td className="num">{formatAverage(stats.averages.reb)}</td>
              <td className="num">{formatAverage(stats.averages.ast)}</td>
              <td className="num">{formatAverage(stats.averages.stl)}</td>
              <td className="num">{formatAverage(stats.averages.blk)}</td>
              <td className="num">{formatAverage(stats.averages.tov)}</td>
            </tr>
          </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

export function PlayerPanel({ snapshot, stats, player, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  // On a phone: pull down from the top to close; Back closes the card instead of leaving the page.
  useSheetPull(dialog);
  useBackToClose(true, () => closeDialog(dialog.current));
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) openDialog(element);
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
  const seasonYear = Number(snapshot.league.season) || new Date().getUTCFullYear();
  const thisSeason = String(seasonYear);
  // The seasons he can be viewed in come with his details (back to his first, from his years in
  // the league); this season alone until they arrive, last season too from an older server.
  const seasons = detail ? (detail.seasons ?? [thisSeason, String(seasonYear - 1)]) : [thisSeason];
  // Which season the chart and game log show: this one, or a finished one's regular season.
  const [which, setWhich] = useState(thisSeason);
  useEffect(() => setWhich(thisSeason), [player.id, thisSeason]);
  const careerView = which === CAREER && seasons.length > 1;
  const career = useCareer(snapshot.league.id, player.id, careerView);
  const pastYear = which !== thisSeason && seasons.includes(which) ? which : null;
  const past = usePastSeason(snapshot.league.id, player.id, pastYear);
  const pastStats = past.detail?.stats ?? null;
  const pastLoading = pastYear !== null && !past.detail && !past.error;
  const games = pastYear ? (past.detail?.games ?? null) : (detail?.games ?? null);
  const missedGames = pastYear ? (past.detail?.missed ?? null) : (detail?.missed ?? null);
  // While a finished season loads, the chart keeps its place with this season's numbers.
  const chartStats = pastYear ? (pastStats ?? (pastLoading ? season : null)) : season;
  const showLog = pastYear ? pastStats !== null || pastLoading : season !== null;
  const draft = draftLine(snapshot, useDraftBoard(snapshot.league.id), player.id);
  const today = nbaDay(Date.now());
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
      <div className="sheet-grabber panel-grabber" aria-hidden="true" />
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
            {draft && <p className="quiet player-draft">{draft}</p>}
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
        )}

        {season && formatPoints(season.sleeperAvg) !== formatPoints(season.fantasyAvg) && (
              <p className="quiet panel-note">
                Sleeper's app shows {formatPoints(season.sleeperAvg)} as this player's average. Sleeper counts
                each scoring bonus once against season totals, so its number differs from the average of the
                games below.
              </p>
        )}

        {/* The season picker shows with this season's numbers, or for a player with only past seasons. */}
        {(season || seasons.length > 1) && (
          <>
            <SeasonPick seasons={seasons} value={careerView ? CAREER : (pastYear ?? thisSeason)} onChange={setWhich} />
            {careerView && <CareerChart career={career} onPickSeason={setWhich} />}
            {pastYear && past.error && <p className="notice notice-error">{past.error}</p>}
            {pastYear && past.detail && !pastStats && (
              <p className="notice">No regular-season games for him in the {seasonName(Number(pastYear))}.</p>
            )}
            {!careerView && chartStats && (
            <ProjectionChart
              stats={chartStats}
              games={games}
              missedGames={missedGames}
              finished={pastYear !== null}
              absence={
                // From today: the games he has missed since the report are on the chart already.
                pastYear || !season || !injury
                  ? null
                  : outlook?.kind === "season"
                  ? absenceFor(season, today > injury.asOf ? today : injury.asOf, null, null)
                  : outlook?.kind === "window"
                    ? absenceFor(
                        season,
                        today > injury.asOf ? today : injury.asOf,
                        outlook.window.expected,
                        formatDay(outlook.window.expected, injury.asOf),
                      )
                    : null
              }
            />
            )}
            {!careerView && !pastYear && season && (
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
            )}

            {!careerView && showLog && (
            <GameLog
              stats={pastYear ? pastStats : season}
              games={games}
              missedGames={missedGames}
              loadingRows={
                pastYear === String(seasonYear - 1)
                  ? (season?.projection.lastSeason?.games ?? PAST_LOADING_ROWS)
                  : pastYear
                    ? PAST_LOADING_ROWS
                    : (season?.games ?? 0)
              }
            />
            )}
          </>
        )}

        {/* This season's rotation only: hidden while a past season is shown, so it is not read as that season's. */}
        {!careerView && !pastYear && shown.team && <DepthChart team={shown.team} stats={stats} playerId={player.id} />}
      </div>
    </dialog>
  );
}
