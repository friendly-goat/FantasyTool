import type { LeagueSnapshot, PlayerRef, PlayerStats, StatsReport } from "../../shared/types.ts";
import { formatAverage, formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PositionChip } from "./PositionChip.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  stats: StatsReport | null;
  selectedRosterId: number | null;
  onSelect: (rosterId: number) => void;
}

interface LineProps {
  slot: string;
  player: PlayerRef | null;
  stats: PlayerStats | undefined;
  showStats: boolean;
}

function PlayerLine({ slot, player, stats, showStats }: LineProps) {
  return (
    <tr>
      <td className="slot">
        <PositionChip label={slot} />
      </td>
      <th scope="row">
        {player ? (
          <>
            <span className="player-name">{player.name}</span>
            {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
            <span className="quiet player-meta">
              {[player.positions.join("/"), player.team ?? "Free agent"].filter(Boolean).join(", ")}
            </span>
          </>
        ) : (
          <span className="quiet">Empty slot</span>
        )}
      </th>
      {showStats && (
        <>
          <td className="num strong">{stats ? formatAverage(stats.fantasyAvg) : "–"}</td>
          <td className="num">{stats?.recentAvg != null ? formatAverage(stats.recentAvg) : "–"}</td>
          <td className="num quiet-cell">{stats ? stats.games : "–"}</td>
        </>
      )}
    </tr>
  );
}

export function Teams({ snapshot, stats, selectedRosterId, onSelect }: Props) {
  const team =
    snapshot.teams.find((candidate) => candidate.rosterId === selectedRosterId) ?? snapshot.teams[0];
  if (!team) return <p className="quiet">This league has no teams yet.</p>;

  const players = stats?.players ?? {};
  const showStats = Object.keys(players).length > 0;
  const groups: { title: string; lines: { slot: string; player: PlayerRef | null }[] }[] = [
    { title: "Starters", lines: team.starters },
    { title: "Bench", lines: team.bench.map((player) => ({ slot: "BN", player })) },
    { title: "Injured reserve", lines: team.reserve.map((player) => ({ slot: "IR", player })) },
  ].filter((group) => group.lines.length > 0);

  const starterTotal = team.starters.reduce(
    (sum, starter) => sum + (starter.player ? (players[starter.player.id]?.fantasyAvg ?? 0) : 0),
    0,
  );

  return (
    <section className="teams" aria-label="Teams">
      <ul className="team-rail">
        {snapshot.teams.map((candidate) => (
          <li key={candidate.rosterId}>
            <button
              type="button"
              className="rail-item"
              aria-current={candidate.rosterId === team.rosterId ? "true" : undefined}
              onClick={() => onSelect(candidate.rosterId)}
            >
              <Avatar url={candidate.avatarUrl} name={candidate.teamName} size="sm" />
              <span className="rail-name">{candidate.teamName}</span>
              <span className="num quiet">{formatRecord(candidate.wins, candidate.losses, candidate.ties)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="card roster">
        <div className="team-cell">
          <Avatar url={team.avatarUrl} name={team.teamName} size="lg" />
          <div>
            <h2 className="team-title">{team.teamName}</h2>
            <p className="quiet">
              {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}, {formatPoints(team.pointsFor)}{" "}
              points scored
            </p>
          </div>
        </div>

        {showStats && (
          <p className="roster-summary">
            Starters average <strong>{formatAverage(starterTotal)}</strong> fantasy points per game combined.
          </p>
        )}

        <div className="roster-scroll">
          <table className="roster-table">
            {groups.map((group, groupIndex) => (
              <tbody key={group.title}>
                <tr className="group-row">
                  <th scope="col" colSpan={2}>
                    {group.title}
                  </th>
                  {showStats && (
                    <>
                      <th scope="col" className="num">
                        {groupIndex === 0 ? "Fantasy avg" : ""}
                      </th>
                      <th scope="col" className="num">
                        {groupIndex === 0 ? `Last ${stats?.recentWindow ?? 5}` : ""}
                      </th>
                      <th scope="col" className="num">
                        {groupIndex === 0 ? "Games" : ""}
                      </th>
                    </>
                  )}
                </tr>
                {group.lines.map((line, index) => (
                  <PlayerLine
                    key={line.player?.id ?? `empty-${index}`}
                    slot={line.slot}
                    player={line.player}
                    stats={line.player ? players[line.player.id] : undefined}
                    showStats={showStats}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </section>
  );
}
