import type { LeagueSnapshot, Matchup, MatchupSide, MatchupSlot, StatsReport, Team } from "../../shared/types.ts";
import { formatAverage, formatPoints, formatRecord } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChip } from "./PositionChip.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  stats: StatsReport | null;
  matchup: Matchup;
  onBack: () => void;
  onOpenTeam: (rosterId: number) => void;
}

function SlotCell({ entry, stats, side }: { entry: MatchupSlot | undefined; stats: StatsReport | null; side: "left" | "right" }) {
  if (!entry) return <div className={`duel-cell duel-${side}`} />;
  const player = entry.player;
  const average = player ? stats?.players[player.id]?.fantasyAvg : undefined;
  return (
    <div className={`duel-cell duel-${side}`}>
      <div className="duel-player">
        {player ? (
          <>
            <span className="duel-name">
              <PlayerName player={player} />
              {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
            </span>
            <span className="quiet">
              {[player.positions.join("/"), player.team].filter(Boolean).join(", ")}
              {average != null && `, averages ${formatAverage(average)}`}
            </span>
          </>
        ) : (
          <span className="quiet">Empty slot</span>
        )}
      </div>
      <span className={`num duel-points${entry.points ? "" : " quiet-cell"}`}>
        {entry.points ? formatPoints(entry.points) : "–"}
      </span>
    </div>
  );
}

function TeamHead({ team, side, onOpenTeam }: { team: Team | undefined; side: MatchupSide; onOpenTeam: (id: number) => void }) {
  return (
    <div className="duel-team">
      <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} size="lg" />
      <div>
        <button type="button" className="team-link" onClick={() => onOpenTeam(side.rosterId)}>
          {team?.teamName ?? `Roster ${side.rosterId}`}
        </button>
        {team && (
          <span className="quiet manager">
            {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Both lineups of one matchup, side by side, slot by slot. */
export function MatchupDetail({ snapshot, stats, matchup, onBack, onOpenTeam }: Props) {
  const [left, right] = matchup.sides;
  if (!left) return null;
  const team = (side: MatchupSide | undefined) =>
    side ? snapshot.teams.find((candidate) => candidate.rosterId === side.rosterId) : undefined;
  const leading = (side: MatchupSide, other: MatchupSide | undefined) => other != null && side.points > other.points;

  const rows = (pick: (side: MatchupSide) => MatchupSlot[]) => {
    const a = pick(left);
    const b = right ? pick(right) : [];
    return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => ({
      left: a[index],
      right: b[index],
      slot: a[index]?.slot ?? b[index]?.slot ?? "",
    }));
  };
  const starters = rows((side) => side.starters);
  const bench = rows((side) => side.bench);
  const waiting = (side: MatchupSide) => side.starters.filter((entry) => entry.player && !entry.points).length;

  return (
    <section aria-label={`Week ${snapshot.week} matchup`}>
      <button type="button" className="button button-plain back-button" onClick={onBack}>
        All matchups
      </button>

      <div className="card duel">
        <div className="duel-head">
          <TeamHead team={team(left)} side={left} onOpenTeam={onOpenTeam} />
          <div className="duel-score">
            <span className={`num${leading(left, right) ? " up" : ""}`}>{formatPoints(left.points)}</span>
            <span className="quiet">Week {snapshot.week}</span>
            <span className={`num${right && leading(right, left) ? " up" : ""}`}>
              {right ? formatPoints(right.points) : "–"}
            </span>
          </div>
          {right ? <TeamHead team={team(right)} side={right} onOpenTeam={onOpenTeam} /> : <div className="duel-team" />}
        </div>
        <p className="quiet duel-note">
          Starters still to score: {waiting(left)} for {team(left)?.teamName ?? "the first team"}
          {right ? `, ${waiting(right)} for ${team(right)?.teamName ?? "the second team"}` : ""}.
        </p>

        {[
          { title: "Starters", rows: starters },
          { title: "Bench", rows: bench },
        ]
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <div key={group.title}>
              <h3 className="panel-heading">{group.title}</h3>
              <ul className="duel-rows">
                {group.rows.map((row, index) => (
                  <li key={index} className="duel-row">
                    <SlotCell entry={row.left} stats={stats} side="left" />
                    <PositionChip label={row.slot} />
                    <SlotCell entry={row.right} stats={stats} side="right" />
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </section>
  );
}
