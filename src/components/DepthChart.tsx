import { nbaDay } from "../../shared/weeks.ts";
import { useMemo } from "react";
import { depthChart, DEPTH, depthMinutes, minutesTone } from "../../shared/depthChart.ts";
import { newsOutText } from "../../shared/injury.ts";
import type { PlayerStats, StatsReport } from "../../shared/types.ts";
import { formatAverage, toneColor } from "../format.ts";
import { PlayerButton } from "./PlayerName.tsx";
import { PositionChip } from "./PositionChip.tsx";
import { TeamTag } from "./TeamTag.tsx";

const COLUMNS = ["Starter", "2nd", "3rd"];

/** First name above, the rest (the surname, with any suffix) below. */
function splitName(name: string): [string, string] {
  const space = name.indexOf(" ");
  return space < 0 ? ["", name] : [name.slice(0, space), name.slice(space + 1)];
}

function DepthCell({ player, current }: { player: PlayerStats; current: boolean }) {
  const [first, last] = splitName(player.name);
  const recent = player.recentMinutes ?? null;
  const tone = minutesTone(recent, player.minutes);
  const out = newsOutText(player.injury, player.injuryStatus, nbaDay(Date.now()));
  const minutes = depthMinutes(player);
  const label =
    recent != null && recent !== player.minutes
      ? `${formatAverage(recent)} minutes a game over his last games, ${formatAverage(player.minutes)} this season`
      : `${formatAverage(player.minutes)} minutes a game this season`;
  return (
    <PlayerButton player={player} className={`depth-cell${current ? " is-current" : ""}`}>
      <span className="depth-first">
        <span className="depth-first-name">{first}</span>
        <span className="depth-minutes" style={tone === null ? undefined : { color: toneColor(tone) }} title={label}>
          {player.games > 0 ? formatAverage(minutes) : "–"}
        </span>
      </span>
      <span className="depth-last">{last}</span>
      {out && <span className="injury depth-out">{out}</span>}
    </PlayerButton>
  );
}

/**
 * A player's NBA team, position by position, at the bottom of his card: who
 * plays most at each, with minutes a game (his recent games), colored only
 * when they have moved well away from his season's, and how long anyone out
 * is out. Worked out from minutes (shared/depthChart.ts), not an official chart.
 */
export function DepthChart({ team, stats, playerId }: { team: string; stats: StatsReport | null; playerId: string }) {
  const rows = useMemo(() => depthChart(Object.values(stats?.players ?? {}), team), [stats, team]);
  if (rows.every((row) => row.players.length === 0)) return null;
  const window = stats?.recentWindow ?? 5;
  return (
    <section className="depth" aria-label="Depth chart">
      <h3 className="panel-heading depth-heading">
        Depth chart <TeamTag team={team} />
      </h3>
      <div className="depth-grid" role="table" aria-label={`${team} depth chart`}>
        <div className="depth-row depth-head" role="row">
          <span role="columnheader" className="depth-pos">
            Pos
          </span>
          {COLUMNS.map((column) => (
            <span key={column} role="columnheader">
              {column}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.position} className="depth-row" role="row">
            <span role="rowheader" className="depth-pos">
              <PositionChip label={row.position} />
            </span>
            {Array.from({ length: DEPTH }, (_, index) => {
              const player = row.players[index];
              return (
                <span key={index} role="cell" className="depth-slot">
                  {player && <DepthCell player={player} current={player.id === playerId} />}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className="quiet panel-note">
        Who plays most at each position, by minutes a game over the last {window} games he played. Minutes turn green
        or red when they are well above or below his season's (more than 2.5 minutes and 10%); steady minutes stay
        plain. Worked out from the box scores, not an official depth chart.
      </p>
    </section>
  );
}
