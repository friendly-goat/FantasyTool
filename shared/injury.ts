// When an injured player is back, from the injury report's return date.
//
// A return date is an estimate, and the further out it is the less it holds,
// so it is read as a window rather than a day. The chance he is back rises
// across the window. Three fixed rules shape it:
//
//   Buffer:        dates more than NEAR_DAYS away move later by BUFFER_SHARE
//                  of the time beyond that (4 weeks away: about 2 days;
//                  8 weeks: about 5).
//   Re-evaluation: "re-evaluated in three weeks" is the earliest he could be
//                  back, not when he will be. The expected return moves
//                  REEVALUATION_DAYS after it.
//   Spread:        the window is wider the further out the date is: at least
//                  SPREAD_SHARE of the time away, centred on the expected day.
//
// A report with no date that says he is out for the season keeps him out for
// the rest of it. Any other report without a date gives no window; the
// projection then falls back on how long he has already been out.

export interface InjuryNews {
  /** The report's availability word, such as "Out" or "Day-To-Day". */
  status: string;
  /** Expected return, YYYY-MM-DD, with the year filled in; null when the report gives none. */
  returnDate: string | null;
  description: string;
  /** The note says he will be re-evaluated: the date is the earliest he could be back. */
  reevaluation: boolean;
  /** The note says he is out for the season. */
  seasonOut: boolean;
  /** The day the report was read, YYYY-MM-DD. */
  asOf: string;
}

export const NEAR_DAYS = 7;
export const BUFFER_SHARE = 0.1;
export const REEVALUATION_DAYS = 10;
export const SPREAD_SHARE = 0.25;

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function toTime(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function toDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return toDate(toTime(date) + Math.round(days) * DAY);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY);
}

/**
 * A return date as the report writes it ("Nov 17", "December 9", "12/9",
 * "2026-12-09") as YYYY-MM-DD. Reports often leave out the year: it is the
 * year that puts the date nearest after today, allowing for a date a little
 * in the past (a report not yet updated).
 */
export function readReturnDate(text: string | null, today: string): string | null {
  if (!text) return null;
  const value = text.trim().toLowerCase();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  const named = value.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  const numeric = value.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (named && MONTHS.includes(named[1]!)) {
    month = MONTHS.indexOf(named[1]!) + 1;
    day = Number(named[2]);
    year = named[3] ? Number(named[3]) : null;
  } else if (numeric) {
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : null;
  }
  if (!month || !day || month > 12 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (year) return `${year}-${pad(month)}-${pad(day)}`;
  const thisYear = Number(today.slice(0, 4));
  const candidate = `${thisYear}-${pad(month)}-${pad(day)}`;
  return daysBetween(today, candidate) < -60 ? `${thisYear + 1}-${pad(month)}-${pad(day)}` : candidate;
}

export function readInjury(
  report: { status: string; returnDate: string | null; description: string },
  today: string,
): InjuryNews {
  const text = `${report.status} ${report.description}`;
  return {
    status: report.status,
    returnDate: readReturnDate(report.returnDate, today),
    description: report.description,
    reevaluation: /re-?evaluat/i.test(report.description),
    seasonOut: /out for (the )?(rest of the |remainder of the )?season|season-ending/i.test(text),
    asOf: today,
  };
}

export interface ReturnWindow {
  /** First day he could be back. */
  earliest: string;
  /** The middle of the window: the day he is as likely as not to be back by. */
  expected: string;
  /** By this day he is taken to be back. */
  latest: string;
}

export type ReturnOutlook = { kind: "season" } | { kind: "window"; window: ReturnWindow } | { kind: "unknown" };

export function returnOutlook(news: InjuryNews): ReturnOutlook {
  if (news.seasonOut && !news.returnDate) return { kind: "season" };
  if (!news.returnDate) return { kind: "unknown" };
  // A date already past (a report not yet updated) is read as today.
  const stated = daysBetween(news.asOf, news.returnDate) < 0 ? news.asOf : news.returnDate;
  const away = daysBetween(news.asOf, stated);
  const buffer = Math.max(0, away - NEAR_DAYS) * BUFFER_SHARE;
  const expectedDays = away + (news.reevaluation ? REEVALUATION_DAYS : 0) + buffer;
  const half = Math.max(expectedDays - away, (SPREAD_SHARE * away) / 2);
  const earliestDays = Math.max(0, expectedDays - half);
  return {
    kind: "window",
    window: {
      earliest: addDays(news.asOf, earliestDays),
      expected: addDays(news.asOf, expectedDays),
      latest: addDays(news.asOf, expectedDays + half),
    },
  };
}

/** The chance he is back by `date`: 0 before the window, 1 after it, rising evenly across it. */
export function chanceBack(outlook: ReturnOutlook, date: string): number | null {
  if (outlook.kind === "season") return 0;
  if (outlook.kind === "unknown") return null;
  const { earliest, latest } = outlook.window;
  const span = daysBetween(earliest, latest);
  const into = daysBetween(earliest, date);
  if (span <= 0) return into >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, into / span));
}

/**
 * For each fantasy week (first and last day), the share of its days on which
 * he is expected to be back. Days before `today` count as they are now.
 * Null when the report gives no window.
 */
export function weeklyChanceBack(
  outlook: ReturnOutlook,
  weeks: { start: string; end: string }[],
  today: string,
): number[] | null {
  if (outlook.kind === "unknown") return null;
  return weeks.map(({ start, end }) => {
    const from = start < today ? (today <= end ? today : end) : start;
    let total = 0;
    let days = 0;
    for (let date = from; date <= end; date = addDays(date, 1)) {
      total += chanceBack(outlook, date)!;
      days++;
    }
    return days > 0 ? total / days : 1;
  });
}
