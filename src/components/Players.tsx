import { useMemo, useState } from "react";
import type { LeagueSnapshot, PlayerStats, StatsReport } from "../../shared/types.ts";
import { formatAverage, formatPoints } from "../format.ts";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChip } from "./PositionChip.tsx";

type Availability = "all" | "free" | "rostered";

interface Column {
  key: string;
  label: string;
  /** Longer name, read by screen readers and shown on hover. */
  title: string;
  value: (player: PlayerStats) => number;
}

const COLUMNS: Column[] = [
  { key: "avg", label: "Fantasy avg", title: "Fantasy points per game this season", value: (p) => p.fantasyAvg },
  { key: "projected", label: "Projected", title: "Projected fantasy points per game for the rest of the season", value: (p) => p.projection.perGame },
  { key: "recent", label: "Last 5", title: "Fantasy points per game over the most recent games", value: (p) => p.recentAvg ?? 0 },
  { key: "games", label: "Games", title: "Games played", value: (p) => p.games },
  { key: "min", label: "Min", title: "Minutes per game", value: (p) => p.minutes },
  { key: "pts", label: "Pts", title: "Points per game", value: (p) => p.averages.pts },
  { key: "reb", label: "Reb", title: "Rebounds per game", value: (p) => p.averages.reb },
  { key: "ast", label: "Ast", title: "Assists per game", value: (p) => p.averages.ast },
  { key: "stl", label: "Stl", title: "Steals per game", value: (p) => p.averages.stl },
  { key: "blk", label: "Blk", title: "Blocks per game", value: (p) => p.averages.blk },
  { key: "tov", label: "TO", title: "Turnovers per game", value: (p) => p.averages.tov },
];

const POSITIONS = ["PG", "SG", "SF", "PF", "C"];
const PAGE_SIZE = 100;
/** A recent average this far from the season average is marked as a trend. */
const TREND_THRESHOLD = 0.15;

function trend(player: PlayerStats): "up" | "down" | null {
  if (player.recentAvg == null || player.fantasyAvg <= 0 || player.games <= player.recentGames) return null;
  const change = (player.recentAvg - player.fantasyAvg) / player.fantasyAvg;
  if (change >= TREND_THRESHOLD) return "up";
  if (change <= -TREND_THRESHOLD) return "down";
  return null;
}

export function Players({ snapshot, stats }: { snapshot: LeagueSnapshot; stats: StatsReport | null }) {
  const [availability, setAvailability] = useState<Availability>("free");
  const [position, setPosition] = useState("all");
  const [sortKey, setSortKey] = useState("avg");
  const [descending, setDescending] = useState(true);

  // Which fantasy team has each player.
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const team of snapshot.teams) {
      const players = [
        ...team.starters.flatMap((starter) => (starter.player ? [starter.player] : [])),
        ...team.bench,
        ...team.reserve,
      ];
      for (const player of players) map.set(player.id, team.teamName);
    }
    return map;
  }, [snapshot]);

  const rows = useMemo(() => {
    const column = COLUMNS.find((candidate) => candidate.key === sortKey) ?? COLUMNS[0]!;
    return Object.values(stats?.players ?? {})
      .filter((player) => {
        const rostered = owners.has(player.id);
        if (availability === "free" && rostered) return false;
        if (availability === "rostered" && !rostered) return false;
        return position === "all" || player.positions.includes(position);
      })
      .sort((a, b) => (descending ? column.value(b) - column.value(a) : column.value(a) - column.value(b)));
  }, [stats, owners, availability, position, sortKey, descending]);

  if (!stats || Object.keys(stats.players).length === 0) {
    return stats?.status === "syncing" || !stats ? (
      <p className="quiet">Players appear here once game stats have downloaded.</p>
    ) : null;
  }

  function sortBy(key: string) {
    if (key === sortKey) setDescending(!descending);
    else {
      setSortKey(key);
      setDescending(true);
    }
  }

  const visible = rows.slice(0, PAGE_SIZE);
  const recentLabel = `Last ${stats.recentWindow}`;

  return (
    <section aria-label="Players">
      <div className="filters">
        <label>
          Show
          <select value={availability} onChange={(event) => setAvailability(event.target.value as Availability)}>
            <option value="free">Free agents</option>
            <option value="rostered">Players on a team</option>
            <option value="all">All players</option>
          </select>
        </label>
        <label>
          Position
          <select value={position} onChange={(event) => setPosition(event.target.value)}>
            <option value="all">All positions</option>
            {POSITIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span className="quiet">
          {rows.length > PAGE_SIZE ? `Top ${PAGE_SIZE} of ${rows.length} players` : `${rows.length} players`}
        </span>
      </div>

      <div className="table-scroll">
        <table className="players-table">
          <thead>
            <tr>
              <th scope="col">Player</th>
              {availability !== "free" && <th scope="col">Fantasy team</th>}
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="num"
                  aria-sort={sortKey === column.key ? (descending ? "descending" : "ascending") : undefined}
                >
                  <button type="button" className="sort-button" title={column.title} onClick={() => sortBy(column.key)}>
                    {column.key === "recent" ? recentLabel : column.label}
                    {sortKey === column.key && <span aria-hidden="true">{descending ? " ▼" : " ▲"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((player) => {
              const direction = trend(player);
              return (
                <tr key={player.id}>
                  <th scope="row">
                    <span className="player-name">
                      <PlayerName player={player} />
                    </span>
                    {player.injuryStatus && <span className="injury">{player.injuryStatus}</span>}
                    <span className="player-tags">
                      {player.positions.map((name) => (
                        <PositionChip key={name} label={name} />
                      ))}
                      <span className="quiet">{player.team ?? "No NBA team"}</span>
                    </span>
                  </th>
                  {availability !== "free" && (
                    <td className={owners.has(player.id) ? "" : "quiet-cell"}>
                      {owners.get(player.id) ?? "Free agent"}
                    </td>
                  )}
                  {COLUMNS.map((column) => (
                    <td
                      key={column.key}
                      className={`num${column.key === "avg" ? " strong" : ""}${
                        column.key === "recent" && direction ? ` ${direction}` : ""
                      }`}
                    >
                      {column.key === "recent" && direction && (
                        <span title={direction === "up" ? "Trending up" : "Trending down"}>
                          {direction === "up" ? "▲ " : "▼ "}
                        </span>
                      )}
                      {column.key === "games"
                        ? player.games
                        : column.key === "recent" && player.recentAvg == null
                          ? "–"
                          : column.key === "avg" || column.key === "recent" || column.key === "projected"
                            ? formatPoints(column.value(player))
                            : formatAverage(column.value(player))}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && <p className="quiet legend">No players match these filters.</p>}
    </section>
  );
}
