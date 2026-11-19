import { useEffect, useRef, useState } from "react";
import { getHistory, getScheduleAhead } from "../api.ts";
import { formatPoints, ordinal } from "../format.ts";
import type { StrengthModel, TeamStrength } from "../../shared/strength.ts";
import { extremes, leagueProfiles, type ProfileAxis, type TeamProfile, type WeekPoint } from "../../shared/teamProfile.ts";
import type { LeagueSnapshot, PlayerStats, ScheduleAhead, ScoreHistory } from "../../shared/types.ts";

// Three views of the team against the league, above the roster on My team:
// its shape (how it scores), its weeks (finished and ahead) and its scoring
// mix. Each card says in one line what stands out; hovering or tapping a
// part of a chart gives that part's figure and rank. On a phone the cards
// slide sideways. Until the figures are ready each card shows its empty
// frame at full size, so nothing moves when the charts arrive.

interface Extras {
  history: ScoreHistory | null;
  schedule: ScheduleAhead | null;
}

/** Finished weeks and the schedule ahead, once per league and week (a failed load is tried again next time). */
const loadedExtras = new Map<string, Extras>();
const pendingExtras = new Map<string, Promise<Extras>>();

function useExtras(leagueId: string, week: number): Extras | null {
  const key = `${leagueId}:${week}`;
  const [extras, setExtras] = useState<Extras | null>(() => loadedExtras.get(key) ?? null);
  useEffect(() => {
    const ready = loadedExtras.get(key);
    if (ready) {
      setExtras(ready);
      return;
    }
    let live = true;
    let pending = pendingExtras.get(key);
    if (!pending) {
      pending = Promise.all([getHistory(leagueId).catch(() => null), getScheduleAhead(leagueId).catch(() => null)]).then(([history, schedule]) => {
        const value = { history, schedule };
        if (history && schedule) loadedExtras.set(key, value);
        pendingExtras.delete(key);
        return value;
      });
      pendingExtras.set(key, pending);
    }
    void pending.then((value) => live && setExtras(value));
    return () => {
      live = false;
    };
  }, [key, leagueId]);
  return extras;
}

interface Cached {
  extras: Extras;
  allowed: Record<string, number> | undefined;
  profiles: Map<number, TeamProfile>;
}
const profilesByModel = new WeakMap<StrengthModel, Cached>();

function cachedProfiles(model: StrengthModel | null, extras: Extras | null, allowed: Record<string, number> | undefined) {
  const hit = model ? profilesByModel.get(model) : undefined;
  return hit && hit.extras === extras && hit.allowed === allowed ? hit.profiles : null;
}

/**
 * Every team's profile. Worked out after the page has painted (it takes a moment), so the empty
 * frames show first; while a newer model is being measured the last profiles stay on screen.
 */
