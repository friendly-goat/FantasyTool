import { Fragment, useEffect, useState } from "react";
import type { TeamSituation } from "../../shared/insight.ts";
import { type Move, topMoves } from "../../shared/moves.ts";
import type { StrengthModel, TeamStrength } from "../../shared/strength.ts";
import type { TradeOffer } from "../../shared/trade.ts";
import type { LeagueSnapshot, PlayerRef, StatsReport, Team } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned, formatWholeChange } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { PositionChip } from "./PositionChip.tsx";

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

// The search takes a second or two, so each team's moves are kept for as long as the model stands.
const movesByModel = new WeakMap<StrengthModel, Map<number, Move[]>>();

/** The team's top moves, worked out after the page has painted. Null while searching. */
function useTopMoves(
  model: StrengthModel | null,
  snapshot: LeagueSnapshot,
  rosterId: number,
  situations: Map<number, TeamSituation> | null,
): Move[] | null {
  const saved = model ? (movesByModel.get(model)?.get(rosterId) ?? null) : null;
  const [found, setFound] = useState<{ model: StrengthModel; rosterId: number; moves: Move[] } | null>(null);
  useEffect(() => {
    if (!model || !situations || movesByModel.get(model)?.has(rosterId)) return;
    const timer = window.setTimeout(() => {
      const moves = topMoves(model, snapshot, rosterId, situations);
      if (!movesByModel.has(model)) movesByModel.set(model, new Map());
      movesByModel.get(model)!.set(rosterId, moves);
      setFound({ model, rosterId, moves });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [model, snapshot, rosterId, situations]);
  if (saved) return saved;
  return found && found.model === model && found.rosterId === rosterId ? found.moves : null;
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

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** The user's own team: the roster with its strength, and the top moves to make. */
export function MyTeam({ snapshot, stats, model, strengths, team, onChangeTeam, situations, onOpenTrade }: Props) {
  const players = stats?.players ?? {};
  const hasStats = Object.keys(players).length > 0;

  const strength = strengths?.find((entry) => entry.rosterId === team.rosterId) ?? null;
  const moves = useTopMoves(model, snapshot, team.rosterId, situations);
  const teamName = (rosterId: number | null) =>
    snapshot.teams.find((candidate) => candidate.rosterId === rosterId)?.teamName ?? "another team";

  const rows: { slot: string; player: PlayerRef | null }[] = [
    ...team.starters,
    ...team.bench.map((player) => ({ slot: "BN", player })),
    ...team.reserve.map((player) => ({ slot: "IR", player })),
  ];

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

      <h3 className="panel-heading">Roster</h3>
      <div className="roster-card">
        <div className="roster-strength">
          {strength ? (
            <>
              <div className="roster-strength-score">
                <span className="num roster-strength-number">{strength.score}</span>
                <span>
                  <span className="roster-strength-label">Team strength</span>
                  <span className="quiet">
                    of 1000, {ordinal(strength.rank)} of {snapshot.teams.length}
                  </span>
                </span>
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
              <span className="meter roster-strength-meter" aria-hidden="true">
                <span className="meter-fill" style={{ width: `${strength.score / 10}%` }} />
              </span>
              <p className="quiet roster-strength-note">
                Points locked in an average week for the rest of the season, if you set the best lineup each day. The
                bench adds by rotating into open slots and covering missed games.
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
            <p className="quiet">Looking for the best trades and pickups…</p>
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
                              {formatWholeChange(move.strengthChange)}
                            </span>
                            <span className="quiet move-weekly">{formatSigned(move.weeklyChange)} a week</span>
                          </td>
                          <td className="num move-chance">
                            {move.chance !== null && move.likelihood ? (
                              <>
                                {percent.format(move.chance)}{" "}
                                <span className={`likelihood likelihood-${move.likelihood.replace(" ", "-")}`}>
                                  {move.likelihood}
                                </span>
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
        </>
      )}

      {hasStats && (
        <p className="quiet legend">
          Top moves are the trades from "see the best trades for my team" on the Trades tab (only those with at least a
          fair chance of being accepted) and the best waiver pickups, ranked together by how much each raises your
          team's strength over the rest of the season. A pickup drops the player your roster would miss least. When no
          pickup makes the top five on merit, the best one takes the last place. Under each strength change is the
          change in your projected weekly score behind it.
        </p>
      )}
    </section>
  );
}
