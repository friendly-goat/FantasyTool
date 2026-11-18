import { describe, expect, it } from "vitest";
import {
  chanceBack,
  daysBetween,
  readInjury,
  readReturnDate,
  REEVALUATION_DAYS,
  returnOutlook,
  weeklyChanceBack,
} from "./injury.ts";

const today = "2026-11-17";
const news = (returnDate: string | null, description = "", status = "Out") =>
  readInjury({ status, returnDate, description }, today);

describe("readReturnDate", () => {
  it("fills in the year the report leaves out", () => {
    expect(readReturnDate("Dec 9", today)).toBe("2026-12-09");
    expect(readReturnDate("December 9th", today)).toBe("2026-12-09");
    expect(readReturnDate("Jan 15", today)).toBe("2027-01-15");
    expect(readReturnDate("12/9", today)).toBe("2026-12-09");
    // A date a little past is a report not yet updated, not next year.
    expect(readReturnDate("Nov 10", today)).toBe("2026-11-10");
  });

  it("keeps a full date and gives up on anything else", () => {
    expect(readReturnDate("2027-02-01", today)).toBe("2027-02-01");
    expect(readReturnDate("Mar 3, 2027", today)).toBe("2027-03-03");
    expect(readReturnDate("soon", today)).toBeNull();
    expect(readReturnDate(null, today)).toBeNull();
  });
});

describe("readInjury", () => {
  it("spots re-evaluations and season-ending injuries", () => {
    expect(news("Dec 9", "He will be re-evaluated in four weeks.").reevaluation).toBe(true);
    expect(news("Dec 9", "Expected to miss four weeks.").reevaluation).toBe(false);
    expect(news(null, "Out for the season after knee surgery.").seasonOut).toBe(true);
    expect(news(null, "Suffered a season-ending injury.").seasonOut).toBe(true);
    expect(news(null, "Sore ankle.").seasonOut).toBe(false);
  });
});

describe("returnOutlook", () => {
  it("takes a date a few days away almost as given", () => {
    const outlook = returnOutlook(news("Nov 20"));
    expect(outlook.kind).toBe("window");
    if (outlook.kind !== "window") return;
    expect(outlook.window.expected).toBe("2026-11-20");
    expect(daysBetween(outlook.window.earliest, outlook.window.latest)).toBeLessThanOrEqual(1);
  });

  it("moves a far date later and spreads it wider", () => {
    const near = returnOutlook(news("Dec 15")); // 28 days
    const far = returnOutlook(news("Jan 12")); // 56 days
    if (near.kind !== "window" || far.kind !== "window") throw new Error("expected windows");
    const late = (o: typeof near, stated: string) => daysBetween(stated, o.window.expected);
    expect(late(near, "2026-12-15")).toBe(2);
    expect(late(far, "2027-01-12")).toBe(5);
    const width = (o: typeof near) => daysBetween(o.window.earliest, o.window.latest);
    expect(width(far)).toBeGreaterThan(width(near));
    // He could be back a little early too.
    expect(far.window.earliest < "2027-01-12").toBe(true);
  });

  it("reads a re-evaluation date as the earliest return, not the expected one", () => {
    const outlook = returnOutlook(news("Dec 9", "Will be re-evaluated in about three weeks."));
    if (outlook.kind !== "window") throw new Error("expected a window");
    expect(outlook.window.earliest).toBe("2026-12-09");
    expect(daysBetween("2026-12-09", outlook.window.expected)).toBeGreaterThanOrEqual(REEVALUATION_DAYS);
  });

  it("keeps a season-ending injury out, and gives nothing without a date", () => {
    expect(returnOutlook(news(null, "Out for the season."))).toEqual({ kind: "season" });
    expect(returnOutlook(news(null, "Sore back."))).toEqual({ kind: "unknown" });
    expect(chanceBack({ kind: "season" }, "2027-03-01")).toBe(0);
    expect(chanceBack({ kind: "unknown" }, "2027-03-01")).toBeNull();
  });

  it("reads a date already past as today", () => {
    const outlook = returnOutlook(news("Nov 10"));
    expect(chanceBack(outlook, today)).toBe(1);
  });
});

describe("weeklyChanceBack", () => {
  it("rises across the window, week by week", () => {
    const outlook = returnOutlook(news("Dec 15"));
    const weeks = [
      { start: "2026-11-16", end: "2026-11-22" },
      { start: "2026-12-07", end: "2026-12-13" },
      { start: "2026-12-14", end: "2026-12-20" },
      { start: "2027-01-04", end: "2027-01-10" },
    ];
    const chances = weeklyChanceBack(outlook, weeks, today)!;
    expect(chances[0]).toBe(0);
    expect(chances[3]).toBe(1);
    for (let i = 1; i < chances.length; i++) expect(chances[i]!).toBeGreaterThanOrEqual(chances[i - 1]!);
    expect(chances[2]!).toBeGreaterThan(0);
    expect(chances[2]!).toBeLessThan(1);
    expect(weeklyChanceBack({ kind: "unknown" }, weeks, today)).toBeNull();
  });
});
