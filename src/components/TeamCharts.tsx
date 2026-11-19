import { useEffect, useMemo, useRef, useState } from "react";
import { formatPoints, ordinal } from "../format.ts";
import type { StrengthModel, TeamStrength } from "../../shared/strength.ts";
import { extremes, leagueProfiles, type ProfileAxis, type TeamProfile, type WeekPoint, weekHighlights } from "../../shared/teamProfile.ts";
import type { LeagueSnapshot, PlayerStats } from "../../shared/types.ts";

// Three views of the team against the league, above the roster on My team:
// its shape (how it scores), its scoring mix and its weeks ahead. Each card
// says in one line what stands out; hovering or tapping a part of a chart
// gives that part's figure and rank. On a phone the cards slide sideways.

const profilesByModel = new WeakMap<StrengthModel, Map<number, TeamProfile>>();

function useProfiles(
  snapshot: LeagueSnapshot,
  model: StrengthModel | null,
  strengths: TeamStrength[] | null,
  stats: Record<string, PlayerStats>,
) {
  return useMemo(() => {
    if (!model || !strengths) return null;
    let profiles = profilesByModel.get(model);
    if (!profiles) {
      profiles = leagueProfiles(snapshot, model, strengths, stats);
      profilesByModel.set(model, profiles);
    }
    return profiles;
  }, [snapshot, model, strengths, stats]);
}

/** What a shape axis's figure means, short enough to fit the note under the chart. */
function shapeNote(axis: ProfileAxis): string {
  switch (axis.key) {
    case "ceiling":
      return `${formatPoints(axis.value)} in a good week (better than 9 in 10)`;
    case "floor":
      return `${formatPoints(axis.value)} in a bad week (worse than 9 in 10)`;
    case "stars":
      return `${formatPoints(axis.value)} a week from your best three`;
    case "depth":
      return `${formatPoints(axis.value)} a week added by the bench`;
    case "games":
      return `${axis.value.toFixed(1)} games a week per main player`;
    case "health":
      return `${axis.value.toFixed(0)}% of your top ten on hand, next four weeks`;
    case "trend":
      return `${axis.value >= 0 ? "+" : "−"}${Math.abs(axis.value).toFixed(1)}%, projections against averages`;
    default:
      return formatPoints(axis.value);
  }
}

export function TeamCharts({
  snapshot,
  model,
  strengths,
  stats,
  rosterId,
}: {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  strengths: TeamStrength[] | null;
  stats: Record<string, PlayerStats>;
  rosterId: number;
}) {
  const profiles = useProfiles(snapshot, model, strengths, stats);
  const profile = profiles?.get(rosterId);
  const teams = snapshot.teams.length;
  const scroller = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      const card = element.firstElementChild as HTMLElement | null;
      if (!card) return;
      setPage(Math.round(element.scrollLeft / (card.offsetWidth + 12)));
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [profile]);

  if (!profile) return null;
  const shape = extremes(profile.shape);
  const mix = extremes(profile.mix);
  const weeks = weekHighlights(profile.weeks);

  return (
    <div className="team-charts-wrap">
      <div className="team-charts" ref={scroller}>
        <ChartCard
          title="Team shape"
          legend={RADAR_LEGEND}
          summary={
            shape
              ? `Strongest at ${shape.best.label.toLowerCase()} (${ordinal(shape.best.rank)} of ${teams}); weakest at ${shape.worst.label.toLowerCase()} (${ordinal(shape.worst.rank)}).`
              : ""
          }
        >
          {(onFocus) => (
            <Radar
              axes={profile.shape}
              onFocus={(axis) =>
                onFocus(axis && `${axis.label}: ${shapeNote(axis)}. ${ordinal(axis.rank)} of ${teams}.`)
              }
            />
          )}
        </ChartCard>
        <ChartCard
          title="Scoring mix"
          legend={RADAR_LEGEND}
          summary={
            mix
              ? `Most from ${mix.best.label.toLowerCase()} (${ordinal(mix.best.rank)} of ${teams}), least from ${mix.worst.label.toLowerCase()} (${ordinal(mix.worst.rank)}).${
                  profile.mistakes
                    ? ` Turnovers and fouls cost ${formatPoints(profile.mistakes.value)} a game (${ordinal(profile.mistakes.rank)} fewest).`
                    : ""
                }`
              : "Shows once the stats have been updated."
          }
        >
          {(onFocus) =>
            profile.mix.length > 0 ? (
              <Radar
                axes={profile.mix}
                onFocus={(axis) =>
                  onFocus(axis && `${axis.label}: ${formatPoints(axis.value)} a game from your main players. ${ordinal(axis.rank)} of ${teams}.`)
                }
              />
            ) : (
              <div className="team-chart-empty" />
            )
          }
        </ChartCard>
        <ChartCard
          title="Week by week"
          legend={WEEK_LEGEND}
          summary={
            weeks
              ? `Best stretch: ${weekSpan(weeks.best)}. Toughest: week ${weeks.worst.week} (${ordinal(weeks.worst.rank)} of ${teams}).`
              : ""
          }
        >
          {(onFocus) => (
            <WeekChart
              weeks={profile.weeks}
              onFocus={(point) =>
                onFocus(
                  point &&
                    `Week ${point.week}: ${formatPoints(point.team)}, ${ordinal(point.rank)} of ${teams}. League average ${formatPoints(point.leagueAverage)}.`,
                )
              }
            />
          )}
        </ChartCard>
      </div>
      <div className="team-charts-dots" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span key={index} className={index === page ? "is-current" : ""} />
        ))}
      </div>
    </div>
  );
}

