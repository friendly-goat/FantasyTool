import { describe, expect, it } from "vitest";
import type { StatLine } from "../shared/types.ts";
import { fantasyPoints, fantasySources, ignoredSettings, sleeperDisplayedAverage } from "./scoring.ts";

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

describe("sleeperDisplayedAverage", () => {
  // James Harden's first 13 games of 2026-27, from `npm run check:stats`:
  // points, rebounds, assists, steals, blocks, turnovers.
  const HARDEN = [
    [20, 6, 8, 3, 1, 2], [32, 2, 4, 2, 0, 2], [11, 3, 5, 1, 0, 4], [7, 2, 5, 0, 2, 2],
    [17, 6, 3, 0, 0, 3], [19, 9, 6, 1, 2, 3], [14, 4, 6, 1, 0, 1], [13, 6, 7, 1, 0, 2],
    [24, 5, 4, 0, 0, 3], [16, 2, 6, 1, 0, 2], [19, 5, 9, 2, 0, 3], [12, 8, 7, 0, 2, 4],
    [16, 3, 5, 1, 0, 6],
  ].map(([pts, reb, ast, stl, blk, tov]) => line({ pts, reb, ast, stl, blk, tov }));

  it("reproduces the number Sleeper showed for a real player", () => {
    const trueAverage = HARDEN.reduce((sum, game) => sum + fantasyPoints(game, LEAGUE), 0) / HARDEN.length;
    expect(trueAverage).toBeCloseTo(31.98, 2); // what this app shows
    expect(sleeperDisplayedAverage(HARDEN, LEAGUE)).toBeCloseTo(34.28, 2); // what Sleeper showed
  });

  it("awards only the bonuses that season totals reach", () => {
    // 3 games: 22 points, 23 rebounds, 6 assists in total. Only 20+ rebounds applies.
    const games = [line({ pts: 8, reb: 8, ast: 2 }), line({ pts: 7, reb: 8, ast: 2 }), line({ pts: 7, reb: 7, ast: 2 })];
    const trueAverage = games.reduce((sum, game) => sum + fantasyPoints(game, LEAGUE), 0) / 3;
    expect(sleeperDisplayedAverage(games, LEAGUE)).toBeCloseTo(trueAverage + 10 / 3);
  });

  it("counts a bonus once, however many games earned it", () => {
    const games = [line({ pts: 45 }), line({ pts: 41 })]; // two 40-point games, 86 in total
    expect((fantasyPoints(games[0]!, LEAGUE) + fantasyPoints(games[1]!, LEAGUE)) / 2).toBe(48); // +5 each
    expect(sleeperDisplayedAverage(games, LEAGUE)).toBe(50.5); // 86 + 5 + 10, once
  });

  it("still counts double-doubles game by game", () => {
    const games = [line({ pts: 12, reb: 10 }), line({ pts: 4, reb: 2 })]; // totals stay under every threshold
    expect(sleeperDisplayedAverage(games, LEAGUE)).toBeCloseTo((16 + 12 * 1.2 + 3) / 2);
  });

  it("is zero for a player with no games", () => {
    expect(sleeperDisplayedAverage([], LEAGUE)).toBe(0);
  });
});

describe("fantasySources", () => {
  it("splits a game's points by where they come from, adding up to the total", () => {
    const game = line({ pts: 41, reb: 12, ast: 6, stl: 2, blk: 1, tov: 4, tpm: 5 });
    const parts = fantasySources(game, LEAGUE);
    expect(parts.scoring).toBeCloseTo(41);
    expect(parts.boards).toBeCloseTo(14.4);
    expect(parts.playmaking).toBeCloseTo(9);
    expect(parts.defense).toBeCloseTo(7);
    // Double-double (3) and 40+ points (5).
    expect(parts.bonuses).toBeCloseTo(8);
    expect(parts.mistakes).toBeCloseTo(-4);
    // This league gives nothing for threes.
    expect(parts.threes).toBe(0);
    expect(Object.values(parts).reduce((sum, value) => sum + value, 0)).toBeCloseTo(fantasyPoints(game, LEAGUE));
  });
});
