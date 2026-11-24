import { useEffect, useRef, useState } from "react";
import { careerLayout, careerScale, fittingLabels, seasonLabel } from "../../shared/career.ts";
import type { CareerSeason, PlayerCareer } from "../../shared/types.ts";
import { formatAverage, formatPoints } from "../format.ts";
import { TeamTag } from "./TeamTag.tsx";

// The player card's career graph and table: his form across every game of his
// career (shared/career.ts lays it out), each season's average, and the season
// numbers below. Drawn at the card's real width so the axis labels stay
// readable on a phone. Display only.

const HEIGHT = 250;
const PAD = { top: 18, right: 14, bottom: 48, left: 54 };
/** Width drawn before the card has been measured. */
const START_WIDTH = 640;

/** The element's width in pixels, followed as it changes. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(START_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.round(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const count = new Intl.NumberFormat("en-US");

/** "2015-16 season: 52.30 a game over 82 games, with HOU." */
function seasonNote(span: { season: string; games: number; average: number | null }, season: CareerSeason | undefined): string {
  const name = `${seasonLabel(span.season, "full")} season`;
  if (span.average === null) return `${name}: did not play.`;
  const teams = season && season.teams.length > 0 ? `, with ${season.teams.join(" and ")}` : "";
  const sofar = season?.current ? " so far" : "";
  return `${name}: ${formatPoints(span.average)} a game over ${span.games} ${span.games === 1 ? "game" : "games"}${sofar}${teams}.`;
}

