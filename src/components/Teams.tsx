import { useRef } from "react";
import type { StrengthModel, TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot, PlayerRef, PlayerStats, StatsReport } from "../../shared/types.ts";
import { formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PositionChip } from "./PositionChip.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { TeamCharts, useProfiles } from "./TeamCharts.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  /** The snapshot the model was built from (the same one My team's charts use), for the charts. */
  modelSnapshot: LeagueSnapshot;
  model: StrengthModel | null;
  strengths: TeamStrength[] | null;
  stats: StatsReport | null;
  myRosterId: number | null;
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
            <PlayerCell player={player} />
          </>
        ) : (
          <span className="quiet">Empty slot</span>
        )}
      </th>
      {showStats && (
        <>
          <td className="num strong">{stats ? formatPoints(stats.fantasyAvg) : "–"}</td>
          <td className="num">{stats?.recentAvg != null ? formatPoints(stats.recentAvg) : "–"}</td>
          <td className="num quiet-cell hide-narrow">{stats ? stats.games : "–"}</td>
        </>
      )}
    </tr>
  );
}

const NO_PLAYERS: Record<string, PlayerStats> = {};

export function Teams({ snapshot, modelSnapshot, model, strengths, stats, myRosterId, selectedRosterId, onSelect }: Props) {
  const team =
    snapshot.teams.find((candidate) => candidate.rosterId === selectedRosterId) ?? snapshot.teams[0];
  const players = stats?.players ?? NO_PLAYERS;
  // Every team's charts, worked out once per model and shared with My team.
  const profiles = useProfiles(modelSnapshot, model, strengths, players, stats?.allowed);
  const head = useRef<HTMLDivElement>(null);
  if (!team) return <p className="quiet">This league has no teams yet.</p>;

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
              onClick={() => {
                onSelect(candidate.rosterId);
                // The team's name and charts sit above the list: bring them back into view
                // when the page has been scrolled past them.
                const top = head.current?.getBoundingClientRect().top ?? 0;
                if (top < 0) head.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <Avatar url={candidate.avatarUrl} name={candidate.teamName} size="sm" />
              <span className="rail-name">
                {candidate.teamName}
                {candidate.rosterId === myRosterId && <span className="mine">You</span>}
              </span>
              <span className="num quiet">{formatRecord(candidate.wins, candidate.losses, candidate.ties)}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* The selected team across the page: who it is, then its charts (as wide as on My team),
          then the team list and its roster side by side. */}
      <div className="team-cell team-head" ref={head}>
        <Avatar url={team.avatarUrl} name={team.teamName} size="lg" />
        <div>
          <h2 className="team-title">{team.teamName}</h2>
          <p className="quiet">
            {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}, {formatPoints(team.pointsFor)}{" "}
            points scored
          </p>
        </div>
      </div>

      <div className="team-detail-charts">
        <TeamCharts
          snapshot={modelSnapshot}
          profile={profiles?.get(team.rosterId) ?? null}
          own={team.rosterId === myRosterId}
        />
      </div>

      <div className="card roster">
        {showStats && (
          <p className="roster-summary">
            Starters average <strong>{formatPoints(starterTotal)}</strong> fantasy points per game combined.
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
                      <th scope="col" className="num hide-narrow">
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
