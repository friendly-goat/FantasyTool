import { describe, expect, it } from "vitest";
import { draftGrades, GRADE_STEP, gradeFor } from "./draft.ts";

const pick = (pickNo: number, id: string) => ({ pickNo, player: { id } });
const medianOf = (numbers: number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return (sorted[1]! + sorted[2]!) / 2;
};

describe("gradeFor", () => {
  it("runs F, D, C, B, A, S with a minus or plus for the lower and upper third of D to A", () => {
    expect(gradeFor(0).grade).toBe("C");
    expect(gradeFor(-GRADE_STEP * 0.45).grade).toBe("C-");
    expect(gradeFor(GRADE_STEP * 0.45).grade).toBe("C+");
    expect(gradeFor(GRADE_STEP).grade).toBe("B");
    expect(gradeFor(GRADE_STEP * 0.55).grade).toBe("B-");
    expect(gradeFor(GRADE_STEP * 2).grade).toBe("A");
    expect(gradeFor(GRADE_STEP * 2.45).grade).toBe("A+");
    expect(gradeFor(-GRADE_STEP).grade).toBe("D");
    expect(gradeFor(-GRADE_STEP * 1.45).grade).toBe("D-");
  });

  it("leaves S and F open-ended, with no minus or plus", () => {
    expect(gradeFor(GRADE_STEP * 2.6)).toEqual({ letter: "S", grade: "S" });
    expect(gradeFor(GRADE_STEP * 10)).toEqual({ letter: "S", grade: "S" });
    expect(gradeFor(-GRADE_STEP * 1.6)).toEqual({ letter: "F", grade: "F" });
    expect(gradeFor(-GRADE_STEP * 10)).toEqual({ letter: "F", grade: "F" });
  });
});

describe("draftGrades", () => {
  // Four teams, sixteen picks, values falling steadily with the pick: everyone is about what his
  // part of the draft returned, except a late steal and an early miss.
  const ids = Array.from({ length: 16 }, (_, index) => `p${index + 1}`);
  const values: Record<string, number> = Object.fromEntries(ids.map((id, index) => [id, 50 - index + (index % 2 ? 0.6 : -0.6)]));
  values.p14 = 52; // a late pick worth more than anyone
  values.p3 = 20; // an early pick worth little
  const picks = ids.map((id, index) => pick(index + 1, id));
  const grades = draftGrades(picks, (id) => values[id] ?? null, 4);

  it("grades each pick against the nearest round of picks around him", () => {
    expect(grades.get(14)!.letter).toBe("S");
    expect(grades.get(3)!.letter).toBe("F");
    // The median of picks 12, 13, 15 and 16 (the nearest four, not counting him).
    expect(grades.get(14)!.around).toBeCloseTo(medianOf([values.p12!, values.p13!, values.p15!, values.p16!]));
    for (const pickNo of [6, 7, 8, 9, 10]) expect(["C-", "C", "C+", "B-", "D+"]).toContain(grades.get(pickNo)!.grade);
  });

  it("holds the first pick to what the top of the draft turned into, so a top player grades well", () => {
    expect(grades.get(1)!.value).toBeGreaterThan(grades.get(1)!.around);
    expect(["B", "A", "S"]).toContain(grades.get(1)!.letter);
  });

  it("leaves out players with no value (or injured), from grades and from others' comparisons", () => {
    const without = draftGrades(picks, (id) => (id === "p3" ? null : (values[id] ?? null)), 4);
    expect(without.has(3)).toBe(false);
    // Without the early miss, pick 2 is compared with picks 1, 4, 5 and 6.
    expect(without.get(2)!.around).toBeCloseTo(medianOf([values.p1!, values.p4!, values.p5!, values.p6!]));
  });

  it("grades nobody when there are too few players to compare with a round of others", () => {
    expect(draftGrades(picks.slice(0, 4), (id) => values[id] ?? null, 4).size).toBe(0);
  });

  it("gives everyone a C when every pick is worth the same", () => {
    const flat = draftGrades(picks, () => 30, 4);
    expect([...flat.values()].every((grade) => grade.grade === "C")).toBe(true);
  });
});
