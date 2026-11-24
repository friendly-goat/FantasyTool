import type { CareerGame, CareerSeason } from "./types.ts";

// The player card's career graph: one line across every game of his career,
// whatever its length. Each season takes room by the games he played in it
// (with a floor, so a short or current season stays readable), and the line is
// his form: a rolling average of his fantasy scores that never reaches across
// an offseason. A two-season player and an eighteen-season one both fill the
// graph from left to right. Display only.

/** The NBA season (its starting year) a game date belongs to: September on starts a new one. */
export function seasonOfDate(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return String(month >= 9 ? year : year - 1);
}

/** The fewest and most games each point of the form line averages. */
export const FORM_WINDOW_MIN = 5;
export const FORM_WINDOW_MAX = 25;

/**
 * Games each point of the form line averages: more for a longer career, so a short one shows his
 * form within a season and a long one his level from year to year. Always odd (centered).
 */
export function formWindow(totalGames: number): number {
  const raw = Math.round(0.6 * Math.sqrt(Math.max(0, totalGames)));
  const clamped = Math.min(FORM_WINDOW_MAX, Math.max(FORM_WINDOW_MIN, raw));
  return clamped % 2 === 0 ? clamped + 1 : clamped;
}

/** A centered rolling average of one season's scores; near its first and last games it averages fewer. */
export function smoothSeason(points: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return points.map((_, index) => {
    const from = Math.max(0, index - half);
    const to = Math.min(points.length - 1, index + half);
    let sum = 0;
    for (let at = from; at <= to; at++) sum += points[at]!;
    return sum / (to - from + 1);
  });
}

/** Room a season gets, in games: his teams' games while he was on them, at least this many. */
export const MIN_SEASON_ROOM = 20;
/** Room for a season he did not play at all (an "Out" band). */
export const EMPTY_SEASON_ROOM = 12;
/** Share of nearby games missed at which the line is fully red. */
export const MISSED_RED_SHARE = 0.6;
/** Color steps from red (0) to green (MISSED_TONES), as the `--chance-*` tokens. */
export const MISSED_TONES = 6;

/** One season's place on the graph, from 0 (left edge) to 1 (right edge). */
export interface CareerSpan {
  season: string;
  from: number;
  to: number;
  games: number;
  /** His teams' games he missed. */
  missed: number;
  /** His fantasy average that season; null when he did not play. */
  average: number | null;
}

export interface CareerPoint {
  x: number;
  /** His form here; null breaks the line (a season he did not play). */
  value: number | null;
  /** Share of his teams' games around here that he missed, 0 to 1. */
  missedShare: number;
}

export interface CareerLayout {
  spans: CareerSpan[];
  /** The form line, left to right. */
  line: CareerPoint[];
  /** Games each point of the form averages. */
  window: number;
  /** Team games each point's missed share looks at. */
  missedWindow: number;
  /** The highest value drawn (form or season average), for the scale. */
  peak: number;
}

/**
 * Lays out a career: seasons oldest first, from his first season with a game (an empty season
 * before it is left off; one after it shows as an "Out" band). Each season is his teams' games
 * while he was on them, played or missed, one slot each, so a season with a long absence keeps
 * its room. The line is his form at the games he played and runs straight across the games he
 * missed; each point also carries the share of games missed around it, for the line's color.
 * Each played season's line runs across its whole room, so the line starts at the left edge and
 * ends at the right one.
 */