export function CareerChart({
  career,
  onPickSeason,
}: {
  /** Null (or "loading") while his career is fetched: the graph keeps its size. */
  career: PlayerCareer | null;
  /** Opens one season's view, from the table. */
  onPickSeason: (season: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | null>(null);
  const ready = career?.status === "ready" ? career : null;
  const layout = careerLayout(ready?.seasons ?? [], ready?.games ?? []);
  const { top, step } = careerScale(ready ? layout.peak : 60);
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (fraction: number) => PAD.left + fraction * plotWidth;
  const y = (value: number) => PAD.top + plotHeight * (1 - value / top);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);

  const spans = layout.spans;
  const roomEach = spans.length > 0 ? plotWidth / spans.length : plotWidth;
  const labelForm = roomEach >= 62 ? "full" : roomEach >= 42 ? "short" : "year";
  const labelGap = { full: 56, short: 42, year: 30 }[labelForm];
  const labelled = fittingLabels(
    spans.map((span) => x((span.from + span.to) / 2)),
    labelGap,
  );
  const seasonOf = new Map((ready?.seasons ?? []).map((season) => [season.season, season]));

  // The form line, broken at a season he did not play.
  const paths: string[] = [];
  let open = "";
  for (const point of layout.line) {
    if (point.value === null) {
      if (open) paths.push(open);
      open = "";
      continue;
    }
    open += `${open ? "L" : "M"}${x(point.x).toFixed(1)},${y(point.value).toFixed(1)}`;
  }
  if (open) paths.push(open);

  const played = (ready?.seasons ?? []).filter((season) => season.games > 0);
  const totalGames = played.reduce((sum, season) => sum + season.games, 0);
  const careerAverage = totalGames > 0 ? (ready?.games ?? []).reduce((sum, game) => sum + game.points, 0) / totalGames : null;
  // His best season, among full enough ones; worth naming only with three or more to choose from.
  const eligible = played.filter((season) => !season.current || season.games >= 20);
  const best =
    eligible.length >= 3
      ? eligible.reduce((found, season) => ((season.fantasyAvg ?? 0) > (found.fantasyAvg ?? 0) ? season : found))
      : null;
  const focus = active !== null && spans[active] ? seasonNote(spans[active]!, seasonOf.get(spans[active]!.season)) : null;
  const summary =
    ready && careerAverage !== null
      ? `${spans.length} ${spans.length === 1 ? "season" : "seasons"}, ${count.format(totalGames)} games, career average ${formatPoints(careerAverage)}.` +
        (best ? ` Best season ${seasonLabel(best.season, "full")} at ${formatPoints(best.fantasyAvg ?? 0)}.` : "") +
        " Tap a season on the graph for its numbers."
      : null;

  return (
    <>
      <figure className="chart career-chart" ref={box}>
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          width={width}
          height={HEIGHT}
          role="img"
          aria-labelledby="career-title career-desc"
          onPointerLeave={(event) => event.pointerType === "mouse" && setActive(null)}
        >
          <title id="career-title">Career form and season averages</title>
          <desc id="career-desc">{summary ?? "Loading his career."}</desc>

          {ticks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="chart-label" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                {tick}
              </text>
            </g>
          ))}
          <text
            className="chart-axis-title"
            x={14}
            y={PAD.top + plotHeight / 2}
            textAnchor="middle"
            transform={`rotate(-90 14 ${PAD.top + plotHeight / 2})`}
          >
            Fantasy points per game
          </text>
          <text className="chart-axis-title" x={PAD.left + plotWidth / 2} y={HEIGHT - 6} textAnchor="middle">
            Season
          </text>

          {!ready && (
            <text className="chart-label" x={PAD.left + plotWidth / 2} y={PAD.top + plotHeight / 2} textAnchor="middle">
              {career?.status === "error" ? "Could not load his career." : "Loading his career…"}
            </text>
          )}

          {active !== null && spans[active] && (
            <rect
              className="career-band"
              x={x(spans[active]!.from)}
              y={PAD.top}
              width={x(spans[active]!.to) - x(spans[active]!.from)}
              height={plotHeight}
            />
          )}

          {spans.map((span, index) => {
            const left = x(span.from);
            const right = x(span.to);
            return (
              <g key={span.season}>
                {index > 0 && <line className="career-divider" x1={left} x2={left} y1={PAD.top} y2={PAD.top + plotHeight} />}
                {span.average === null ? (
                  <>
                    <rect className="chart-out chart-out-past" x={left + 1} y={PAD.top} width={Math.max(1, right - left - 2)} height={plotHeight} />
                    {right - left >= 28 && (
                      <text className="chart-label chart-out-past-label" x={(left + right) / 2} y={PAD.top + plotHeight - 8} textAnchor="middle">
                        Out
                      </text>
                    )}
                  </>
                ) : (
                  <line className="career-average" x1={left + 3} x2={right - 3} y1={y(span.average)} y2={y(span.average)} />
                )}
                {labelled[index] && (
                  <text
                    className={`chart-label career-season${active === index ? " is-active" : ""}`}
                    x={(left + right) / 2}
                    y={PAD.top + plotHeight + 17}
                    textAnchor="middle"
                  >
                    {seasonLabel(span.season, labelForm)}
                  </text>
                )}
              </g>
            );
          })}

          {paths.map((path, index) => (
            <path key={index} className="chart-line career-line" d={path} />
          ))}

          {/* Season averages' values, over the line (with a halo) where the season has room. */}
          {spans.map((span) =>
            span.average !== null && x(span.to) - x(span.from) >= 50 ? (
              <text
                key={span.season}
                className="chart-label career-average-label"
                x={(x(span.from) + x(span.to)) / 2}
                y={y(span.average) - 7}
                textAnchor="middle"
              >
                {formatPoints(span.average)}
              </text>
            ) : null,
          )}

          {spans.map((span, index) => (
            <rect
              key={span.season}
              className="chart-hit"
              x={x(span.from)}
              y={PAD.top}
              width={Math.max(1, x(span.to) - x(span.from))}
              height={plotHeight + 24}
              onPointerEnter={(event) => event.pointerType === "mouse" && setActive(index)}
              onClick={() => setActive(index)}
            >
              <title>{seasonNote(span, seasonOf.get(span.season))}</title>
            </rect>
          ))}
        </svg>
        <figcaption className="quiet career-caption">
          <span className="career-legend">
            <span>
              <span className="key key-line" /> Form, average of {layout.window} games around each
            </span>
            <span>
              <span className="key key-dashed" /> Season average
            </span>
          </span>
          <span className={`career-note${focus ? " is-focus" : ""}`} aria-live="polite">
            {focus ??
              summary ??
              (career?.status === "error"
                ? (career.error ?? "Could not load his career.")
                : "Fetching his earlier seasons. The first look takes a few seconds; it is saved after that.")}
          </span>
        </figcaption>
      </figure>
      <CareerTable career={ready} onPickSeason={onPickSeason} />
    </>
  );
}

