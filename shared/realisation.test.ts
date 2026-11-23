import { describe, expect, it } from "vitest";
import { PRIOR_WEEKS, RATE_LIMITS, realisation, STAND_IN_WEIGHT } from "./realisation.ts";
import type { ScoreHistory } from "./types.ts";

const history = (weeks: Record<number, number>[]): ScoreHistory => ({
  weeks: weeks.map((points, index) => ({ week: index + 1, points, source: "recorded" as const })),
});

describe("realisation", () => {
  const current = new Map([
    [1, 400],
    [2, 400],
  ]);

  it("is 1 for everyone before any week has finished", () => {
    const rate = realisation(null, null, current);
    expect(rate.league).toBe(1);
    expect([...rate.teams.values()]).toEqual([1, 1]);
  });

  it("sets real scores against today's projection at half weight, leaning on the league's rate", () => {
    // Team 1 scores 380 a week (95%), team 2 300 (75%): the league 85%.
    const weeks = history([1, 2, 3, 4].map(() => ({ 1: 380, 2: 300 })));
    const rate = realisation(weeks, null, current);
    expect(rate.league).toBeCloseTo(0.85);
    expect(rate.weeks).toBe(4 * STAND_IN_WEIGHT);
    const span = 4 * STAND_IN_WEIGHT;
    expect(rate.teams.get(1)).toBeCloseTo((span * 0.95 + PRIOR_WEEKS * 0.85) / (span + PRIOR_WEEKS));
    // Two weeks of evidence against eight of the league's: a fifth of the way to its own.
    expect(rate.teams.get(1)).toBeCloseTo(0.85 + 0.1 / 5);
    expect(rate.teams.get(2)).toBeCloseTo(0.85 - 0.1 / 5);
  });

  it("prefers the projection saved during the week, at full weight", () => {
    const weeks = history([{ 1: 380, 2: 300 }]);
    const saved = { weeks: { 1: { projected: { 1: 380, 2: 300 }, savedAt: "" } } };
    const rate = realisation(weeks, saved, current);
    expect(rate.league).toBeCloseTo(1);
    expect(rate.weeks).toBe(1);
    expect(rate.teams.get(1)).toBeCloseTo(1);
  });

  it("keeps every rate within its limits", () => {
    const weeks = history(Array.from({ length: 60 }, () => ({ 1: 100, 2: 900 })));
    const rate = realisation(weeks, null, current);
    expect(rate.teams.get(1)).toBe(RATE_LIMITS.low);
    expect(rate.teams.get(2)).toBe(RATE_LIMITS.high);
  });
});
