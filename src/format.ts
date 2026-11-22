import type { StatLine } from "../shared/types.ts";

// Fantasy points show two decimals, as Sleeper does. All calculations keep
// full precision; rounding happens only here, when a number is displayed.
const pointsFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const relativeFormat = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

export function formatPoints(value: number): string {
  return pointsFormat.format(value);
}

export function formatSigned(value: number): string {
  const text = pointsFormat.format(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** "5 minutes ago", "2 hours ago", "yesterday". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return relativeFormat.format(Math.round(hours / 24), "day");
}

/** 1 -> "1st", 12 -> "12th", 22 -> "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

export function formatRecord(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

const oneDecimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Box-score averages (points, rebounds, minutes per game): one decimal place. */
export function formatAverage(value: number): string {
  return oneDecimal.format(value);
}

const gameDateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "2026-11-12" -> "Nov 12". Noon avoids the date shifting across time zones. */
export function formatGameDate(date: string): string {
  return gameDateFormat.format(new Date(`${date}T12:00:00`));
}

const clockFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short" });

function localDay(value: Date): string {
  return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}

/**
 * When a game tips off, in this browser's time zone: "Today 5:00 PM",
 * "Tomorrow 6:30 PM" or "Wed 7:00 PM". Without a time, the day alone.
 */
export function formatTipoff(startTime: string | null, date: string, now: Date = new Date()): string {
  const when = startTime ? new Date(startTime) : new Date(`${date}T12:00:00`);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const day =
    localDay(when) === localDay(now) ? "Today" : localDay(when) === localDay(tomorrow) ? "Tomorrow" : weekdayFormat.format(when);
  return startTime ? `${day} ${clockFormat.format(when)}` : day;
}

/** The game's day as a short weekday, "Tue". */
export function formatWeekday(date: string): string {
  return weekdayFormat.format(new Date(`${date}T12:00:00`));
}

/** "Nov 16–22", or "Nov 30–Dec 6" across months. */
export function formatWeekRange(start: string, end: string): string {
  const first = formatGameDate(start);
  const last = formatGameDate(end);
  return first.slice(0, 3) === last.slice(0, 3) ? `${first}–${last.slice(4)}` : `${first}–${last}`;
}

/**
 * A box score in one line, as Sleeper shows it: "6 PTS, 3 AST, 3/4 FG, 0/1 3PM, 1 PF".
 * Counting stats appear only when not zero; shooting only when attempted.
 */
export function formatStatLine(stats: StatLine, minutes?: number): string {
  const parts: string[] = [];
  if (minutes !== undefined && minutes > 0) parts.push(`${Math.round(minutes)} MIN`);
  const count = (value: number, label: string) => value > 0 && parts.push(`${value} ${label}`);
  count(stats.pts, "PTS");
  count(stats.reb, "REB");
  count(stats.ast, "AST");
  count(stats.stl, "STL");
  count(stats.blk, "BLK");
  count(stats.tov, "TO");
  if (stats.fga > 0) parts.push(`${stats.fgm}/${stats.fga} FG`);
  if (stats.tpa > 0) parts.push(`${stats.tpm}/${stats.tpa} 3PM`);
  if (stats.fta > 0) parts.push(`${stats.ftm}/${stats.fta} FT`);
  count(stats.pf, "PF");
  return parts.join(", ") || "No stats";
}

/**
 * Team strength is worked out on a 1 to 1000 scale (shared/strength.ts) and shown out of 5:
 * one star for every STRENGTH_PER_STAR points, so five stars is 600, three fifths of the way
 * from a roster of the best free agents (1) to the league's best players on one roster (1000,
 * about 8.3 stars). A fixed scale, chosen once: in the owner's league teams rate about 2.7 to
 * 4.6 and above 5 is rare. (It was a hundredth until the model moved to the real NBA schedule
 * in Nov 2026: every team moved up by about one star and three topped five, most likely because
 * the all-star roster's games clash on the same nights, so it lost more of its edge than real
 * teams did.)
 * Display only: grades, chances and the search use the 1 to 1000 score.
 */
export const STRENGTH_STARS = 5;
export const STRENGTH_PER_STAR = 120;

/** A team strength (1 to 1000) as its rating out of 5, unrounded. */
export function strengthRating(score: number): number {
  return score / STRENGTH_PER_STAR;
}

/** A team strength (1 to 1000) as its rating out of 5, such as "4.04". */
export function formatStrength(score: number): string {
  return strengthRating(score).toFixed(2);
}

/** A change in team strength (1 to 1000 points) as a change in the rating, such as "+0.12". */
export function formatStrengthChange(change: number): string {
  const size = (Math.abs(change) / STRENGTH_PER_STAR).toFixed(2);
  return change > 0 ? `+${size}` : change < 0 ? `−${size}` : "0.00";
}

/** A calendar day (YYYY-MM-DD) as "Jan 4", with the year when it is not the same year as `today`. */
export function formatDay(date: string, today: string): string {
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  });
}

/**
 * Where one game's fantasy points sit on the red-to-green scale (0 red, 3 yellow, 6 green; the
 * `--chance-0` to `--chance-6` colors), against the player's own average. Matching his average is
 * a good game, so the scale leans left: yellow is FPTS_TONE_STOPS' 85% of his average, his average
 * itself is mostly green, and 130% or more is full green. Null without an average to compare with.
 */
export const FPTS_TONE_STOPS: readonly (readonly [share: number, tone: number])[] = [
  [0.4, 0],
  [0.85, 3],
  [1, 5],
  [1.3, 6],
];

export function fantasyTone(points: number, average: number): number | null {
  if (!(average > 0) || !Number.isFinite(points)) return null;
  const share = points / average;
  const stops = FPTS_TONE_STOPS;
  if (share <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [toShare, toTone] = stops[i]!;
    if (share <= toShare) {
      const [fromShare, fromTone] = stops[i - 1]!;
      return fromTone + ((share - fromShare) / (toShare - fromShare)) * (toTone - fromTone);
    }
  }
  return stops[stops.length - 1]![1];
}

/** The color for a tone from fantasyTone: a blend of the two nearest `--chance-*` colors. */
export function toneColor(tone: number): string {
  const clamped = Math.min(6, Math.max(0, tone));
  const low = Math.floor(clamped);
  const high = Math.min(6, low + 1);
  const toward = Math.round((clamped - low) * 100);
  if (toward === 0 || low === high) return `var(--chance-${low})`;
  return `color-mix(in oklab, var(--chance-${high}) ${toward}%, var(--chance-${low}))`;
}
