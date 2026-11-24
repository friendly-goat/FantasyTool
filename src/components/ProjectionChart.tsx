import type { MissedGame, PlayerGame, PlayerStats } from "../../shared/types.ts";
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

/** Missed games in a row it takes to show a past absence on the chart: more than 4. */
export const PAST_ABSENCE_GAMES = 5;

/** One place on the chart's timeline, oldest first: a game he played, or a game he missed. */
type Slot = { kind: "game"; game: PlayerGame } | { kind: "out"; date: string };

/** A stretch of missed games shown as a band: its first and last slot, and its dates. */
interface Band {
  from: number;
  to: number;
  first: string;
  last: string;
}

/**
 * His games and missed games in order. Only stretches of PAST_ABSENCE_GAMES or more take room on
 * the chart (a game or two of rest stays out of it); missed games after his last game take room
 * when he is out now (they start the current absence) or when they are such a stretch.
 */
export function timeline(played: PlayerGame[], missed: MissedGame[], outNow: boolean): { slots: Slot[]; trailing: number } {
  const all: Slot[] = [
    ...played.map((game) => ({ kind: "game" as const, game, date: game.date })),
    ...missed.map((game) => ({ kind: "out" as const, date: game.date })),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((entry) => (entry.kind === "game" ? { kind: "game" as const, game: entry.game } : { kind: "out" as const, date: entry.date }));
  const slots: Slot[] = [];
  let run: Slot[] = [];
  for (const slot of all) {
    if (slot.kind === "out") {
      run.push(slot);
      continue;
    }
    if (run.length >= PAST_ABSENCE_GAMES) slots.push(...run);
    run = [];
    slots.push(slot);
  }
  // Games missed since his last game: part of the current absence, or a stretch of their own.
  const trailing = outNow || run.length >= PAST_ABSENCE_GAMES ? run.length : 0;
  slots.push(...run.slice(0, trailing));
  return { slots, trailing: outNow ? trailing : 0 };
}

/** The stretches of missed games in the slots (the current absence's games included, last). */
function bandsOf(slots: Slot[]): Band[] {
  const bands: Band[] = [];
  slots.forEach((slot, index) => {
    if (slot.kind !== "out") return;
    const open = bands.at(-1);
    if (open && open.to === index - 1) {
      open.to = index;
      open.last = slot.date;
    } else bands.push({ from: index, to: index, first: slot.date, last: slot.date });
  });
  return bands;
}

/**
 * A player's game scores so far, then the level he is projected to hold for
 * the games he is expected to play in the rest of the season. Absences of
 * five games or more show as shaded stretches where they happened; an injured
 * player's current absence shows after his last game, and the projection
 * starts when he is expected back.
 */
export function ProjectionChart({
  stats,
  games,
  missedGames = null,
  absence = null,
}: {
  stats: PlayerStats;
  /** Null while the game log loads: the chart keeps its size and caption, and the scores fill in. */
  games: PlayerGame[] | null;
  /** His team's games he missed, newest first; null while loading or from an older server. */
  missedGames?: MissedGame[] | null;
  absence?: Absence | null;
}) {
  const loading = games === null || games.length === 0;
  const played = loading ? [] : [...games].reverse(); // oldest first
  const { slots, trailing } = timeline(played, loading ? [] : (missedGames ?? []), absence !== null);
  const bands = bandsOf(slots);
  const pastBands = trailing > 0 ? bands.slice(0, -1) : bands;
  const projection = stats.projection;
  const remaining = Math.max(1, SEASON_GAMES - stats.teamGames);
  const missed = absence ? Math.min(remaining, absence.games) : 0;
  const seasonOver = absence !== null && absence.backLabel === null;
  const playRate = absence ? (stats.playRate ?? stats.availability) : stats.availability;
  const ahead = seasonOver ? 0 : Math.max(1, Math.round((remaining - missed) * playRate));
  // While loading, the season so far takes the space his games will.
  const shownPlayed = loading ? stats.games : slots.length;
  const total = shownPlayed + missed + ahead;
  const top = Math.max(10, ...played.map((game) => game.fantasyPoints), projection.perGame) * 1.1;

  const x = (index: number) => PAD.left + ((WIDTH - PAD.left - PAD.right) * index) / Math.max(1, total - 1);
  const y = (value: number) => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * value) / top;
  const step = x(1) - x(0);
  const ticks = [0, top / 3, (2 * top) / 3, top].map((value) => Math.round(value / 5) * 5);
  const last = played[played.length - 1];
  const lastIndex = slots.reduce((found, slot, index) => (slot.kind === "game" ? index : found), -1);
  const lastX = x(loading ? shownPlayed - 1 : lastIndex);
  const firstX = x(Math.max(0, slots.findIndex((slot) => slot.kind === "game")));
  // The current absence starts at his first game missed since his last game, or right after it.
  const outX = trailing > 0 ? x(shownPlayed - trailing) - step / 2 : x(shownPlayed);
  const startX = x(shownPlayed + missed);
  const endX = x(total - 1);
  const tone = projection.trend === "rising" ? "up" : projection.trend === "fading" ? "down" : "flat";
  const trendWord = { rising: "rising", fading: "fading", steady: "holding steady" }[projection.trend];
  const outNowGames = missed + trailing;

  // The line, broken at each absence: runs of games he played in a row.
  const runs: { index: number; game: PlayerGame }[][] = [];
  slots.forEach((slot, index) => {
    if (slot.kind !== "game") return;
    const open = runs.at(-1);
    const previous = open?.at(-1);
    if (open && previous && previous.index === index - 1) open.push({ index, game: slot.game });
    else runs.push([{ index, game: slot.game }]);
  });
  const missedTotal = pastBands.reduce((sum, band) => sum + band.to - band.from + 1, 0);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-labelledby="chart-title chart-desc">
        <title id="chart-title">Game scores and rest-of-season projection</title>
        <desc id="chart-desc">
          {played.length} games played, averaging {formatPoints(stats.fantasyAvg)}.{" "}
          {pastBands.length > 0 &&
            `Missed ${pastBands.map((band) => `${band.to - band.from + 1} games from ${formatGameDate(band.first)}`).join(", ")}. `}
          {seasonOver
            ? "Out for the rest of the season."
            : `${absence ? `Out for about ${outNowGames} games, then projected` : "Projected"} ${formatPoints(projection.perGame)} a game over about ${ahead} more games.`}
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
            <text className="chart-label" x={firstX} y={HEIGHT - 8}>
              {formatGameDate(played[0].date)}
            </text>
            {/* The last game's date, unless it would run into the first's. */}
            {lastX - firstX >= 70 && (
              <text className="chart-label" x={lastX} y={HEIGHT - 8} textAnchor="middle">
                {formatGameDate(last.date)}
              </text>
            )}
          </>
        ) : (
          <text className="chart-label" x={(PAD.left + lastX) / 2} y={y(top / 2)} textAnchor="middle">
            Loading games…
          </text>
        )}
        <text className="chart-label" x={endX} y={HEIGHT - 8} textAnchor="end">
          Season end
        </text>

        {/* Earlier absences: five games or more missed in a row */}
        {pastBands.map((band) => {
          const games = band.to - band.from + 1;
          const left = x(band.from) - step / 2;
          const width = Math.max(2, x(band.to) - x(band.from) + step);
          const label = width >= 74 ? `Out ${games} games` : width >= 38 ? `Out ${games}` : width >= 14 ? String(games) : null;
          return (
            <g key={band.first}>
              <rect className="chart-out chart-out-past" x={left} y={PAD.top} width={width} height={HEIGHT - PAD.top - PAD.bottom}>
                <title>
                  Out {games} games, {formatGameDate(band.first)} to {formatGameDate(band.last)}
                </title>
              </rect>
              {label && (
                <text className="chart-label chart-out-past-label" x={left + width / 2} y={HEIGHT - PAD.bottom - 8} textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          );
        })}

        {/* What he has done, broken at each absence */}
        {runs.map((run) => (
          <polyline key={run[0]!.index} className="chart-line" points={run.map(({ index, game }) => `${x(index)},${y(game.fantasyPoints)}`).join(" ")} />
        ))}
        {/* The current absence: games missed since his last game and the games he is expected to miss */}
        {absence && outNowGames > 0 && (
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
            {outNowGames === 0 && last && lastIndex === slots.length - 1 && (
              <line className="chart-bridge" x1={lastX} y1={y(last.fantasyPoints)} x2={startX} y2={y(projection.perGame)} />
            )}
            {/* The projected level */}
            <line className={`chart-projection ${tone}`} x1={startX} y1={y(projection.perGame)} x2={endX} y2={y(projection.perGame)} />
            <text className="chart-value" x={endX} y={y(projection.perGame) - 8} textAnchor="end">
              Projected {formatPoints(projection.perGame)}
            </text>
          </>
        )}

        {runs.flat().map(({ index, game }) => (
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
        {pastBands.length > 0 && (
          <>
            <span className="key key-out key-out-past" /> Missed {missedTotal} games
            {pastBands.length > 1 ? ` in ${pastBands.length} stretches` : ""}
          </>
        )}
        {absence && outNowGames > 0 && (
          <>
            <span className="key key-out" /> {seasonOver ? "Out for the season" : `Out for about ${outNowGames} games`}
          </>
        )}
        {!seasonOver && (
          <>
            <span className={`key key-projection ${tone}`} /> Projection, {trendWord}: {formatPoints(projection.perGame)} a
            game over about {ahead} more games{absence && outNowGames > 0 ? " once back" : ""} (season average{" "}
            {formatPoints(stats.fantasyAvg)}).
          </>
        )}
      </figcaption>
    </figure>
  );
}
