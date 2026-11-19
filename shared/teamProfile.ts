// A team's profile against the rest of the league, for the charts above the
// roster on My team. Three views, each measured for every team so a team is
// placed against the league, not against an ideal:
//
//   Shape:  how the team scores, from the same lock-in simulation as team
//           strength: its good weeks (ceiling), its bad weeks (floor), its
//           top three, what the bench adds, games played a week, health now
//           (the next HEALTH_WEEKS weeks) and where its players are heading.
//   Mix:    where its fantasy points come from (scoring, threes, boards,
//           playmaking, defense, bonuses), from the players who play most.
//   Weeks:  its projected score in each real week left, against the league.
//
// Radar values are placed on the league's own range: 0 is the lowest team,
// 10 the highest. A range narrower than the axis's MIN_RANGE is widened to
// it, so a tiny gap between teams does not look like the whole scale. Display only: none of this feeds strength, grades or trade
// ideas.
import { rosterPlayers } from "./analysis.ts";
import { fillRoster, type ModelPlayer, type StrengthModel, type TeamStrength, weeklyTotals } from "./strength.ts";
import { FANTASY_SOURCES, type FantasySource, type LeagueSnapshot, type PlayerStats } from "./types.ts";

export interface ProfileAxis {
  key: string;
  label: string;
  /** The team's own figure, in the axis's unit. */
  value: number;
  /** Where that sits in the league's range, 0 (lowest team) to 10 (highest). */
  scaled: number;
  /** The league's average on the same scale. */
  league: number;
  /** 1 for the league's best on this axis. */
  rank: number;
  /** How the figure reads, e.g. "412.30 a week". */
  unit: "points" | "percent" | "games";
}

export interface WeekPoint {
  week: number;
  team: number;
  leagueAverage: number;
  leagueLow: number;
  leagueHigh: number;
  rank: number;
}

export interface TeamProfile {
  rosterId: number;
  shape: ProfileAxis[];
  /** Empty when the stats report has no split by source yet. */
  mix: ProfileAxis[];
  /** Fantasy points a game the team's main players lose to turnovers and fouls (positive), and its rank (1: fewest). */
  mistakes: { value: number; rank: number } | null;
  weeks: WeekPoint[];
}

/** Players counted for the mix and for health: the ones who play most. */
const MIX_PLAYERS = 10;
/** Health is about now: the share of value on hand over this many real weeks. */
export const HEALTH_WEEKS = 4;

interface AxisDef {
  key: string;
  label: string;
  unit: ProfileAxis["unit"];
  /** The narrowest range the league is placed on, in the axis's unit. */
  minRange: number;
  /** Widen a narrow range downward from the best team (health: the healthiest is the edge), not around the middle. */
  fromTop?: boolean;
}
const SHAPE_AXES: AxisDef[] = [
  { key: "ceiling", label: "Ceiling", unit: "points", minRange: 10 },
  { key: "stars", label: "Top three", unit: "points", minRange: 6 },
  { key: "depth", label: "Depth", unit: "points", minRange: 5 },
  { key: "games", label: "Games", unit: "games", minRange: 0.3 },
  { key: "health", label: "Health", unit: "percent", minRange: 25, fromTop: true },
  { key: "trend", label: "Trend", unit: "percent", minRange: 6 },
  { key: "floor", label: "Floor", unit: "points", minRange: 10 },
];
/** Points a game: the narrowest range for a source in the mix. */
const MIX_MIN_RANGE = 2;
const MIX_LABELS: Record<Exclude<FantasySource, "mistakes">, string> = {
  scoring: "Scoring",
  threes: "Threes",
  boards: "Boards",
  playmaking: "Playmaking",
  defense: "Defense",
  bonuses: "Bonuses",
};

function quantile(sorted: number[], share: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))));
  return sorted[at]!;
}

