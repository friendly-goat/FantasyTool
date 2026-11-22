// Letter grades for drafted players: how each pick turned out.
//
// Rule: every graded player is ranked by his lock-in value now (what he locks
// in an average week at his projected level, allowing for missed games:
// `expected` in the strength model; a week's bad games do not count against
// him, only his best one). That rank is where he would go if the draft were
// rerun today. It is compared with where he actually went (both counted among
// the graded players), and the difference is measured in rounds (one pick per
// team): a pick that turned out a round better than where he went is a round
// up. Grades run F, D, C, B, A, S: C is within half a round
// (ROUNDS_PER_GRADE / 2), each letter after that one more ROUNDS_PER_GRADE,
// and S (beyond A) is open-ended, as F is below D. D, C, B and A carry a minus
// or plus for the lower and upper third of their step.
//
// Ranks, not points: the gap in value between the 11th and 12th player is
// several points at the top of a draft and a fraction of a point at the end,
// but either way he went one pick from where he would go now.
//
// An injury is luck, not the pick, so it never sets a grade. A player out for
// a long stretch (LONG_INJURY_WEEKS or more of the weeks left, or the rest of
// the season) gets no grade and is not part of anyone else's comparison; one
// out for a shorter while is graded on his value in the weeks he is back
// (`gradedValue`). Players with no known value are left out too.
//
// This is a display label only. Nothing else in the analysis reads it.

import { expectedOnceBack, type ModelPlayer } from "./strength.ts";

/** Weeks out (of the weeks left) from which a drafted player is left ungraded: about a month. */
export const LONG_INJURY_WEEKS = 4;

/** Out long enough to leave ungraded: LONG_INJURY_WEEKS or more of the weeks left, or the rest of the season. */
export function longInjury(player: Pick<ModelPlayer, "back" | "outShare">): boolean {
  if (!player.back || player.outShare <= 0) return false;
  return player.outShare >= 0.95 || player.outShare * player.back.length >= LONG_INJURY_WEEKS;
}

/**
 * The weekly value a pick is graded on: his value now, or, out for a short while, his value in the
 * weeks he is back. Null for a long injury (no grade).
 */
export function gradedValue(player: ModelPlayer): number | null {
  if (longInjury(player)) return null;
  return player.back && player.outShare > 0 ? expectedOnceBack(player, player) : player.expected;
}

/** Rounds of difference between where he went and where he would go now, per letter. */
export const ROUNDS_PER_GRADE = 1;

export const GRADE_LETTERS = ["F", "D", "C", "B", "A", "S"] as const;
export type GradeLetter = (typeof GRADE_LETTERS)[number];

export interface DraftGrade {
  /** His lock-in value now (`gradedValue`). */
  value: number;
  /** Where he went, among the graded players (1 = first). */
  pickOrder: number;
  /** Where his lock-in value now ranks among the same players (1 = most valuable). */
  valueRank: number;
  /** pickOrder minus valueRank, in rounds: positive means he would go earlier now. */
  rounds: number;
  letter: GradeLetter;
  /** The letter with its minus or plus, e.g. "B+". */
  grade: string;
}

/** The letter grade for how many rounds earlier (positive) or later he would go now. */
export function gradeFor(rounds: number): { letter: GradeLetter; grade: string } {
  // C spans half a step either side of zero; each step up or down is the next letter.
  const steps = rounds / ROUNDS_PER_GRADE + 0.5;
  const index = Math.floor(steps) + 2;
  if (index <= 0) return { letter: "F", grade: "F" };
  if (index >= GRADE_LETTERS.length - 1) return { letter: "S", grade: "S" };
  const letter = GRADE_LETTERS[index]!;
  const within = steps - Math.floor(steps);
  return { letter, grade: within < 1 / 3 ? `${letter}-` : within >= 2 / 3 ? `${letter}+` : letter };
}

export function draftGrades(
  picks: { pickNo: number; player: { id: string } }[],
  /** His lock-in value (`gradedValue`), or null to leave him out (no value, or a long injury). */
  valueOf: (playerId: string) => number | null,
  roundSize: number,
): Map<number, DraftGrade> {
  const graded = picks
    .map((pick) => ({ pickNo: pick.pickNo, value: valueOf(pick.player.id) }))
    .filter((entry): entry is { pickNo: number; value: number } => entry.value !== null && Number.isFinite(entry.value))
    .sort((a, b) => a.pickNo - b.pickNo);
  // Equal values keep draft order, so equal players go where they went.
  const byValue = [...graded].sort((a, b) => b.value - a.value || a.pickNo - b.pickNo);
  const valueRank = new Map(byValue.map((entry, index) => [entry.pickNo, index + 1]));
  const round = Math.max(1, roundSize);
  const grades = new Map<number, DraftGrade>();
  graded.forEach((entry, index) => {
    const pickOrder = index + 1;
    const rank = valueRank.get(entry.pickNo)!;
    const rounds = (pickOrder - rank) / round;
    grades.set(entry.pickNo, { value: entry.value, pickOrder, valueRank: rank, rounds, ...gradeFor(rounds) });
  });
  return grades;
}
