import { useMemo } from "react";
import { freeAgentUpgrades, leagueOutlook, startingSlots } from "../../shared/analysis.ts";
import { TYPICAL_GAMES_PER_WEEK } from "../../shared/lockin.ts";
import type { LeagueSnapshot, PlayerRef, StatsReport, Team } from "../../shared/types.ts";
import { formatPoints, formatRecord, formatSigned } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChip } from "./PositionChip.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  stats: StatsReport | null;
  team: Team;
  onChangeTeam: () => void;
  onOpenMatchup: (matchupId: number) => void;
}

function ordinal(n: number): string {
  const suffix = ["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** The user's own team: this week's matchup, a lineup check, the roster, and free agents worth adding. */
export function MyTeam({ snapshot, stats, team, onChangeTeam, onOpenMatchup }: Props) {
  const players = stats?.players ?? {};
  const hasStats = Object.keys(players).length > 0;
  const slots = startingSlots(snapshot);

  const analysis = useMemo(() => {
    if (!stats || Object.keys(stats.players).length === 0) return null;
    const outlooks = leagueOutlook(snapshot, stats);
    const index = outlooks.findIndex((outlook) => outlook.rosterId === team.rosterId);
    return {
      outlook: outlooks[index]!,
      rank: index + 1,
      upgrades: freeAgentUpgrades(team, snapshot, stats),
    };
  }, [snapshot, stats, team]);

  const matchup = snapshot.matchups.find((candidate) =>
    candidate.sides.some((side) => side.rosterId === team.rosterId),
  );
  const mine = matchup?.sides.find((side) => side.rosterId === team.rosterId);
  const theirs = matchup?.sides.find((side) => side.rosterId !== team.rosterId);
  const opponent = theirs ? snapshot.teams.find((candidate) => candidate.rosterId === theirs.rosterId) : undefined;
  const stillToScore = (side: typeof mine) => side?.starters.filter((entry) => entry.player && !entry.points).length ?? 0;

  // Players the best lineup starts who are not starting now, and the reverse.
  const everyone = new Map<string, PlayerRef>(
    [...team.starters.flatMap((s) => (s.player ? [s.player] : [])), ...team.bench, ...team.reserve].map((p) => [p.id, p]),
  );
  const startingNow = new Set(team.starters.flatMap((starter) => (starter.player ? [starter.player.id] : [])));
  const bestIds = new Set(analysis?.outlook.best.playerIds.filter((id): id is string => id !== null) ?? []);
  const bringIn = [...bestIds].filter((id) => !startingNow.has(id)).map((id) => everyone.get(id)!);
  const sitDown = [...startingNow].filter((id) => !bestIds.has(id)).map((id) => everyone.get(id)!);
  const lineupGain = analysis ? analysis.outlook.bestValue - analysis.outlook.currentValue : 0;

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
        <button type="button" className="button button-plain" onClick={onChangeTeam}>
          Change my team
        </button>
      </div>

      <div className="my-cards">
        <div className="card my-card">
          <h3 className="my-card-title">Week {snapshot.week} matchup</h3>
          {mine && theirs ? (
            <>
              <p className="my-score">
                <span className={`num${mine.points > theirs.points ? " up" : ""}`}>{formatPoints(mine.points)}</span>
                <span className="quiet">to</span>
                <span className={`num${theirs.points > mine.points ? " up" : ""}`}>{formatPoints(theirs.points)}</span>
              </p>
              <p>against {opponent?.teamName ?? `roster ${theirs.rosterId}`}</p>
              <p className="quiet">
                Starters still to score: {stillToScore(mine)} for you, {stillToScore(theirs)} for them.
              </p>
              <button type="button" className="button my-card-action" onClick={() => onOpenMatchup(matchup!.matchupId)}>
                View matchup
              </button>
            </>
          ) : (
            <p className="quiet">No matchup this week.</p>
          )}
        </div>

        <div className="card my-card">
          <h3 className="my-card-title">Lineup check</h3>
          {analysis ? (
            <>
              <p className="my-score">
                <span className="num">{formatPoints(analysis.outlook.bestValue)}</span>
              </p>
              <p>
                Lock-in value of your best lineup, {ordinal(analysis.rank)} of {snapshot.teams.length} in the
                league.
              </p>
              {lineupGain > 0.005 && bringIn.length > 0 ? (
                <p className="quiet">
                  Your current lineup is worth {formatPoints(analysis.outlook.currentValue)}. Starting{" "}
                  {bringIn.map((player, index) => (
                    <span key={player.id}>
                      {index > 0 && ", "}
                      <PlayerName player={player} />
                    </span>
                  ))}
                  {sitDown.length > 0 && (
                    <>
                      {" "}
                      over{" "}
                      {sitDown.map((player, index) => (
                        <span key={player.id}>
                          {index > 0 && ", "}
                          <PlayerName player={player} />
                        </span>
                      ))}
                    </>
                  )}{" "}
                  would add {formatPoints(lineupGain)}.
                </p>
              ) : (
                <p className="quiet">Your current lineup is already your best one by lock-in value.</p>
              )}
            </>
          ) : (
            <p className="quiet">Available once player stats have loaded.</p>
          )}
        </div>
      </div>

      <h3 className="panel-heading">Roster</h3>
      <div className="table-scroll">
        <table className="players-table">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">Player</th>
              {hasStats && (
                <>
                  <th scope="col" className="num">Lock-in value</th>
                  <th scope="col" className="num">Fantasy avg</th>
                  <th scope="col" className="num">Last {stats?.recentWindow ?? 5}</th>
                  <th scope="col" className="num">Best game</th>
                  <th scope="col" className="num">Games</th>
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
                        <span className="player-name">
                          <PlayerName player={row.player} />
                        </span>
                        {row.player.injuryStatus && <span className="injury">{row.player.injuryStatus}</span>}
                        <span className="quiet">
                          {[row.player.positions.join("/"), row.player.team].filter(Boolean).join(", ")}
                        </span>
                      </>
                    ) : (
                      <span className="quiet">Empty slot</span>
                    )}
                  </th>
                  {hasStats && (
                    <>
                      <td className="num strong">{line ? formatPoints(line.lockInValue) : "–"}</td>
                      <td className="num">{line ? formatPoints(line.fantasyAvg) : "–"}</td>
                      <td className="num">{line?.recentAvg != null ? formatPoints(line.recentAvg) : "–"}</td>
                      <td className="num">{line ? formatPoints(line.bestGame) : "–"}</td>
                      <td className="num quiet-cell">{line ? line.games : "–"}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {analysis && (
        <>
          <h3 className="panel-heading">Free agents who would improve your best lineup</h3>
          {analysis.upgrades.length > 0 ? (
            <div className="table-scroll">
              <table className="players-table">
                <thead>
                  <tr>
                    <th scope="col">Player</th>
                    <th scope="col">Would start at</th>
                    <th scope="col" className="num">Lock-in value</th>
                    <th scope="col" className="num">Games</th>
                    <th scope="col" className="num">Lineup gain</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.upgrades.map((upgrade) => (
                    <tr key={upgrade.player.id}>
                      <th scope="row">
                        <span className="player-name">
                          <PlayerName player={upgrade.player} />
                        </span>
                        <span className="quiet">
                          {[upgrade.player.positions.join("/"), upgrade.player.team].filter(Boolean).join(", ")}
                        </span>
                      </th>
                      <td>
                        <PositionChip label={upgrade.slot} />
                      </td>
                      <td className="num">{formatPoints(upgrade.player.lockInValue)}</td>
                      <td className="num quiet-cell">{upgrade.player.games}</td>
                      <td className="num up">{formatSigned(upgrade.gain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="quiet">No free agent would start for you right now.</p>
          )}
        </>
      )}

      {hasStats && (
        <p className="quiet legend">
          Lock-in value is the score you can expect to lock from a player in a week with{" "}
          {TYPICAL_GAMES_PER_WEEK} games, if you lock a game only when it beats what his remaining games are
          likely to give. It comes from his own game scores this season, so it is rough for players with few
          games, and it does not yet know how many games each player has this week. Players ruled out or on
          injured reserve are left out of the best lineup ({slots.length} starting slots).
        </p>
      )}
    </section>
  );
}