/** Each team's figure placed on the league's range (0 to 10), its rank, and the league's average on that scale. */
function place(raw: Map<number, number>, def: AxisDef): Map<number, { scaled: number; rank: number; league: number }> {
  const values = [...raw.values()];
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high - low < def.minRange) {
    if (def.fromTop) low = high - def.minRange;
    else {
      const middle = (low + high) / 2;
      [low, high] = [middle - def.minRange / 2, middle + def.minRange / 2];
    }
  }
  const scale = (value: number) => (high - low < 1e-9 ? 5 : (10 * (value - low)) / (high - low));
  const order = [...raw.entries()].sort((a, b) => b[1] - a[1]).map(([rosterId]) => rosterId);
  const league = values.reduce((sum, value) => sum + scale(value), 0) / Math.max(1, values.length);
  return new Map([...raw.entries()].map(([rosterId, value]) => [rosterId, { scaled: scale(value), rank: order.indexOf(rosterId) + 1, league }]));
}

function axes(rows: Map<number, Record<string, number>>, defs: AxisDef[], rosterId: number): ProfileAxis[] {
  return defs.map((def) => {
    const raw = new Map([...rows.entries()].map(([id, row]) => [id, row[def.key] ?? 0]));
    const placed = place(raw, def).get(rosterId)!;
    return { key: def.key, label: def.label, unit: def.unit, value: raw.get(rosterId) ?? 0, ...placed };
  });
}

/** Profiles for every team in the league. */
export function leagueProfiles(
  snapshot: LeagueSnapshot,
  model: StrengthModel,
  strengths: TeamStrength[],
  stats: Record<string, PlayerStats>,
): Map<number, TeamProfile> {
  const shapeRows = new Map<number, Record<string, number>>();
  const mixRows = new Map<number, Record<string, number>>();
  const weekRows = new Map<number, number[]>();
  const realWeeks = Math.max(1, model.calendar.weeks.length);
  let hasMix = false;

  for (const team of snapshot.teams) {
    const ids = rosterPlayers(team).map((player) => player.id);
    const players = ids.flatMap((id) => model.players.get(id) ?? []);
    // Run as its manager would, as team strength does: IR, open spots from waivers.
    const totals = weeklyTotals(model, fillRoster(model, ids).ids);
    const sorted = [...totals].sort((a, b) => a - b);
    const byValue = [...players].sort((a, b) => b.expected - a.expected);
    const main = byValue.slice(0, MIX_PLAYERS);
    const strength = strengths.find((entry) => entry.rosterId === team.rosterId);

    // Health now: each main player's chance of being back, week by week, over the next few weeks.
    const soon = Math.min(HEALTH_WEEKS, realWeeks);
    const onHand = (player: ModelPlayer) =>
      player.back ? Array.from(player.back.slice(0, soon)).reduce((sum, chance) => sum + chance, 0) / soon : 1;
    // Chosen by what they are worth when fit, so an injured star is not left out of his own team's health.
    const core = [...players].sort((a, b) => b.healthy - a.healthy).slice(0, MIX_PLAYERS);
    const healthy = core.reduce((sum, player) => sum + player.healthy, 0);
    const injuredAway = core.reduce((sum, player) => sum + player.healthy * (1 - onHand(player)), 0);
    const seen = main.filter((player) => player.games > 0);
    const average = seen.reduce((sum, player) => sum + player.average, 0);
    shapeRows.set(team.rosterId, {
      ceiling: quantile(sorted, 0.9),
      floor: quantile(sorted, 0.1),
      stars: byValue.slice(0, 3).reduce((sum, player) => sum + player.expected, 0),
      depth: strength?.benchAdds ?? 0,
      games: main.reduce((sum, player) => sum + gamesPerWeek(model, player), 0) / Math.max(1, main.length),
      health: healthy > 0 ? 100 * (1 - injuredAway / healthy) : 100,
      trend: average > 0 ? (100 * seen.reduce((sum, player) => sum + (player.projected - player.average), 0)) / average : 0,
    });

    // The mix: each main player's points a game by source, as often as he is expected to play.
    const mix: Record<string, number> = Object.fromEntries(FANTASY_SOURCES.map((source) => [source, 0]));
    for (const player of main) {
      const sources = stats[player.id]?.sources;
      if (!sources) continue;
      hasMix = true;
      for (const source of FANTASY_SOURCES) mix[source]! += sources[source] * player.availability;
    }
    mixRows.set(team.rosterId, mix);

    const byWeek = new Array<number>(realWeeks).fill(0);
    const counts = new Array<number>(realWeeks).fill(0);
    totals.forEach((total, week) => {
      byWeek[week % realWeeks]! += total;
      counts[week % realWeeks]!++;
    });
    weekRows.set(team.rosterId, byWeek.map((total, index) => (counts[index] ? total / counts[index]! : 0)));
  }

  const mistakes = new Map([...mixRows.entries()].map(([id, row]) => [id, -(row.mistakes ?? 0)]));
  const fewestMistakes = [...mistakes.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  // A source the league does not score (threes, in a league that gives nothing for them) is left out.
  const mixDefs = (Object.keys(MIX_LABELS) as (keyof typeof MIX_LABELS)[])
    .filter((key) => [...mixRows.values()].some((row) => Math.abs(row[key] ?? 0) > 0.01))
    .map((key): AxisDef => ({ key, label: MIX_LABELS[key], unit: "points", minRange: MIX_MIN_RANGE }));

  const profiles = new Map<number, TeamProfile>();
  for (const team of snapshot.teams) {
    const weeks = model.calendar.weeks.map((week, index) => {
      const scores = [...weekRows.values()].map((row) => row[index] ?? 0);
      const mine = weekRows.get(team.rosterId)?.[index] ?? 0;
      return {
        week: week.week,
        team: mine,
        leagueAverage: scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length),
        leagueLow: Math.min(...scores),
        leagueHigh: Math.max(...scores),
        rank: 1 + scores.filter((score) => score > mine).length,
      };
    });
    profiles.set(team.rosterId, {
      rosterId: team.rosterId,
      shape: axes(shapeRows, SHAPE_AXES, team.rosterId),
      mix: hasMix ? axes(mixRows, mixDefs, team.rosterId) : [],
      mistakes: hasMix ? { value: mistakes.get(team.rosterId) ?? 0, rank: fewestMistakes.indexOf(team.rosterId) + 1 } : null,
      weeks,
    });
  }
  return profiles;
}

