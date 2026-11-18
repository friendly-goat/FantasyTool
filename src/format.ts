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