/** Each season's numbers, newest first, with the career average below. */
function CareerTable({ career, onPickSeason }: { career: PlayerCareer | null; onPickSeason: (season: string) => void }) {
  const seasons = career ? [...career.seasons].reverse() : null;
  const played = (career?.seasons ?? []).filter((season) => season.games > 0 && season.averages);
  const total = played.reduce((sum, season) => sum + season.games, 0);
  const weighted = (value: (season: CareerSeason) => number) =>
    total > 0 ? played.reduce((sum, season) => sum + value(season) * season.games, 0) / total : 0;
  return (
    <>
      <h3 className="panel-heading">Career by season</h3>
      <div className="table-scroll">
        <table className="players-table log-table career-table">
          <thead>
            <tr>
              <th scope="col">Season</th>
              <th scope="col">Team</th>
              <th scope="col" className="num">GP</th>
              <th scope="col" className="num">Fpts</th>
              <th scope="col" className="num">Min</th>
              <th scope="col" className="num">Pts</th>
              <th scope="col" className="num">Reb</th>
              <th scope="col" className="num">Ast</th>
              <th scope="col" className="num">Stl</th>
              <th scope="col" className="num">Blk</th>
              <th scope="col" className="num">TO</th>
            </tr>
          </thead>
          <tbody>
            {!seasons &&
              Array.from({ length: 4 }, (_, index) => (
                <tr key={`loading-${index}`} className="log-loading" aria-hidden="true">
                  <th scope="row">
                    <span className="skeleton" />
                  </th>
                  <td>
                    <span className="skeleton skeleton-wide" />
                  </td>
                  {Array.from({ length: 9 }, (_, cell) => (
                    <td key={cell} className="num">
                      <span className="skeleton" />
                    </td>
                  ))}
                </tr>
              ))}
            {seasons?.map((season) => (
              <tr key={season.season} className={season.games === 0 ? "log-out" : undefined}>
                <th scope="row">
                  <button type="button" className="link-button career-open" onClick={() => onPickSeason(season.season)}>
                    {seasonLabel(season.season, "full")}
                  </button>
                  {season.current && <span className="quiet career-sofar"> so far</span>}
                </th>
                <td className="career-teams">
                  {season.teams.length > 0 ? season.teams.map((team) => <TeamTag key={team} team={team} />) : "–"}
                </td>
                {season.games === 0 || !season.averages ? (
                  <>
                    <td className="num">0</td>
                    <td className="num log-fpts log-out-tag">Out</td>
                    <td colSpan={7} />
                  </>
                ) : (
                  <>
                    <td className="num">{season.games}</td>
                    <td className="num strong log-fpts">{formatPoints(season.fantasyAvg ?? 0)}</td>
                    <td className="num">{formatAverage(season.minutes ?? 0)}</td>
                    <td className="num">{formatAverage(season.averages.pts)}</td>
                    <td className="num">{formatAverage(season.averages.reb)}</td>
                    <td className="num">{formatAverage(season.averages.ast)}</td>
                    <td className="num">{formatAverage(season.averages.stl)}</td>
                    <td className="num">{formatAverage(season.averages.blk)}</td>
                    <td className="num">{formatAverage(season.averages.tov)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {total > 0 && (
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Career average
                </th>
                <td className="num">{count.format(total)}</td>
                <td className="num strong">{formatPoints(weighted((season) => season.fantasyAvg ?? 0))}</td>
                <td className="num">{formatAverage(weighted((season) => season.minutes ?? 0))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.pts))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.reb))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.ast))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.stl))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.blk))}</td>
                <td className="num">{formatAverage(weighted((season) => season.averages!.tov))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}
