import { describe, expect, it } from "vitest";
import { bestLineup, slotAccepts } from "./analysis.ts";
import { lockInValue } from "./lockin.ts";

describe("lockInValue", () => {
  it("equals the average when only one game is left", () => {
    expect(lockInValue([10, 30], 1)).toBe(20);
  });

  it("rises with more games, because a bad game can be passed over", () => {
    // Two games: lock a 30, pass on a 10 and take the average of the next (20). (20 + 30) / 2
    expect(lockInValue([10, 30], 2)).toBe(25);
    // Three games: pass on a 10 (waiting is worth 25), lock a 30. (25 + 30) / 2
    expect(lockInValue([10, 30], 3)).toBe(27.5);
    expect(lockInValue([10, 30])).toBe(27.5); // a typical week has three games
  });

  it("gains nothing for a player who scores the same every game", () => {
    expect(lockInValue([25, 25, 25], 4)).toBe(25);
  });

  it("values a swingy player above a steady one with the same average", () => {
    expect(lockInValue([10, 50])).toBeGreaterThan(lockInValue([29, 31]));
  });

  it("is zero without games", () => {
    expect(lockInValue([])).toBe(0);
  });
});

describe("slotAccepts", () => {
  it("follows position rules", () => {
    expect(slotAccepts("PG", ["PG", "SG"])).toBe(true);
    expect(slotAccepts("PG", ["SG"])).toBe(false);
    expect(slotAccepts("G", ["SG"])).toBe(true);
    expect(slotAccepts("F", ["C", "PF"])).toBe(true);
    expect(slotAccepts("C", ["PF"])).toBe(false);
    expect(slotAccepts("UTIL", ["C"])).toBe(true);
    expect(slotAccepts("BN", ["C"])).toBe(false);
  });
});

describe("bestLineup", () => {
  const player = (id: string, positions: string[], value: number) => ({ id, positions, value });

  it("finds the best assignment where taking the best player first would fail", () => {
    // Putting the 50 at UTIL first would leave PG to nobody.
    const lineup = bestLineup(
      ["UTIL", "PG", "C"],
      [player("guard", ["PG"], 50), player("center", ["C"], 40), player("wing", ["SF"], 30), player("big", ["C"], 20)],
    );
    expect(lineup).toEqual({ total: 120, playerIds: ["wing", "guard", "center"] });
  });

  it("leaves a slot empty when nobody is eligible", () => {
    expect(bestLineup(["C", "PG"], [player("guard", ["PG"], 30)])).toEqual({
      total: 30,
      playerIds: [null, "guard"],
    });
  });

  it("uses each player once", () => {
    const lineup = bestLineup(["G", "G", "UTIL"], [player("a", ["PG"], 40), player("b", ["SG"], 10)]);
    expect(lineup.total).toBe(50);
    expect(new Set(lineup.playerIds.filter(Boolean)).size).toBe(2);
  });
});
