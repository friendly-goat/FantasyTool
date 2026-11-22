// Letter grades for drafted players: how each pick turned out.
//
// Rule: every graded player's weekly value now (his lock-in value at his
// projected level, allowing for missed games: `expected` in the strength
// model) is compared with what the players picked around him are worth now:
// the median value of the nearest round of picks (one pick per team), not
// counting him. That is what that part of the draft returned, so a first
// pick is held to what the top of the draft turned into, and a last pick to
// what the end of it did.
//
// The gap is measured in the draft's own typical gap (the median gap, scaled
// to a standard deviation), so a grade means the same share of the draft in
// any league. Grades run F, D, C, B, A, S: C is within GRADE_STEP / 2 of the
// players around him, each letter after that one more GRADE_STEP, and S
// (beyond A) is open-ended, as F is below D. D, C, B and A carry a minus or
// plus for the lower and upper third of their step.
//
// Players left out (injured for a real stretch, whose value counts the games
// they will miss, or with no known value) get no grade and are not part of
// anyone else's comparison.
//
// This is a display label only. Nothing else in the analysis reads it.

/** Width of one letter, in the draft's typical gap. */
export const GRADE_STEP = 0.8;

export const GRADE_LETTERS = ["F", "D", "C", "B", "A", "S"] as const;
export type GradeLetter = (typeof GRADE_LETTERS)[number];

export interface DraftGrade {
  /** His weekly value now. */
  value: number;
  /** Median weekly value now of the nearest round of picks around him. */
  around: number;
  /** value minus around, in the draft's typical gap. */
  gap: number;
  letter: GradeLetter;
  /** The letter with its minus or plus, e.g. "B+". */
  grade: string;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The letter grade for a gap measured in the draft's typical gap. */
export function gradeFor(gap: number): { letter: GradeLetter; grade: string } {
  // C spans -GRADE_STEP/2 to +GRADE_STEP/2; each step up or down is the next letter.
  const steps = (gap + GRADE_STEP / 2) / GRADE_STEP;
  const index = Math.floor(steps) + 2;
  if (index <= 0) return { letter: "F", grade: "F" };
  if (index >= GRADE_LETTERS.length - 1) return { letter: "S", grade: "S" };
  const letter = GRADE_LETTERS[index]!;
  const within = steps - Math.floor(steps);
  return { letter, grade: within < 1 / 3 ? `${letter}-` : within >= 2 / 3 ? `${letter}+` : letter };
}

export function draftGrades(
  picks: { pickNo: number; player: { id: string } }[],
  /** His weekly value now, or null to leave him out (no value, or injured for a real stretch). */
  valueOf: (playerId: string) => number | null,
  roundSize: number,
): Map<number, DraftGrade> {
  const graded = picks
    .map((pick) => ({ pickNo: pick.pickNo, value: valueOf(pick.player.id) }))
    .filter((entry): entry is { pickNo: number; value: number } => entry.value !== null && Number.isFinite(entry.value))
    .sort((a, b) => a.pickNo - b.pickNo);
  const neighbours = Math.max(1, roundSize);
  const grades = new Map<number, DraftGrade>();
  // Too few players to compare anyone with a round of others.
  if (graded.length <= neighbours) return grades;

  const around = graded.map((entry) => {
    const near = graded
      .filter((other) => other !== entry)
      .sort((a, b) => Math.abs(a.pickNo - entry.pickNo) - Math.abs(b.pickNo - entry.pickNo) || a.pickNo - b.pickNo)
      .slice(0, neighbours);
    return median(near.map((other) => other.value));
  });
  const gaps = graded.map((entry, index) => entry.value - around[index]!);
  // The median gap, scaled to a standard deviation, so a few huge hits or busts do not set the scale.
  const typical = 1.4826 * median(gaps.map(Math.abs)) || gaps.reduce((sum, gap) => sum + Math.abs(gap), 0) / gaps.length;
  graded.forEach((entry, index) => {
    const gap = typical > 0 ? gaps[index]! / typical : 0;
    grades.set(entry.pickNo, { value: entry.value, around: around[index]!, gap, ...gradeFor(gap) });
  });
  return grades;
}
