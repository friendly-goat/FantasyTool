import { describe, expect, it } from "vitest";
import { draftGrades, gradedValue, gradeFor, LONG_INJURY_WEEKS, longInjury, ROUNDS_PER_GRADE } from "./draft.ts";
import type { ModelPlayer } from "./strength.ts";

const pick = (pickNo: number, id: string) => ({ pickNo, player: { id } });

describe("gradeFor", () => {
  it("runs F, D, C, B, A, S a round apart, with a minus or plus for the lower and upper third of D to A", () => {
    const step = ROUNDS_PER_GRADE;
    expect(gradeFor(0).grade).toBe("C");
    expect(gradeFor(-step * 0.45).grade).toBe("C-");
    expect(gradeFor(step * 0.45).grade).toBe("C+");
    expect(gradeFor(step).grade).toBe("B");
    expect(gradeFor(step * 0.55).grade).toBe("B-");
    expect(gradeFor(step * 2).grade).toBe("A");
    expect(gradeFor(step * 2.45).grade).toBe("A+");
    expect(gradeFor(-step).grade).toBe("D");
    expect(gradeFor(-step * 1.45).grade).toBe("D-");
  });

  it("leaves S and F open-ended, with no minus or plus", () => {
    expect(gradeFor(ROUNDS_PER_GRADE * 2.6)).toEqual({ letter: "S", grade: "S" });
    expect(gradeFor(ROUNDS_PER_GRADE * 10)).toEqual({ letter: "S", grade: "S" });
    expect(gradeFor(-ROUNDS_PER_GRADE * 1.6)).toEqual({ letter: "F", grade: "F" });
    expect(gradeFor(-ROUNDS_PER_GRADE * 10)).toEqual({ letter: "F", grade: "F" });
  });
});

describe("draftGrades", () => {
  // Four teams, sixteen picks, values falling with the pick, except a few that turned out
  // differently.
  const ids = Array.from({ length: 16 }, (_, index) => `p${index + 1}`);
  const values: Record<string, number> = Object.fromEntries(ids.map((id, index) => [id, 60 - index]));
  values.p14 = 70; // the 14th pick is now the most valuable: 13 picks (3.25 rounds) earlier
  values.p2 = 20; // the 2nd pick is now the least valuable
  values.p5 = 57.5; // the 5th pick now ranks 4th, a pick earlier
  const picks = ids.map((id, index) => pick(index + 1, id));
  const grades = draftGrades(picks, (id) => values[id] ?? null, 4);

  it("grades where he would go now by lock-in value against where he went, in rounds", () => {
    expect(grades.get(14)).toMatchObject({ pickOrder: 14, valueRank: 1, letter: "S" });
    expect(grades.get(14)!.rounds).toBeCloseTo(13 / 4);
    expect(grades.get(2)).toMatchObject({ valueRank: 16, letter: "F" });
    // A pick or two either way is a C.
    expect(grades.get(5)).toMatchObject({ valueRank: 4, letter: "C" });
    expect(grades.get(1)!.letter).toBe("C");
  });

  it("is about ranks, not points: a small gap at the top of the draft is not a big miss", () => {
    // Twelve teams. The top two are far apart in points and swapped: still only a pick each way.
    const top = draftGrades([pick(1, "a"), pick(2, "b"), pick(3, "c"), pick(4, "d")], (id) => ({ a: 50, b: 72, c: 30, d: 29 })[id] ?? null, 12);
    expect(top.get(1)!.grade).toBe("C");
    expect(top.get(2)!.grade).toBe("C");
  });

  it("leaves out players with no value (or a long injury) and ranks the rest among themselves", () => {
    const without = draftGrades(picks, (id) => (id === "p2" ? null : (values[id] ?? null)), 4);
    expect(without.has(2)).toBe(false);
    expect(without.get(3)).toMatchObject({ pickOrder: 2, valueRank: 3 });
  });

  it("breaks value ties by draft order, so equal players go where they went", () => {
    const flat = draftGrades(picks, () => 30, 4);
    expect([...flat.values()].every((grade) => grade.grade === "C" && grade.rounds === 0)).toBe(true);
  });
});

describe("injuries on the draft board", () => {
  const weeks = 20;
  // A player worth 40 a week when he plays, out for `out` weeks of the weeks left.
  const injured = (out: number) => {
    const back = Float32Array.from({ length: weeks }, (_, week) => (week < out ? 0 : 1));
    const weekly = Float32Array.from(back, (chance) => 40 * chance);
    return {
      back,
      outShare: out / weeks,
      weekly,
      expected: weekly.reduce((sum, value) => sum + value, 0) / weeks,
    } as unknown as ModelPlayer;
  };

  it("leaves a player ungraded only when he is out about a month or more", () => {
    expect(longInjury(injured(1))).toBe(false);
    expect(longInjury(injured(LONG_INJURY_WEEKS - 1))).toBe(false);
    expect(longInjury(injured(LONG_INJURY_WEEKS))).toBe(true);
    expect(longInjury(injured(weeks))).toBe(true);
    expect(gradedValue(injured(LONG_INJURY_WEEKS))).toBeNull();
  });

  it("grades a player out for a short while on his value once he is back, not his weeks out", () => {
    const short = injured(2);
    expect(short.expected).toBeCloseTo(36);
    expect(gradedValue(short)).toBeCloseTo(40);
  });

  it("grades a healthy player on his value now", () => {
    const healthy = { back: null, outShare: 0, expected: 33, weekly: Float32Array.of(33) } as unknown as ModelPlayer;
    expect(longInjury(healthy)).toBe(false);
    expect(gradedValue(healthy)).toBe(33);
  });
});
