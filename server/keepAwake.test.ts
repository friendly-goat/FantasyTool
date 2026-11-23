import { describe, expect, it } from "vitest";
import { inAwakeHours, localHour } from "./keepAwake.ts";

describe("inAwakeHours", () => {
  it("is always awake without a window, or with one it cannot read", () => {
    expect(inAwakeHours(undefined, 3)).toBe(true);
    expect(inAwakeHours("", 3)).toBe(true);
    expect(inAwakeHours("mornings", 3)).toBe(true);
  });

  it("keeps a window within one day, end not included", () => {
    expect(inAwakeHours("7-24", 7)).toBe(true);
    expect(inAwakeHours("7-24", 23)).toBe(true);
    expect(inAwakeHours("7-24", 6)).toBe(false);
    expect(inAwakeHours("9-17", 17)).toBe(false);
  });

  it("wraps a window past midnight", () => {
    expect(inAwakeHours("22-6", 23)).toBe(true);
    expect(inAwakeHours("22-6", 2)).toBe(true);
    expect(inAwakeHours("22-6", 12)).toBe(false);
  });
});

describe("localHour", () => {
  it("gives an hour from 0 to 23, falling back to UTC for an unknown zone", () => {
    for (const zone of ["UTC", "America/Denver", "Not/AZone", undefined]) {
      const hour = localHour(zone);
      expect(hour).toBeGreaterThanOrEqual(0);
      expect(hour).toBeLessThan(24);
    }
  });
});
