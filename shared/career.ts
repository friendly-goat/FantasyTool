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

/** Room a season gets, in games: the games he played, at least this many. */
export const MIN_SEASON_ROOM = 20;
/** Room for a season he did not play at all (an "Out" band). */
export const EMPTY_SEASON_ROOM = 12;

/** One season's place on the graph, from 0 (left edge) to 1 (right edge). */
export interface CareerSpan {
  season: string;
  from: number;
  to: number;
  games: number;
  /** His fantasy average that season; null when he did not play. */
  average: number | null;
}

export interface CareerLayout {
  spans: CareerSpan[];
  /** The form line, left to right; a null value breaks it (a season he did not play). */
  line: { x: number; value: number | null }[];
  /** Games each point averages. */
  window: number;
  /** The highest value drawn (form or season average), for the scale. */
  peak: number;
}

/**
 * Lays out a career: seasons oldest first, from his first season with a game (an empty season
 * before it is left off; one after it shows as an "Out" band). Each played season's line runs
 * across its whole room, so the line starts at the left edge and ends at the right one.
 */
export function careerLayout(seasons: CareerSeason[], games: CareerGame[]): CareerLayout {
  const ordered = [...seasons].sort((a, b) => a.season.localeCompare(b.season));
  const first = ordered.findIndex((season) => season.games > 0);
  const shown = first < 0 ? [] : ordered.slice(first);
  const bySeason = new Map<string, number[]>();
  for (const game of [...games].sort((a, b) => a.date.localeCompare(b.date))) {
    const list = bySeason.get(game.season);
    if (list) list.push(game.points);
    else bySeason.set(game.season, [game.points]);
  }
  const counts = shown.map((season) => bySeason.get(season.season)?.length ?? 0);
  const window = formWindow(counts.reduce((sum, count) => sum + count, 0));
  const rooms = counts.map((count) => (count > 0 ? Math.max(count, MIN_SEASON_ROOM) : EMPTY_SEASON_ROOM));
  const total = rooms.reduce((sum, room) => sum + room, 0) || 1;

  const spans: CareerSpan[] = [];
  const line: CareerLayout["line"] = [];
  let peak = 0;
  let at = 0;
  shown.forEach((season, index) => {
    const from = at / total;
    at += rooms[index]!;
    const to = at / total;
    const points = bySeason.get(season.season) ?? [];
    const average = points.length > 0 ? points.reduce((sum, value) => sum + value, 0) / points.length : null;
    spans.push({ season: season.season, from, to, games: points.length, average });
    if (points.length === 0) {
      line.push({ x: from, value: null });
      return;
    }
    const form = smoothSeason(points, window);
    const width = to - from;
    line.push({ x: from, value: form[0]! });
    form.forEach((value, game) => line.push({ x: from + (width * (game + 0.5)) / form.length, value }));
    line.push({ x: to, value: form.at(-1)! });
    peak = Math.max(peak, average ?? 0, ...form);
  });
  return { spans, line, window, peak };
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