/** Games a week he is expected to play, over the imaginary weeks (schedule, rest and injury). */
function gamesPerWeek(model: StrengthModel, player: ModelPlayer): number {
  let games = 0;
  for (let index = 0; index < player.gameDay.length; index++) if (player.gameDay[index]! >= 0) games++;
  return games / Math.max(1, model.weeks);
}

/** The best and worst axes, for a one-line summary (best first). */
export function extremes(axes: ProfileAxis[]): { best: ProfileAxis; worst: ProfileAxis } | null {
  if (axes.length === 0) return null;
  const sorted = [...axes].sort((a, b) => a.rank - b.rank || b.scaled - a.scaled);
  return { best: sorted[0]!, worst: sorted[sorted.length - 1]! };
}

/** The run of weeks (up to three) furthest above the league average, and the single week furthest below. */
export function weekHighlights(weeks: WeekPoint[]): { best: WeekPoint[]; worst: WeekPoint } | null {
  if (weeks.length === 0) return null;
  const margin = (point: WeekPoint) => point.team - point.leagueAverage;
  const span = Math.min(3, weeks.length);
  let bestStart = 0;
  let bestTotal = -Infinity;
  for (let start = 0; start + span <= weeks.length; start++) {
    const total = weeks.slice(start, start + span).reduce((sum, point) => sum + margin(point), 0);
    if (total > bestTotal) {
      bestTotal = total;
      bestStart = start;
    }
  }
  const worst = weeks.reduce((low, point) => (margin(point) < margin(low) ? point : low));
  return { best: weeks.slice(bestStart, bestStart + span), worst };
}
