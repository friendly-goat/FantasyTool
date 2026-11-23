// How much of its projection each team really scores. The lock-in simulation
// plays a team as a manager who rotates the bench into every open slot each day
// and locks well, so its weekly totals are what a team can score, not what most
// teams do: in the owner's league the teams scored about 87% of it over weeks
// 1 to 4. The charts on My team show projected points scaled by this rate, for
// each team. Display only: strength, grades and trade ideas keep the model's
// own numbers (a rate would change no ranking there anyway).
//
// For each finished week, a team's real score (shared/weekScores.ts) is set
// against what it was projected to score that week. From the week the server
// began saving projections that is the projection saved during the week; for
// weeks before, today's projection stands in, counted at half weight because
// the roster may have changed since.
//
//   league rate = all real scores / all projections
//   team rate   = (weeks · own rate + PRIOR_WEEKS · league rate) / (weeks + PRIOR_WEEKS)
//
// A week is a noisy measure of a team's rate: real weeks swing about 9% around
// a team's projection (the model itself expects about 8% from the games
// alone), while in weeks 1 to 4 the teams' rates spread by 4.6%, no more than
// that noise gives over four weeks. So a team's own record is weighed against
// PRIOR_WEEKS weeks of the league's (a few percent of real difference between
// managers, against 8 to 9% a week of noise): the four stand-in weeks (two at
// half weight) give its own record a fifth, ten saved weeks half. Both rates are
// kept within RATE_LIMITS.
import type { ScoreHistory } from "./types.ts";

/** A team's rate starts from the league's as if it had this many weeks of its own (see above). */
export const PRIOR_WEEKS = 8;
/** No rate is taken outside this range, however the weeks went. */
export const RATE_LIMITS = { low: 0.7, high: 1.1 } as const;
/** A week compared with today's projection (saved before projections were) counts this much. */
export const STAND_IN_WEIGHT = 0.5;

/** Each team's projected score for a week, saved by the server while the week is played. */
export interface ProjectionLedger {
  weeks: NonNullable<ScoreHistory["projections"]>;
}

export interface Realisation {
  /** All real scores against all projections, within RATE_LIMITS; 1 with no finished weeks. */
  league: number;
  /** Each team's rate, within RATE_LIMITS. */
  teams: Map<number, number>;
  /** Weeks counted (stand-ins at their weight), for saying how much the rate rests on. */
  weeks: number;
}

const clamp = (value: number) => Math.min(RATE_LIMITS.high, Math.max(RATE_LIMITS.low, value));

/**
 * Each team's rate of real scores to projections. `current` is each team's projected weekly
 * score today, the stand-in for weeks with no saved projection.
 */
export function realisation(history: ScoreHistory | null | undefined, saved: ProjectionLedger | null | undefined, current: Map<number, number>): Realisation {
  const pairs = new Map<number, { real: number; projected: number; weeks: number }>();
  let real = 0;
  let projected = 0;
  let weeks = 0;
  for (const entry of history?.weeks ?? []) {
    const week = saved?.weeks[entry.week]?.projected;
    const weight = week ? 1 : STAND_IN_WEIGHT;
    let counted = false;
    for (const [id, score] of Object.entries(entry.points)) {
      const rosterId = Number(id);
      const projection = week?.[rosterId] ?? current.get(rosterId);
      if (!(typeof projection === "number" && projection > 0)) continue;
      const pair = pairs.get(rosterId) ?? { real: 0, projected: 0, weeks: 0 };
      pair.real += weight * score;
      pair.projected += weight * projection;
      pair.weeks += weight;
      pairs.set(rosterId, pair);
      real += weight * score;
      projected += weight * projection;
      counted = true;
    }
    if (counted) weeks += weight;
  }
  const league = projected > 0 ? clamp(real / projected) : 1;
  const teams = new Map<number, number>();
  for (const rosterId of current.keys()) {
    const pair = pairs.get(rosterId);
    const own = pair && pair.projected > 0 ? pair.real / pair.projected : league;
    const span = pair?.weeks ?? 0;
    teams.set(rosterId, clamp((span * own + PRIOR_WEEKS * league) / (span + PRIOR_WEEKS)));
  }
  return { league, teams, weeks };
}
