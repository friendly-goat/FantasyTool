import type { StatLine } from "../shared/types.ts";

// Turns a box-score line into fantasy points using a league's Sleeper
// scoring settings (the `scoring_settings` object on the league).
//
// Assumptions, to be confirmed against Sleeper's own weekly totals:
// - Bonuses stack: a 50-point game earns both the 40+ and the 50+ bonus.
// - A triple-double also earns the double-double bonus.
// Both live in this file only, so they are easy to change.

type Rule = (line: StatLine) => number;

const DOUBLE_CATEGORIES = ["pts", "reb", "ast", "stl", "blk"] as const;

function doubleDigitCategories(line: StatLine): number {
  return DOUBLE_CATEGORIES.filter((category) => line[category] >= 10).length;
}

/** Sleeper setting name -> how many times it applies to a stat line. */
const RULES: Record<string, Rule> = {
  pts: (line) => line.pts,
  reb: (line) => line.reb,
  ast: (line) => line.ast,
  stl: (line) => line.stl,
  blk: (line) => line.blk,
  to: (line) => line.tov,
  tpm: (line) => line.tpm,
  tpa: (line) => line.tpa,
  tpmi: (line) => line.tpa - line.tpm,
  fgm: (line) => line.fgm,
  fga: (line) => line.fga,
  fgmi: (line) => line.fga - line.fgm,
  ftm: (line) => line.ftm,
  fta: (line) => line.fta,
  ftmi: (line) => line.fta - line.ftm,
  oreb: (line) => line.oreb,
  dreb: (line) => line.dreb,
  pf: (line) => line.pf,
  dd: (line) => (doubleDigitCategories(line) >= 2 ? 1 : 0),
  td: (line) => (doubleDigitCategories(line) >= 3 ? 1 : 0),
};

const BONUS_STATS: Record<string, keyof StatLine> = {
  pt: "pts",
  reb: "reb",
  ast: "ast",
  stl: "stl",
  blk: "blk",
};

/** Handles settings such as bonus_pt_40p ("40 or more points in a game"). */
function bonusRule(setting: string): Rule | null {
  const match = setting.match(/^bonus_([a-z]+)_(\d+)p$/);
  if (!match) return null;
  const stat = BONUS_STATS[match[1]!];
  if (!stat) return null;
  const threshold = Number(match[2]);
  return (line) => (line[stat] >= threshold ? 1 : 0);
}

function ruleFor(setting: string): Rule | null {
  return RULES[setting] ?? bonusRule(setting);
}

export function fantasyPoints(line: StatLine, settings: Record<string, number>): number {
  let total = 0;
  for (const [setting, weight] of Object.entries(settings)) {
    if (!weight) continue;
    const rule = ruleFor(setting);
    if (rule) total += rule(line) * weight;
  }
  return total;
}

/**
 * Settings that carry points in this league but cannot be computed from a
 * box score (for example technical and flagrant fouls).
 */
export function ignoredSettings(settings: Record<string, number>): string[] {
  return Object.entries(settings)
    .filter(([setting, weight]) => weight !== 0 && !ruleFor(setting))
    .map(([setting]) => setting)
    .sort();
}
