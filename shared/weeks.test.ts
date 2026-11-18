import { describe, expect, it } from "vitest";
import { weekRange } from "./weeks.ts";

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