function weekSpan(points: WeekPoint[]): string {
  if (points.length === 1) return `week ${points[0]!.week}`;
  return `weeks ${points[0]!.week} to ${points[points.length - 1]!.week}`;
}

type LegendKind = "team" | "league" | "range";
const RADAR_LEGEND: [string, LegendKind][] = [
  ["You", "team"],
  ["League average", "league"],
];
const WEEK_LEGEND: [string, LegendKind][] = [
  ["You", "team"],
  ["League average", "league"],
  ["League range", "range"],
];

function ChartCard({
  title,
  summary,
  legend,
  children,
}: {
  title: string;
  summary: string;
  legend: [string, LegendKind][];
  children: (onFocus: (text: string | null) => void) => React.ReactNode;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  return (
    <figure className="card team-chart">
      <div className="team-chart-head">
        <figcaption className="team-chart-title">{title}</figcaption>
        <ul className="team-chart-legend">
          {legend.map(([label, kind]) => (
            <li key={label}>
              <span className={`team-chart-key key-${kind}`} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>
      <div className="team-chart-plot">{children(setFocus)}</div>
      <p className={`team-chart-note${focus ? " is-focus" : ""}`} aria-live="polite">
        {focus ?? summary}
      </p>
    </figure>
  );
}

// ---- Radar ----

const R = 86;
const CX = 150;
const CY = 118;

function point(index: number, count: number, value: number): [number, number] {
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  const radius = (R * Math.max(0, Math.min(10, value))) / 10;
  return [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)];
}

/**
 * Pointer handling for a part of a chart: a mouse picks it on the way in (and the chart lets go
 * on the way out); a tap picks it, and a tap on the chart's empty space lets go. A tap also sends
 * mouse events, so only a real mouse may pick on entering, or the tap would undo itself.
 */
function pointing(index: number, pick: (index: number | null) => void) {
  return {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") pick(index);
    },
    onClick: () => pick(index),
  };
}

/** Where an axis label sits, and which way it runs from there. */
function labelAt(index: number, count: number): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  const [x, y] = point(index, count, 12.2);
  const anchor = Math.abs(x - CX) < 8 ? "middle" : x > CX ? "start" : "end";
  return { x: x + (anchor === "start" ? 5 : anchor === "end" ? -5 : 0), y, anchor };
}

/** A box around an axis label, a little larger than the text (11px labels are about 6.4px a letter). */
function labelBox(label: string, index: number, count: number) {
  const { x, y, anchor } = labelAt(index, count);
  const width = label.length * 6.4 + 16;
  const left = anchor === "start" ? x - 8 : anchor === "end" ? x - width + 8 : x - width / 2;
  return { x: left, y: y - 10, width, height: 22 };
}

const path = (points: [number, number][]) => points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("") + "Z";

function Radar({ axes, onFocus }: { axes: ProfileAxis[]; onFocus: (axis: ProfileAxis | null) => void }) {
  const [active, setActive] = useState<number | null>(null);
  const count = axes.length;
  const pick = (index: number | null) => {
    setActive(index);
    onFocus(index === null ? null : axes[index]!);
  };
  const team = axes.map((axis, index) => point(index, count, axis.scaled));
  const league = axes.map((axis, index) => point(index, count, axis.league));
  return (
    <svg className="radar" viewBox="-30 0 360 236" role="img" aria-label={axes.map((axis) => `${axis.label} ${axis.rank} of the league`).join(", ")} onPointerLeave={(event) => event.pointerType === "mouse" && pick(null)} onClick={(event) => event.target === event.currentTarget && pick(null)}>
      {[2.5, 5, 7.5, 10].map((ring) => (
        <path key={ring} className="radar-ring" d={path(axes.map((_, index) => point(index, count, ring)))} />
      ))}
      {axes.map((axis, index) => {
        const [x, y] = point(index, count, 10);
        return <line key={axis.key} className="radar-spoke" x1={CX} y1={CY} x2={x} y2={y} />;
      })}
      <path className="radar-league" d={path(league)} />
      <g className="radar-team">
        <path className="radar-team-area" d={path(team)} />
        {team.map(([x, y], index) => (
          <circle key={axes[index]!.key} className={`radar-dot${active === index ? " is-active" : ""}`} cx={x} cy={y} r={active === index ? 5 : 3.5} />
        ))}
      </g>
      {axes.map((axis, index) => {
        const { x, y, anchor } = labelAt(index, count);
        return (
          <text key={axis.key} className={`radar-label${active === index ? " is-active" : ""}`} x={x} y={y + 4} textAnchor={anchor}>
            {axis.label}
          </text>
        );
      })}
      {/* Each axis catches the pointer over a triangle from the middle out past its dot to the
          outer ring, and over a box around its label (drawn last, so a label always picks its own axis). */}
      {axes.map((axis, index) => {
        const half = Math.PI / count;
        const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
        const reach = R + 12;
        const a = [CX + reach * Math.cos(angle - half), CY + reach * Math.sin(angle - half)];
        const b = [CX + reach * Math.cos(angle + half), CY + reach * Math.sin(angle + half)];
        return (
          <path
            key={axis.key}
            className="chart-hit"
            d={`M${CX},${CY}L${a[0]!.toFixed(1)},${a[1]!.toFixed(1)}L${b[0]!.toFixed(1)},${b[1]!.toFixed(1)}Z`}
            {...pointing(index, pick)}
          />
        );
      })}
      {axes.map((axis, index) => {
        const box = labelBox(axis.label, index, count);
        return (
          <rect
            key={axis.key}
            className="chart-hit"
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={4}
            {...pointing(index, pick)}
          />
        );
      })}
    </svg>
  );
}

// ---- Week by week ----

const W = { left: 36, right: 8, top: 10, bottom: 24, width: 300, height: 236 };

function niceTicks(low: number, high: number): number[] {
  const step = [10, 20, 25, 50, 100].find((size) => (high - low) / size <= 4) ?? 200;
  const ticks: number[] = [];
  for (let tick = Math.ceil(low / step) * step; tick <= high; tick += step) ticks.push(tick);
  return ticks;
}

function WeekChart({ weeks, onFocus }: { weeks: WeekPoint[]; onFocus: (point: WeekPoint | null) => void }) {
  const [active, setActive] = useState<number | null>(null);
  if (weeks.length === 0) return null;
  const low = Math.min(...weeks.map((point) => point.leagueLow));
  const high = Math.max(...weeks.map((point) => point.leagueHigh));
  const pad = (high - low) * 0.08 || 10;
  const [y0, y1] = [low - pad, high + pad];
  const plotWidth = W.width - W.left - W.right;
  const plotHeight = W.height - W.top - W.bottom;
  const x = (index: number) => W.left + (weeks.length === 1 ? plotWidth / 2 : (plotWidth * index) / (weeks.length - 1));
  const y = (value: number) => W.top + plotHeight * (1 - (value - y0) / (y1 - y0));
  const line = (pick: (point: WeekPoint) => number) => weeks.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(pick(point)).toFixed(1)}`).join("");
  const band =
    weeks.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.leagueHigh).toFixed(1)}`).join("") +
    [...weeks].reverse().map((point, index) => `L${x(weeks.length - 1 - index).toFixed(1)},${y(point.leagueLow).toFixed(1)}`).join("") +
    "Z";
  const pick = (index: number | null) => {
    setActive(index);
    onFocus(index === null ? null : weeks[index]!);
  };
  const labelEvery = Math.ceil(weeks.length / 6);
  const slot = plotWidth / Math.max(1, weeks.length - 1);
  return (
    <svg className="week-chart" viewBox={`0 0 ${W.width} ${W.height}`} role="img" aria-label="Projected score each week left, against the league" onPointerLeave={(event) => event.pointerType === "mouse" && pick(null)} onClick={(event) => event.target === event.currentTarget && pick(null)}>
      {niceTicks(y0, y1).map((tick) => (
        <g key={tick}>
          <line className="week-grid" x1={W.left} x2={W.width - W.right} y1={y(tick)} y2={y(tick)} />
          <text className="week-axis" x={W.left - 6} y={y(tick) + 3.5} textAnchor="end">
            {tick}
          </text>
        </g>
      ))}
      <path className="week-band" d={band} />
      <path className="week-league" d={line((point) => point.leagueAverage)} />
      <path className="week-team" d={line((point) => point.team)} />
      {active !== null && <line className="week-guide" x1={x(active)} x2={x(active)} y1={W.top} y2={W.top + plotHeight} />}
      {weeks.map((point, index) => (
        <circle key={point.week} className={`week-dot${active === index ? " is-active" : ""}`} cx={x(index)} cy={y(point.team)} r={active === index ? 5 : 2.5} />
      ))}
      {weeks.map((point, index) =>
        index % labelEvery === 0 || index === weeks.length - 1 ? (
          <text key={point.week} className={`week-axis${active === index ? " is-active" : ""}`} x={x(index)} y={W.height - 6} textAnchor="middle">
            {point.week}
          </text>
        ) : null,
      )}
      {weeks.map((point, index) => (
        <rect
          key={point.week}
          className="chart-hit"
          x={x(index) - slot / 2}
          y={W.top}
          width={slot}
          height={plotHeight}
          {...pointing(index, pick)}
        />
      ))}
    </svg>
  );
}
