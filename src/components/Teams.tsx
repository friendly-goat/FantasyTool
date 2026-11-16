import type { LeagueSnapshot, PlayerRef } from "../../shared/types.ts";
import { formatPoints, formatRecord } from "../format.ts";

interface Props {
  snapshot: LeagueSnapshot;
  selectedRosterId: number | null;
  onSelect: (rosterId: number) => void;
}

function PlayerLine({ slot, player }: { slot?: string; player: PlayerRef | null }) {
  return (
    <li className="player">
      {slot && <span className="slot">{slot}</span>}
      {player ? (
        <>
          <span className="player-name">{player.name}</span>
          {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
          <span className="quiet player-meta">
            {[player.team ?? "Free agent", player.positions.join("/")].filter(Boolean).join(", ")}
          </span>
        </>
      ) : (
        <span className="quiet">Empty slot</span>
      )}
    </li>
  );
}

export function Teams({ snapshot, selectedRosterId, onSelect }: Props) {
  const team =
    snapshot.teams.find((candidate) => candidate.rosterId === selectedRosterId) ?? snapshot.teams[0];
  if (!team) return <p className="quiet">This league has no teams yet.</p>;

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
              <span className="num rail-rank">{candidate.rank}</span>
              {candidate.teamName}
            </button>
          </li>
        ))}
      </ul>

      <div className="roster">
        <h2 className="team-title">{team.teamName}</h2>
        <p className="quiet">
          {team.managerName}, {formatRecord(team.wins, team.losses, team.ties)}, {formatPoints(team.pointsFor)}{" "}
          points scored
        </p>

        <h3>Starters</h3>
        <ul className="players">
          {team.starters.map((starter, index) => (
            <PlayerLine key={index} slot={starter.slot} player={starter.player} />
          ))}
        </ul>

        <h3>Bench</h3>
        {team.bench.length > 0 ? (
          <ul className="players">
            {team.bench.map((player) => (
              <PlayerLine key={player.id} player={player} />
            ))}
          </ul>
        ) : (
          <p className="quiet">No bench players.</p>
        )}

        {team.reserve.length > 0 && (
          <>
            <h3>Injured reserve</h3>
            <ul className="players">
              {team.reserve.map((player) => (
                <PlayerLine key={player.id} player={player} />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
