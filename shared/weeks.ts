// Sleeper's NBA fantasy weeks run Monday to Sunday. Week 1 is the week that
// contains the season's first day, so it is usually a short week.
// Checked against the owner's league: season start 2026-10-20 (a Tuesday),
// and Sleeper labels week 5 as Nov 16-22.

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** First and last day (YYYY-MM-DD, inclusive) of a fantasy week. */
export function weekRange(seasonStart: string, week: number): { start: string; end: string } {
  const weekday = new Date(`${seasonStart}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(seasonStart, -((weekday + 6) % 7));
  const start = addDays(monday, (week - 1) * 7);
  return { start: week === 1 ? seasonStart : start, end: addDays(start, 6) };
}

/**
 * Hours behind UTC at which the NBA's day turns over: 10 puts the change at 5 AM Eastern, after
 * the last West Coast game has finished, so a Sunday night game still counts on Sunday.
 */
export const NBA_DAY_OFFSET_HOURS = 10;

/** The NBA day (YYYY-MM-DD) an instant belongs to. */
export function nbaDay(ms: number): string {
  return new Date(ms - NBA_DAY_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/** The fantasy week a date falls in (0 or less before the season's first week). */
export function weekOfDate(seasonStart: string, date: string): number {
  const weekday = new Date(`${seasonStart}T00:00:00Z`).getUTCDay();
  const monday = addDays(seasonStart, -((weekday + 6) % 7));
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000);
  return Math.floor(days / 7) + 1;
}

/**
 * The league's current week: Sleeper's, moved on to the week the date is in when Sleeper has not
 * caught up yet (its week turns over a day or so after the fantasy week does, so on a Monday it can
 * still name the week just finished). Never more than one week past Sleeper's, never back.
 */
export function leagueWeek(sleeperWeek: number, seasonStart: string | null, today: string): number {
  if (!seasonStart) return sleeperWeek;
  return Math.max(sleeperWeek, Math.min(weekOfDate(seasonStart, today), sleeperWeek + 1));
}
