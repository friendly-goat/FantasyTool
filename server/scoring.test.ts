import { describe, expect, it } from "vitest";
import type { StatLine } from "../shared/types.ts";
import { fantasyPoints, ignoredSettings } from "./scoring.ts";

const EMPTY: StatLine = {
  pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0,
  fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0,
};
const line = (stats: Partial<StatLine>): StatLine => ({ ...EMPTY, ...stats });

// The owner's league settings, from `npm run check:sleeper`.
const LEAGUE = {
  ast: 1.5, blk: 3, bonus_ast_15p: 5, bonus_pt_40p: 5, bonus_pt_50p: 10, bonus_reb_20p: 10,
  dd: 3, ff: -3, pts: 1, reb: 1.2, stl: 2, td: 5, tf: -2, to: -1, tpm: 0,
};

describe("fantasyPoints", () => {
  it("adds up the basic categories", () => {
    // 20 + 6*1.2 + 4*1.5 + 2*2 + 1*3 - 3 = 37.2
    expect(fantasyPoints(line({ pts: 20, reb: 6, ast: 4, stl: 2, blk: 1, tov: 3, tpm: 4 }), LEAGUE)).toBeCloseTo(37.2);
  });

  it("awards a double-double", () => {
    // 22 + 12*1.2 + 3 (dd) = 39.4
    expect(fantasyPoints(line({ pts: 22, reb: 12 }), LEAGUE)).toBeCloseTo(39.4);
  });

  it("awards a triple-double on top of the double-double", () => {
    // 15 + 11*1.2 + 10*1.5 + 3 (dd) + 5 (td) = 51.2
    expect(fantasyPoints(line({ pts: 15, reb: 11, ast: 10 }), LEAGUE)).toBeCloseTo(51.2);
  });

  it("stacks scoring bonuses", () => {
    expect(fantasyPoints(line({ pts: 39 }), LEAGUE)).toBe(39);
    expect(fantasyPoints(line({ pts: 40 }), LEAGUE)).toBe(45);
    expect(fantasyPoints(line({ pts: 50 }), LEAGUE)).toBe(65);
  });

  it("awards rebound and assist bonuses", () => {
    // 20*1.2 + 10 = 34 ; 15*1.5 + 5 = 27.5
    expect(fantasyPoints(line({ reb: 20 }), LEAGUE)).toBeCloseTo(34);
    expect(fantasyPoints(line({ ast: 15 }), LEAGUE)).toBeCloseTo(27.5);
  });

  it("supports missed-shot settings used by other leagues", () => {
    expect(fantasyPoints(line({ fgm: 4, fga: 10, ftm: 3, fta: 5 }), { fgmi: -1, ftmi: -0.5 })).toBe(-7);
  });

  it("ignores settings it has no data for", () => {
    expect(fantasyPoints(line({ pts: 10 }), { pts: 1, tf: -2, something_new: 9 })).toBe(10);
  });
});

describe("ignoredSettings", () => {
  it("lists settings that carry points but cannot be computed", () => {
    expect(ignoredSettings(LEAGUE)).toEqual(["ff", "tf"]);
  });

  it("does not list settings worth zero", () => {
    expect(ignoredSettings({ pts: 1, tf: 0 })).toEqual([]);
  });
});
