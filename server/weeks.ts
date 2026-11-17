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