function useProfiles(
  snapshot: LeagueSnapshot,
  model: StrengthModel | null,
  strengths: TeamStrength[] | null,
  stats: Record<string, PlayerStats>,
  allowed: Record<string, number> | undefined,
) {
  const extras = useExtras(snapshot.league.id, snapshot.week);
  const [profiles, setProfiles] = useState(() => cachedProfiles(model, extras, allowed));
  useEffect(() => {
    if (!model || !strengths || !extras) return;
    const hit = cachedProfiles(model, extras, allowed);
    if (hit) {
      setProfiles(hit);
      return;
    }
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        const next = leagueProfiles(snapshot, model, strengths, stats, { ...extras, allowed });
        profilesByModel.set(model, { extras, allowed, profiles: next });
        setProfiles(next);
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [snapshot, model, strengths, stats, extras, allowed]);
  return profiles;
}

/** A rate as a whole percentage. */
const percent = (rate: number) => `${Math.round(100 * rate)}%`;

/** What a shape axis's figure means, short enough to fit the note under the chart. */
function shapeNote(axis: ProfileAxis, rate: number): string {
  const scaled = `, at the ${percent(rate)} of projections you really score`;
  switch (axis.key) {
    case "ceiling":
      return `${formatPoints(axis.value)} in a good week (better than 9 in 10)${scaled}`;
    case "floor":
      return `${formatPoints(axis.value)} in a bad week (worse than 9 in 10)${scaled}`;
    case "stars":
      return `${formatPoints(axis.value)} a week from your best three`;
    case "depth":
      return `${formatPoints(axis.value)} a week added by the bench${scaled}`;
    case "schedule": {
      if (!axis.schedule) return `${axis.value.toFixed(1)} games a week per main player`;
      const change = Math.round(100 * (axis.schedule.opponents - 1));
      const opponents =
        change === 0 ? "against average opponents" : `against opponents who give up ${Math.abs(change)}% ${change > 0 ? "more" : "fewer"} points than average`;
      return `${axis.schedule.games.toFixed(1)} games a week left per main player, ${opponents}`;
    }
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
  allowed,
  rosterId,
}: {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  strengths: TeamStrength[] | null;
  stats: Record<string, PlayerStats>;
  /** How many fantasy points each NBA team gives up, against the league average (StatsReport.allowed). */
  allowed: Record<string, number> | undefined;
  rosterId: number;
}) {
  const profiles = useProfiles(snapshot, model, strengths, stats, allowed);
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
  }, []);

  if (!profile) {
    return (
      <div className="team-charts-wrap" aria-busy="true">
        <div className="team-charts" ref={scroller}>
          <ChartCard title="Team shape" legend={RADAR_LEGEND} summary={null}>
            {() => <RadarFrame count={7} />}
          </ChartCard>
          <ChartCard title="Week by week" legend={WEEK_LEGEND} summary={null}>
            {() => <WeekFrame />}
          </ChartCard>
          <ChartCard title="Scoring mix" legend={RADAR_LEGEND} summary={null}>
            {() => <RadarFrame count={6} />}
          </ChartCard>
        </div>
        <Dots page={page} />
      </div>
    );
  }
  const shape = extremes(profile.shape);
  const mix = extremes(profile.mix);
  const finals = profile.weeks.filter((point) => point.final);
  const weekSummary = [
    profile.season && finals.length > 0
      ? `Averaging ${formatPoints(finals.reduce((sum, point) => sum + point.team, 0) / finals.length)} a week (${ordinal(profile.season.rank)} of ${teams}).`
      : profile.season
        ? `${ordinal(profile.season.rank)} of ${teams} in points so far.`
        : "",
    profile.ahead
      ? `Projected ${formatPoints(profile.ahead.average)} from here (${ordinal(profile.ahead.rank)})${
          profile.rate.weeks > 0 ? `, at ${percent(profile.rate.team)} of a perfectly run week` : ""
        }.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

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
                onFocus(axis && `${axis.label}: ${shapeNote(axis, profile.rate.team)}. ${ordinal(axis.rank)} of ${teams}.`)
              }
            />
          )}
        </ChartCard>
        <ChartCard
          title="Week by week"
          legend={WEEK_LEGEND}
          summary={weekSummary}
        >
          {(onFocus) => (
            <WeekChart
              weeks={profile.weeks}
              onFocus={(point) =>
                onFocus(
                  point &&
                    `Week ${point.week}, ${point.final ? "final" : "projected"}: ${formatPoints(point.team)}, ${ordinal(point.rank)} of ${teams}. League average ${formatPoints(point.leagueAverage)}.${
                      point.final || profile.rate.weeks === 0
                        ? ""
                        : ` Scaled to the ${percent(profile.rate.team)} of projections you really score (league ${percent(profile.rate.league)}).`
                    }`,
                )
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
      </div>
      <Dots page={page} />
    </div>
  );
}

function Dots({ page }: { page: number }) {
  return (
    <div className="team-charts-dots" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span key={index} className={index === page ? "is-current" : ""} />
      ))}
    </div>
  );
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
  /** Null while loading: the note keeps its place with two placeholder lines. */
  summary: string | null;
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
      {summary === null ? (
        <p className="team-chart-note is-loading" aria-label="Loading">
          <span className="team-chart-placeholder" />
          <span className="team-chart-placeholder short" />
        </p>
      ) : (
        <p className={`team-chart-note is-ready${focus ? " is-focus" : ""}`} aria-live="polite">
          {focus ?? summary}
        </p>
      )}
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
  const [x, y] = point(index, count, 10);
  const anchor = Math.abs(x - CX) < 8 ? "middle" : x > CX ? "start" : "end";
  // Beside the outer ring; a label straight above or below the middle sits clear of its dot.
  const lift = anchor !== "middle" ? 0 : y < CY ? -11 : 11;
  return { x: x + (anchor === "start" ? 5 : anchor === "end" ? -5 : 0), y: y + lift, anchor };
}

/** A box around an axis label, a little larger than the text (11px labels are about 6.4px a letter). */
function labelBox(label: string, index: number, count: number) {
  const { x, y, anchor } = labelAt(index, count);
  const width = label.length * 6.4 + 16;
  const left = anchor === "start" ? x - 8 : anchor === "end" ? x - width + 8 : x - width / 2;
  return { x: left, y: y - 10, width, height: 22 };
}

const path = (points: [number, number][]) => points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("") + "Z";

/** The radar's empty rings and spokes, the same size as the chart, while the figures load. */
function RadarFrame({ count }: { count: number }) {
  return (
    <svg className="radar is-loading" viewBox="-30 0 360 236" aria-hidden="true">
      {[2.5, 5, 7.5, 10].map((ring) => (
        <path key={ring} className="radar-ring" d={path(Array.from({ length: count }, (_, index) => point(index, count, ring)))} />
      ))}
      {Array.from({ length: count }, (_, index) => {
        const [x, y] = point(index, count, 10);
        return <line key={index} className="radar-spoke" x1={CX} y1={CY} x2={x} y2={y} />;
      })}
      <path className="chart-placeholder-shape" d={path(Array.from({ length: count }, (_, index) => point(index, count, 5 + 1.6 * Math.sin(index * 2.1))))} />
    </svg>
  );
}

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

/** The week chart's empty grid, the same size as the chart, while the figures load. */
function WeekFrame() {
  const plotHeight = W.height - W.top - W.bottom;
  const plotWidth = W.width - W.left - W.right;
  const wave = Array.from({ length: 13 }, (_, index) => {
    const x = W.left + (plotWidth * index) / 12;
    const y = W.top + plotHeight * (0.5 + 0.12 * Math.sin(index * 0.9));
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join("");
  return (
    <svg className="week-chart is-loading" viewBox={`0 0 ${W.width} ${W.height}`} aria-hidden="true">
      {[0.15, 0.38, 0.62, 0.85].map((share) => (
        <line key={share} className="week-grid" x1={W.left} x2={W.width - W.right} y1={W.top + plotHeight * share} y2={W.top + plotHeight * share} />
      ))}
      <path className="chart-placeholder-line" d={wave} />
    </svg>
  );
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
  // Finished weeks sit in a shaded band on the left with their final scores; a line marks
  // where the projections begin. The team's line is solid with filled dots where the score is
  // final, and lighter with open dots where it is projected.
  const played = weeks.filter((point) => point.final).length;
  const split = played > 0 && played < weeks.length ? (x(played - 1) + x(played)) / 2 : played === weeks.length ? W.width - W.right : null;
  const segment = (from: number, to: number) =>
    weeks
      .slice(from, to)
      .map((point, index) => `${index ? "L" : "M"}${x(from + index).toFixed(1)},${y(point.team).toFixed(1)}`)
      .join("");
  return (
    <svg className="week-chart" viewBox={`0 0 ${W.width} ${W.height}`} role="img" aria-label={played ? "Final score each finished week, then projected score each week left, against the league" : "Projected score each week left, against the league"} onPointerLeave={(event) => event.pointerType === "mouse" && pick(null)} onClick={(event) => event.target === event.currentTarget && pick(null)}>
      {niceTicks(y0, y1).map((tick) => (
        <g key={tick}>
          <line className="week-grid" x1={W.left} x2={W.width - W.right} y1={y(tick)} y2={y(tick)} />
          <text className="week-axis" x={W.left - 6} y={y(tick) + 3.5} textAnchor="end">
            {tick}
          </text>
        </g>
      ))}
      {split !== null && (
        <g className="week-played">
          <rect className="week-played-area" x={W.left} y={W.top} width={split - W.left} height={plotHeight} />
          {played < weeks.length && <line className="week-now" x1={split} x2={split} y1={W.top} y2={W.top + plotHeight} />}
          <text className="week-phase" x={W.left + 4} y={W.top + 11}>
            Final
          </text>
          {played < weeks.length && split < W.width - W.right - 50 && (
            <text className="week-phase" x={split + 4} y={W.top + 11}>
              Projected
            </text>
          )}
        </g>
      )}
      <path className="week-band" d={band} />
      <path className="week-league" d={line((point) => point.leagueAverage)} />
      {played > 0 && <path className="week-team" d={segment(0, played)} />}
      {played < weeks.length && <path className="week-team is-projected" d={segment(Math.max(0, played - 1), weeks.length)} />}
      {active !== null && <line className="week-guide" x1={x(active)} x2={x(active)} y1={W.top} y2={W.top + plotHeight} />}
      {weeks.map((point, index) => (
        <circle
          key={point.week}
          className={`week-dot${point.final ? "" : " is-projected"}${active === index ? " is-active" : ""}`}
          cx={x(index)}
          cy={y(point.team)}
          r={active === index ? 5 : point.final ? 3 : 2.5}
        />
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
