import { FANTASY_SOURCES, type FantasySource, type StatLine } from "../shared/types.ts";

// Turns a box-score line into fantasy points using a league's Sleeper
// scoring settings (the `scoring_settings` object on the league).
//
// Checked against the owner's league on 2026-11-16: 382 of 416 scores that
// Sleeper credited equal the result of this file to the cent.
//
// Still assumed, because no checked game has shown it either way:
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

/** Which source each scoring setting's points count toward (bonus_* settings are bonuses). */
const SOURCE_OF: Record<string, FantasySource> = {
  pts: "scoring",
  fgm: "scoring",
  fga: "scoring",
  fgmi: "scoring",
  ftm: "scoring",
  fta: "scoring",
  ftmi: "scoring",
  tpm: "threes",
  tpa: "threes",
  tpmi: "threes",
  reb: "boards",
  oreb: "boards",
  dreb: "boards",
  ast: "playmaking",
  stl: "defense",
  blk: "defense",
  dd: "bonuses",
  td: "bonuses",
  to: "mistakes",
  pf: "mistakes",
};

/** A stat line's fantasy points split by where they come from; the parts add up to fantasyPoints. */
export function fantasySources(line: StatLine, settings: Record<string, number>): Record<FantasySource, number> {
  const parts = Object.fromEntries(FANTASY_SOURCES.map((source) => [source, 0])) as Record<FantasySource, number>;
  for (const [setting, weight] of Object.entries(settings)) {
    if (!weight) continue;
    const rule = ruleFor(setting);
    if (!rule) continue;
    parts[SOURCE_OF[setting] ?? (setting.startsWith("bonus_") ? "bonuses" : "scoring")] += rule(line) * weight;
  }
  return parts;
}

/**
 * The season average as Sleeper's app displays it. This is NOT the average
 * of a player's game scores. Sleeper scores a player's season totals, so each
 * threshold bonus (40+ points, 20+ rebounds, ...) is awarded once when the
 * season total passes the threshold, rather than in the games where it was
 * earned. Double-doubles and triple-doubles are still counted per game.
 *
 * Worked out from the owner's league on 2026-11-16: James Harden, 13 games,
 * no bonus games, game scores sum to 415.70 (average 31.98). His season
 * totals pass all four thresholds (+30), and (415.70 + 30) / 13 = 34.28,
 * the number Sleeper shows.
 *
 * Used only to explain the difference to the owner. Analysis uses the true
 * per-game numbers.
 */
export function sleeperDisplayedAverage(
  lines: StatLine[],
  settings: Record<string, number>,
): number {
  const first = lines[0];
  if (!first) return 0;

  const perGame: Record<string, number> = {};
  const thresholds: Record<string, number> = {};
  for (const [setting, weight] of Object.entries(settings)) {
    (bonusRule(setting) ? thresholds : perGame)[setting] = weight;
  }

  const totals = { ...first };
  for (const line of lines.slice(1)) {
    for (const key of Object.keys(totals) as (keyof StatLine)[]) totals[key] += line[key];
  }

  const games = lines.reduce((sum, line) => sum + fantasyPoints(line, perGame), 0);
  return (games + fantasyPoints(totals, thresholds)) / lines.length;
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
