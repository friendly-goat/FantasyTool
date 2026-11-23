import { Fragment, useEffect, useMemo, useState } from "react";
import { rosterPlayers } from "../../shared/analysis.ts";
import type { TeamSituation } from "../../shared/insight.ts";
import type { Move } from "../../shared/moves.ts";
import { searchMoves } from "../search.ts";
import { TeamCharts, useProfiles } from "./TeamCharts.tsx";
import { bestNineLineup, type StrengthModel, type TeamStrength } from "../../shared/strength.ts";
import type { SearchStage, TradeOffer } from "../../shared/trade.ts";
import type { LeagueSnapshot, PlayerRef, StatsReport, Team } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned, formatStrength, formatStrengthChange, ordinal } from "../format.ts";
import { StrengthStars } from "./StrengthStars.tsx";
import { Avatar } from "./Avatar.tsx";
import { ChanceTag } from "./TeamEffect.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { PositionChip } from "./PositionChip.tsx";
import { SearchProgress } from "./SearchProgress.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  stats: StatsReport | null;
  model: StrengthModel | null;
  strengths: TeamStrength[] | null;
  team: Team;
  onChangeTeam: () => void;
  situations: Map<number, TeamSituation> | null;
  /** Opens a trade in the Trades tab's builder. */
  onOpenTrade: (offer: TradeOffer) => void;
}

const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

// The search takes a few seconds, so each team's moves are kept (and a search under way is
// shared, with how far it has got) for as long as the model stands. The model is rebuilt only
// when the data it reads changes (App's model fingerprint), so the moves are worked out once.
const movesByModel = new WeakMap<StrengthModel, Map<number, Promise<Move[]>>>();
const doneByModel = new WeakMap<StrengthModel, Map<number, Move[]>>();
type MovesProgress = { share: number; stage: SearchStage };
const progressByModel = new WeakMap<StrengthModel, Map<number, MovesProgress>>();
const progressListeners = new Set<() => void>();

/** The team's top moves, worked out after the page has painted. Null while searching, with how far it has got. */
function useTopMoves(
  model: StrengthModel | null,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation> | null,
): { moves: Move[] | null; progress: MovesProgress | null } {
  const saved = model ? (doneByModel.get(model)?.get(rosterId) ?? null) : null;
  const [found, setFound] = useState<{ model: StrengthModel; rosterId: number; moves: Move[] } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((tick) => tick + 1);
    progressListeners.add(listener);
    return () => {
      progressListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!model || !situations || doneByModel.get(model)?.has(rosterId)) return;
    let live = true;
    if (!movesByModel.has(model)) movesByModel.set(model, new Map());
    const searches = movesByModel.get(model)!;
    if (!searches.has(rosterId)) {
      if (!progressByModel.has(model)) progressByModel.set(model, new Map());
      const progress = progressByModel.get(model)!;
      progress.set(rosterId, { share: 0, stage: "setup" });
      searches.set(
        rosterId,
        searchMoves(model, snapshot, situations, rosterId, (share, stage) => {
          progress.set(rosterId, { share, stage });
          for (const listener of progressListeners) listener();
        }).then((moves) => {
          if (!doneByModel.has(model)) doneByModel.set(model, new Map());
          doneByModel.get(model)!.set(rosterId, moves);
          return moves;
        }),
      );
    }
    void searches.get(rosterId)!.then((moves) => {
      if (live) setFound({ model, rosterId, moves });
    });
    return () => {
      live = false;
    };
  }, [model, snapshot, rosterId, situations]);
  const moves = saved ?? (found && found.model === model && found.rosterId === rosterId ? found.moves : null);
  const progress = model ? (progressByModel.get(model)?.get(rosterId) ?? null) : null;
  return { moves, progress };
}

function MovePlayers({ players, notes }: { players: Move["gets"]; notes: Move["notes"] }) {
  return (
    <span className="move-players">
      {players.map((player) => (
        <PlayerCell key={player.id} player={player} extra={notes[player.id]} />
      ))}
    </span>
  );
}

