import type { PlayerGame, PlayerStats } from "../../shared/types.ts";
import { formatGameDate, formatPoints } from "../format.ts";

const WIDTH = 640;
const HEIGHT = 230;
const PAD = { top: 16, right: 16, bottom: 30, left: 40 };
const SEASON_GAMES = 82;

/** Games an NBA team plays in a typical week. */
const GAMES_PER_WEEK = 3.5;

/** An injury absence to show: his team's games he misses, and the day he is expected back (null: the season). */
export interface Absence {
  games: number;
  backLabel: string | null;
}

/** An absence from today to `expected` (YYYY-MM-DD), or for the rest of the season, in his team's games. */
export function absenceFor(stats: PlayerStats, today: string, expected: string | null, backLabel: string | null): Absence {
  const remaining = Math.max(0, SEASON_GAMES - stats.teamGames);
  if (!expected) return { games: remaining, backLabel: null };
  const days = Math.max(0, (Date.parse(`${expected}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return { games: Math.min(remaining, Math.round((days / 7) * GAMES_PER_WEEK)), backLabel };
}

/**
 * A player's game scores so far, then the level he is projected to hold for
 * the games he is expected to play in the rest of the season. An injured
 * player's absence shows first, as a shaded stretch, and the projection
 * starts when he is expected back.
 */
export function ProjectionChart({
  stats,
  games,
  absence = null,
}: {
  stats: PlayerStats;
  /** Null while the game log loads: the chart keeps its size and caption, and the scores fill in. */
  games: PlayerGame[] | null;
  absence?: Absence | null;
}) {
  const loading = games === null || games.length === 0;
  const played = loading ? [] : [...games].reverse(); // oldest first
  const projection = stats.projection;
  const remaining = Math.max(1, SEASON_GAMES - stats.teamGames);
  const missed = absence ? Math.min(remaining, absence.games) : 0;
  const seasonOver = absence !== null && absence.backLabel === null;
  const playRate = absence ? (stats.playRate ?? stats.availability) : stats.availability;
  const ahead = seasonOver ? 0 : Math.max(1, Math.round((remaining - missed) * playRate));
  // While loading, the season so far takes the space his games will.
  const total = (loading ? stats.games : played.length) + missed + ahead;
  const top = Math.max(10, ...played.map((game) => game.fantasyPoints), projection.perGame) * 1.1;

  const x = (index: number) => PAD.left + ((WIDTH - PAD.left - PAD.right) * index) / Math.max(1, total - 1);
  const y = (value: number) => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * value) / top;
  const ticks = [0, top / 3, (2 * top) / 3, top].map((value) => Math.round(value / 5) * 5);
  const shownPlayed = loading ? stats.games : played.length;
  const last = played[played.length - 1];
  const lastX = x(shownPlayed - 1);
  const outX = x(shownPlayed);
  const startX = x(shownPlayed + missed);
  const endX = x(total - 1);
  const tone = projection.trend === "rising" ? "up" : projection.trend === "fading" ? "down" : "flat";
  const trendWord = { rising: "rising", fading: "fading", steady: "holding steady" }[projection.trend];

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">Game scores and rest-of-season projection</title>
        <desc id="chart-desc">
          {played.length} games played, averaging {formatPoints(stats.fantasyAvg)}.{" "}
          {seasonOver
            ? "Out for the rest of the season."
            : `${absence ? `Out for about ${missed} games, then projected` : "Projected"} ${formatPoints(projection.perGame)} a game over about ${ahead} more games.`}
        </desc>

        {[...new Set(ticks)].map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="chart-label" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {tick}
            </text>
          </g>
        ))}
        {played[0] && last ? (
          <>
            <text className="chart-label" x={PAD.left} y={HEIGHT - 8}>
              {formatGameDate(played[0].date)}
            </text>
            <text className="chart-label" x={lastX} y={HEIGHT - 8} textAnchor="middle">
              {formatGameDate(last.date)}
            </text>
          </>
        ) : (
          <text className="chart-label" x={(PAD.left + lastX) / 2} y={y(top / 2)} textAnchor="middle">
            Loading games…
          </text>
        )}
        <text className="chart-label" x={endX} y={HEIGHT - 8} textAnchor="end">
          Season end
        </text>

        {/* What he has done */}
        <polyline
          className="chart-line"
          points={played.map((game, index) => `${x(index)},${y(game.fantasyPoints)}`).join(" ")}
        />
        {/* An injury absence: the games he is expected to miss */}
        {absence && missed > 0 && (
          <g>
            <rect
              className="chart-out"
              x={outX}
              y={PAD.top}
              width={Math.max(2, (seasonOver ? endX : startX) - outX)}
              height={HEIGHT - PAD.top - PAD.bottom}
            />
            <text className="chart-label chart-out-label" x={outX + 6} y={PAD.top + 14}>
              {seasonOver ? "Out for the season" : `Out, back about ${absence.backLabel}`}
            </text>
          </g>
        )}
        {!seasonOver && (
          <>
            {/* The step from the last game to the projected level (not across an absence) */}
            {missed === 0 && last && (
              <line className="chart-bridge" x1={lastX} y1={y(last.fantasyPoints)} x2={startX} y2={y(projection.perGame)} />
            )}
            {/* The projected level */}
            <line className={`chart-projection ${tone}`} x1={startX} y1={y(projection.perGame)} x2={endX} y2={y(projection.perGame)} />
            <text className="chart-value" x={endX} y={y(projection.perGame) - 8} textAnchor="end">
              Projected {formatPoints(projection.perGame)}
            </text>
          </>
        )}

        {played.map((game, index) => (
          <circle key={game.date} className="chart-dot" cx={x(index)} cy={y(game.fantasyPoints)} r={4}>
            <title>
              {formatGameDate(game.date)}
              {game.opponent ? ` ${game.home === false ? "at" : "vs"} ${game.opponent}` : ""}: {formatPoints(game.fantasyPoints)}
            </title>
          </circle>
        ))}
      </svg>
      <figcaption className="quiet">
        <span className="key key-line" /> Game scores
        {absence && missed > 0 && (
          <>
            <span className="key key-out" /> {seasonOver ? "Out for the season" : `Out for about ${missed} games`}
          </>
        )}
        {!seasonOver && (
          <>
            <span className={`key key-projection ${tone}`} /> Projection, {trendWord}: {formatPoints(projection.perGame)} a
            game over about {ahead} more games{absence && missed > 0 ? " once back" : ""} (season average{" "}
            {formatPoints(stats.fantasyAvg)}).
          </>
        )}
      </figcaption>
    </figure>
  );
}