export function careerLayout(seasons: CareerSeason[], games: CareerGame[], missed: { season: string; date: string }[] = []): CareerLayout {
  const ordered = [...seasons].sort((a, b) => a.season.localeCompare(b.season));
  const first = ordered.findIndex((season) => season.games > 0);
  const shown = first < 0 ? [] : ordered.slice(first);
  type Slot = { date: string; points: number | null };
  const slotsOf = new Map<string, Slot[]>();
  const add = (season: string, slot: Slot) => {
    const list = slotsOf.get(season);
    if (list) list.push(slot);
    else slotsOf.set(season, [slot]);
  };
  for (const game of games) add(game.season, { date: game.date, points: game.points });
  for (const game of missed) add(game.season, { date: game.date, points: null });
  for (const list of slotsOf.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const slotLists = shown.map((season) => {
    const list = slotsOf.get(season.season) ?? [];
    return list.some((slot) => slot.points !== null) ? list : [];
  });
  const playedTotal = slotLists.reduce((sum, list) => sum + list.filter((slot) => slot.points !== null).length, 0);
  const window = formWindow(playedTotal);
  const missedWindow = formWindow(slotLists.reduce((sum, list) => sum + list.length, 0));
  const rooms = slotLists.map((list) => (list.length > 0 ? Math.max(list.length, MIN_SEASON_ROOM) : EMPTY_SEASON_ROOM));
  const total = rooms.reduce((sum, room) => sum + room, 0) || 1;

  const spans: CareerSpan[] = [];
  const line: CareerPoint[] = [];
  let peak = 0;
  let at = 0;
  shown.forEach((season, index) => {
    const from = at / total;
    at += rooms[index]!;
    const to = at / total;
    const slots = slotLists[index]!;
    const points = slots.flatMap((slot) => (slot.points === null ? [] : [slot.points]));
    const average = points.length > 0 ? points.reduce((sum, value) => sum + value, 0) / points.length : null;
    spans.push({ season: season.season, from, to, games: points.length, missed: slots.length - points.length, average });
    if (points.length === 0) {
      line.push({ x: from, value: null, missedShare: 0 });
      return;
    }
    const form = smoothSeason(points, window);
    const values = acrossMissed(slots, form);
    const shares = smoothSeason(
      slots.map((slot) => (slot.points === null ? 1 : 0)),
      missedWindow,
    );
    const width = to - from;
    line.push({ x: from, value: values[0]!, missedShare: shares[0]! });
    values.forEach((value, slot) => line.push({ x: from + (width * (slot + 0.5)) / slots.length, value, missedShare: shares[slot]! }));
    line.push({ x: to, value: values.at(-1)!, missedShare: shares.at(-1)! });
    peak = Math.max(peak, average ?? 0, ...form);
  });
  return { spans, line, window, missedWindow, peak };
}

/**
 * His form at every slot of a season: at a game he played, that game's form; across games he
 * missed, a straight line from the form before to the form after (level at a season's ends).
 */
function acrossMissed(slots: { points: number | null }[], form: number[]): number[] {
  const playedAt: number[] = [];
  slots.forEach((slot, index) => slot.points !== null && playedAt.push(index));
  const values: number[] = [];
  let next = 0;
  slots.forEach((slot, index) => {
    while (next < playedAt.length && playedAt[next]! < index) next++;
    if (slot.points !== null) {
      values.push(form[next]!);
      return;
    }
    const after = next < playedAt.length ? next : -1;
    const before = next - 1;
    if (before < 0) values.push(form[after]!);
    else if (after < 0) values.push(form[before]!);
    else {
      const share = (index - playedAt[before]!) / (playedAt[after]! - playedAt[before]!);
      values.push(form[before]! + (form[after]! - form[before]!) * share);
    }
  });
  return values;
}

/** The line's color step for a share of games missed: MISSED_TONES (green) for none, 0 (red) at MISSED_RED_SHARE or more. */
export function missedTone(share: number): number {
  return Math.round(MISSED_TONES * (1 - Math.min(1, Math.max(0, share) / MISSED_RED_SHARE)));
}

/**
 * Color stops for the line, as offsets 0 to 1 across the graph with a color step each: one where
 * the step changes, plus each season's edges, so a long career stays a few hundred stops at most.
 */
export function missedStops(line: CareerPoint[]): { offset: number; tone: number }[] {
  const stops: { offset: number; tone: number }[] = [];
  for (const point of line) {
    if (point.value === null) continue;
    const tone = missedTone(point.missedShare);
    const last = stops.at(-1);
    if (last && last.tone === tone && point.x - last.offset < 0.02) continue;
    stops.push({ offset: point.x, tone });
  }
  return stops;
}

/** A round top for the scale and the step between its gridlines (three or four steps). */
export function careerScale(peak: number): { top: number; step: number } {
  const target = Math.max(10, peak * 1.08);
  for (const step of [5, 10, 20, 25, 50]) {
    if (target / step <= 4) return { top: Math.ceil(target / step) * step, step };
  }
  return { top: Math.ceil(target / 100) * 100, step: Math.ceil(target / 400) * 100 };
}

/**
 * Which season labels fit along the axis without touching: the newest always, then each older one
 * that keeps at least `gap` from the last label kept. `centers` are positions in pixels.
 */
export function fittingLabels(centers: number[], gap: number): boolean[] {
  const keep = centers.map(() => false);
  let last = Number.POSITIVE_INFINITY;
  for (let index = centers.length - 1; index >= 0; index--) {
    if (last - centers[index]! >= gap) {
      keep[index] = true;
      last = centers[index]!;
    }
  }
  return keep;
}

/** "2015-16" in full, "15-16" short, "’15" shortest. */
export function seasonLabel(season: string, form: "full" | "short" | "year"): string {
  const year = Number(season);
  const next = String((year + 1) % 100).padStart(2, "0");
  const start = String(year % 100).padStart(2, "0");
  return form === "full" ? `${year}-${next}` : form === "short" ? `${start}-${next}` : `’${start}`;
}
