import { describe, expect, it } from "vitest";
import { leagueWeek, nbaDay, weekOfDate, weekRange } from "./weeks.ts";

describe("weekRange", () => {
  it("matches the week Sleeper shows for the owner's league", () => {
    expect(weekRange("2026-10-20", 5)).toEqual({ start: "2026-11-16", end: "2026-11-22" });
  });

  it("starts week 1 on the season's first day and ends it on Sunday", () => {
    expect(weekRange("2026-10-20", 1)).toEqual({ start: "2026-10-20", end: "2026-10-25" });
    expect(weekRange("2026-10-20", 2)).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });

  it("handles a season that starts on a Monday or a Sunday", () => {
    expect(weekRange("2026-10-19", 1)).toEqual({ start: "2026-10-19", end: "2026-10-25" });
    expect(weekRange("2026-10-25", 1)).toEqual({ start: "2026-10-25", end: "2026-10-25" });
  });
});

describe("the current week by date", () => {
  it("knows the NBA day and the week a date is in", () => {
    expect(nbaDay(Date.parse("2026-11-24T06:57:00Z"))).toBe("2026-11-23"); // 11:57 PM Mountain, Monday
    expect(nbaDay(Date.parse("2026-11-24T12:00:00Z"))).toBe("2026-11-24");
    expect(weekOfDate("2026-10-20", "2026-11-22")).toBe(5);
    expect(weekOfDate("2026-10-20", "2026-11-23")).toBe(6);
    expect(weekOfDate("2026-10-20", "2026-10-20")).toBe(1);
  });

  it("moves on from Sleeper's week when it lags by a day, never back and never by more than one", () => {
    expect(leagueWeek(5, "2026-10-20", "2026-11-23")).toBe(6);
    expect(leagueWeek(6, "2026-10-20", "2026-11-23")).toBe(6);
    expect(leagueWeek(7, "2026-10-20", "2026-11-23")).toBe(7);
    expect(leagueWeek(5, "2026-10-20", "2027-01-20")).toBe(6);
    expect(leagueWeek(5, null, "2026-11-23")).toBe(5);
  });
});
