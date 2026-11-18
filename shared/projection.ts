// Rest-of-season projection for one player, and how often he will play.
//
// The projection starts from this season's average and applies a few
// separate adjustments. Each one is limited in how far it can move the
// number, and each is reported with its size, so no single signal can take
// over and every projection can be explained.
//
//   1. Recent games count more. A game 15 games ago counts half as much as
//      the latest one.
//   2. Last season's level. Early in a season a hot or cold start says less
//      than a full season does, so last season counts like 10 extra games.
//      Its pull fades on its own as this season's games pile up.
//   3. Minutes. If his minutes over the last five games are above or below
//      his season norm, his role is changing. Worth at most 8% either way.

const RECENCY_HALF_LIFE = 15;
const LAST_SEASON_WEIGHT = 10;
/** Last season needs this many games to count at full weight. */
const LAST_SEASON_FULL_SAMPLE = 40;
const LAST_SEASON_MIN_GAMES = 10;
const MINUTES_WINDOW = 5;
const MINUTES_MIN_GAMES = 8;
const MINUTES_SHARE = 0.5;
const MINUTES_LIMIT = 0.08;
/** A projection this far from the season average is called rising or fading. */
const TREND_THRESHOLD = 0.04;

export interface ProjectionFactor {
  label: string;
  /** Fantasy points per game this adjustment adds or removes. */
  effect: number;
}

export interface Projection {
  /** Projected fantasy points per game for the rest of the season. */
  perGame: number;
  factors: ProjectionFactor[];
  trend: "rising" | "fading" | "steady";
  lastSeason: { games: number; average: number } | null;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** `scores` and `minutes` are this season's games, oldest first. */
export function projectPlayer(
  scores: number[],
  minutes: number[],
  lastSeason: { games: number; average: number } | null = null,
): Projection {
  const games = scores.length;
  const average = mean(scores);
  const usable = lastSeason && lastSeason.games >= LAST_SEASON_MIN_GAMES ? lastSeason : null;
  if (games === 0) return { perGame: 0, factors: [], trend: "steady", lastSeason: usable };

  const factors: ProjectionFactor[] = [];
  const add = (label: string, effect: number) => {
    if (Math.abs(effect) >= 0.005) factors.push({ label, effect });
  };

  // 1. Recent games count more.
  let weighted = 0;
  let weights = 0;
  scores.forEach((score, index) => {
    const weight = 0.5 ** ((games - 1 - index) / RECENCY_HALF_LIFE);
    weighted += score * weight;
    weights += weight;
  });
  const recent = weighted / weights;
  add("Recent games count more", recent - average);

  // 2. Last season's level.
  let level = recent;
  if (usable) {
    const weight = LAST_SEASON_WEIGHT * Math.min(1, usable.games / LAST_SEASON_FULL_SAMPLE);
    level = (games * recent + weight * usable.average) / (games + weight);
    add("Last season's level", level - recent);
  }

  // 3. Minutes.
  let perGame = level;
  const seasonMinutes = mean(minutes);
  if (games >= MINUTES_MIN_GAMES && seasonMinutes > 0) {
    const change = mean(minutes.slice(-MINUTES_WINDOW)) / seasonMinutes - 1;
    const share = Math.max(-MINUTES_LIMIT, Math.min(MINUTES_LIMIT, change * MINUTES_SHARE));
    perGame = level * (1 + share);
    add(share >= 0 ? "Minutes rising" : "Minutes falling", perGame - level);
  }

  perGame = Math.max(0, perGame);
  const gap = average > 0 ? perGame / average - 1 : 0;
  return {
    perGame,
    factors,
    trend: gap >= TREND_THRESHOLD ? "rising" : gap <= -TREND_THRESHOLD ? "fading" : "steady",
    lastSeason: usable,
  };
}

// ---- How often he will play ------------------------------------------------
//
// A missed game here and there (rest, a minor knock) and a long absence are
// different things. Scattered misses are treated as a rate that will continue.
// A long absence is treated as one event: past ones are over and are not
// held against him, and a current one is expected to last about as long
// again as it already has, which is the best guess without a return date.

/** This many missed games in a row is an absence, not rest. */
export const LONG_ABSENCE_GAMES = 4;
/** With little evidence, assume a typical player: plays 9 games in 10. */
const TYPICAL_PLAY_RATE = 0.9;
const TYPICAL_WEIGHT = 5;

export interface AvailabilityOutlook {
  /** Share of his team's remaining games he is expected to play. */
  rate: number;
  /** The same before any allowance for a long absence still going on: his usual share when fit. */
  playRate: number;
  /** Team games missed in a row up to now. */
  missedStreak: number;
  /** True when the current run of missed games is a long absence. */
  longTermOut: boolean;
}

/** `played` has one entry per game of his team, oldest first. */
export function availabilityOutlook(played: boolean[], remainingGames: number): AvailabilityOutlook {
  let considered = 0; // games outside long absences
  let scatteredMisses = 0;
  let run = 0;
  const closeRun = () => {
    if (run > 0 && run < LONG_ABSENCE_GAMES) {
      considered += run;
      scatteredMisses += run;
    }
    run = 0;
  };
  for (const didPlay of played) {
    if (didPlay) {
      closeRun();
      considered++;
    } else {
      run++;
    }
  }
  const missedStreak = run;
  closeRun();

  const playRate =
    (considered - scatteredMisses + TYPICAL_PLAY_RATE * TYPICAL_WEIGHT) / (considered + TYPICAL_WEIGHT);
  const longTermOut = missedStreak >= LONG_ABSENCE_GAMES;
  const stillOut = longTermOut ? Math.min(1, missedStreak / Math.max(1, remainingGames)) : 0;
  return { rate: playRate * (1 - stillOut), playRate, missedStreak, longTermOut };
}