/** The user's own team: the roster with its strength, and the top moves to make. */
export function MyTeam({ snapshot, stats, model, strengths, team, onChangeTeam, situations, onOpenTrade }: Props) {
  const players = stats?.players ?? {};
  const hasStats = Object.keys(players).length > 0;

  const strength = strengths?.find((entry) => entry.rosterId === team.rosterId) ?? null;
  const { moves, progress: movesProgress } = useTopMoves(model, snapshot, team.rosterId, situations);
  const teamName = (rosterId: number | null) =>
    snapshot.teams.find((candidate) => candidate.rosterId === rosterId)?.teamName ?? "another team";

  const profiles = useProfiles(snapshot, model, strengths, players, stats?.allowed);
  const profile = profiles?.get(team.rosterId) ?? null;
  const rows = useMemo(() => bestLineup(model, team), [model, team]);

  return (
    <section aria-label="My team">
      <div className="my-head">
        <div className="team-cell">
          <Avatar url={team.avatarUrl} name={team.teamName} size="lg" />
          <div>
            <h2 className="team-title">{team.teamName}</h2>
            <p className="quiet">
              {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}, {ordinal(team.rank)} of{" "}
              {snapshot.teams.length} in the standings
            </p>
          </div>
        </div>
        <button
          type="button"
          className="button button-plain change-team"
          aria-label="Change my team"
          onClick={onChangeTeam}
        >
          Change<span className="hide-narrow"> my team</span>
        </button>
      </div>

      <TeamCharts snapshot={snapshot} profile={profile} />

      <h3 className="panel-heading">Roster</h3>
      <div className="roster-card">
        <div className="roster-strength">
          {strength ? (
            <>
              <div className="roster-strength-score">
                <span className="num roster-strength-number">{formatStrength(strength.score)}</span>
                <span>
                  <span className="roster-strength-label">Team strength</span>
                  <span className="roster-strength-rank">
                    <StrengthStars score={strength.score} />
                    <span className="quiet">
                      {ordinal(strength.rank)} of {snapshot.teams.length}
                    </span>
                  </span>
                </span>
              </div>
              <div className="roster-strength-expect">
                <span className="roster-strength-expect-label">Expect a week</span>
                {profile?.ahead ? (
                  <>
                    <span className="num roster-strength-expect-value">{formatPoints(profile.ahead.average)}</span>
                    <span className="quiet roster-strength-expect-note">
                      {profile.rate.weeks > 0 ? `${percent.format(profile.rate.team)} of locks a week` : "As projected"}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="team-chart-placeholder roster-strength-expect-placeholder" />
                    <span className="quiet roster-strength-expect-note">Working it out</span>
                  </>
                )}
              </div>
              <dl className="roster-strength-facts">
                <div>
                  <dt>Locks a week</dt>
                  <dd className="num">{formatPoints(strength.projected)}</dd>
                </div>
                <div>
                  <dt>Best nine alone</dt>
                  <dd className="num">{formatPoints(strength.bestNine)}</dd>
                </div>
                <div>
                  <dt>Bench adds</dt>
                  <dd className="num">{formatSigned(strength.benchAdds)}</dd>
                </div>
              </dl>
              <p className="quiet roster-strength-note">
                Strength rates the roster for the rest of the season, out of 5. Locks a week is what it locks in an
                average week if you set the best lineup each day; the bench adds by rotating into open slots and
                covering missed games.
                {profile?.ahead && profile.rate.weeks > 0 && (
                  <>
                    {" "}
                    Expect a week is that at the {percent.format(profile.rate.team)} of your projections you have really
                    scored so far, the average on week by week above.
                  </>
                )}
                {model && " Below, your best nine by weekly value, which may differ from the lineup set in Sleeper."}
              </p>
            </>
          ) : (
            <p className="quiet roster-strength-note">Team strength appears once player stats have loaded.</p>
          )}
        </div>
        <div className="table-scroll">
          <table className="players-table my-roster">
            <thead>
              <tr>
                <th scope="col">Slot</th>
                <th scope="col">Player</th>
                {hasStats && (
                  <>
                    <th scope="col" className="num">
                      Weekly value
                    </th>
                    <th scope="col" className="num hide-narrow">
                      Fantasy avg
                    </th>
                    <th scope="col" className="num hide-narrow">
                      Projected
                    </th>
                    <th scope="col" className="num hide-narrow">
                      Last {stats?.recentWindow ?? 5}
                    </th>
                    <th scope="col" className="num hide-narrow">
                      Best game
                    </th>
                    <th scope="col" className="num hide-narrow">
                      Games
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const line = row.player ? players[row.player.id] : undefined;
                return (
                  <tr key={row.player?.id ?? `empty-${index}`}>
                    <td>
                      <PositionChip label={row.slot} />
                    </td>
                    <th scope="row">
                      {row.player ? (
                        <>
                          <PlayerCell player={row.player} />
                        </>
                      ) : (
                        <span className="quiet">Empty slot</span>
                      )}
                    </th>
                    {hasStats && (
                      <>
                        <td className="num strong">
                          {line && row.player && model?.players.get(row.player.id)
                            ? formatPoints(model.players.get(row.player.id)!.expected)
                            : "–"}
                        </td>
                        <td className="num hide-narrow">{line ? formatPoints(line.fantasyAvg) : "–"}</td>
                        <td className="num hide-narrow">{line ? formatPoints(line.projection.perGame) : "–"}</td>
                        <td className="num hide-narrow">
                          {line?.recentAvg != null ? formatPoints(line.recentAvg) : "–"}
                        </td>
                        <td className="num hide-narrow">{line ? formatPoints(line.bestGame) : "–"}</td>
                        <td className="num quiet-cell hide-narrow">{line ? line.games : "–"}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {model && (
        <>
          <h3 className="panel-heading">Top moves</h3>
          {moves === null ? (
            <SearchProgress share={movesProgress?.share ?? 0} stage={movesProgress?.stage ?? "setup"} />
          ) : moves.length > 0 ? (
            <div className="table-scroll">
              <table className="players-table moves-table">
                <thead>
                  <tr>
                    <th scope="col">Move</th>
                    <th scope="col">You get</th>
                    <th scope="col">You give</th>
                    <th scope="col" className="num">
                      Your strength
                    </th>
                    <th scope="col" className="num">
                      Chance
                    </th>
                    <th scope="col">
                      <span className="visually-hidden">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((move) => {
                    const key = `${move.kind}-${move.gets.map((player) => player.id).join("+")}-${move.gives.map((player) => player.id).join("+")}`;
                    return (
                      <Fragment key={key}>
                        <tr className={move.management.length > 0 ? "has-management" : undefined}>
                          <th scope="row" className="move-kind">
                            {move.kind === "trade" ? (
                              <>
                                <span className="move-tag move-tag-trade">Trade</span>
                                <span className="quiet">with {teamName(move.partner)}</span>
                              </>
                            ) : (
                              <>
                                <span className="move-tag move-tag-pickup">Pickup</span>
                                <span className="quiet">from waivers</span>
                              </>
                            )}
                          </th>
                          <td className="move-get" data-label="You get">
                            <MovePlayers players={move.gets} notes={move.notes} />
                          </td>
                          <td className="move-give" data-label="You give">
                            <MovePlayers players={move.gives} notes={move.notes} />
                          </td>

                          <td className="num move-change">
                            <span
                              className={`move-strength ${move.strengthChange > 0 ? "up" : move.strengthChange < 0 ? "down" : ""}`}
                            >
                              {formatStrengthChange(move.strengthChange)}
                            </span>
                            <span className="quiet move-weekly">{formatSigned(move.weeklyChange)} a week</span>
                          </td>
                          <td className="num move-chance">
                            {move.chance !== null && move.likelihood ? (
                              <>
                                <ChanceTag chance={move.chance} showPercent />
                              </>
                            ) : (
                              <span className="quiet">Yours to make</span>
                            )}
                          </td>
                          <td className="move-action">
                            {move.idea && (
                              <button
                                type="button"
                                className="button button-plain"
                                onClick={() => onOpenTrade(move.idea!.offer)}
                              >
                                Open in builder
                              </button>
                            )}
                          </td>
                        </tr>
                        {move.management.length > 0 && (
                          <tr className="move-management-row">
                            <td colSpan={6}>
                              <span className="move-management-title">Team management, not part of the trade:</span>{" "}
                              {move.management.join("; ")}.
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="quiet">No trade or pickup would raise your team's strength right now.</p>
          )}
          {moves && moves.length > 0 && !moves.some((move) => move.kind === "pickup") && (
            <p className="quiet moves-note">No waiver pickup would raise your team right now, so none is listed.</p>
          )}
        </>
      )}

      {hasStats && (
        <p className="quiet legend">
          Top moves are the trades from "see the best trades for my team" on the Trades tab (only those with at least a
          fair chance of being accepted) and the best waiver pickups, ranked together by how much each raises your
          team's strength over the rest of the season. A pickup drops the player your roster would miss least. When no
          pickup makes the top five on merit, the best one that still raises your team takes the last place. Under each strength change is the
          change in your projected weekly score behind it.
        </p>
      )}
    </section>
  );
}

/**
 * The roster as it is best set for the rest of the season: the best nine by weekly value in
 * their slots (bestNineLineup, the nine team strength counts), then the rest of the active
 * roster by weekly value, then injured reserve. Sleeper's own lineup until the stats load.
 */
function bestLineup(model: StrengthModel | null, team: Team): { slot: string; player: PlayerRef | null }[] {
  if (!model) {
    return [
      ...team.starters,
      ...team.bench.map((player) => ({ slot: "BN", player })),
      ...team.reserve.map((player) => ({ slot: "IR", player })),
    ];
  }
  const refs = new Map(rosterPlayers(team).map((player) => [player.id, player]));
  const nine = bestNineLineup(model, [...refs.keys()]);
  const used = new Set(nine.flatMap((row) => (row.player ? [row.player.id] : [])));
  const value = (player: PlayerRef) => model.players.get(player.id)?.expected ?? 0;
  const reserve = new Set(team.reserve.map((player) => player.id));
  const rest = [...refs.values()].filter((player) => !used.has(player.id));
  return [
    ...nine.map((row) => ({ slot: row.slot, player: row.player ? (refs.get(row.player.id) ?? null) : null })),
    ...rest.filter((player) => !reserve.has(player.id)).sort((a, b) => value(b) - value(a)).map((player) => ({ slot: "BN", player })),
    ...rest.filter((player) => reserve.has(player.id)).map((player) => ({ slot: "IR", player })),
  ];
}
