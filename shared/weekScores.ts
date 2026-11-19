// Each finished week's final score per team, worked out from numbers that count
// locked games. Sleeper's weekly matchup feed does not: in lock-in leagues it adds
// up each starter's latest game, and it changes after the week as rosters change.
// The standings do count locks: a team's points for (and against) is the sum of its
// final weekly scores. So:
//
//   - every time the server sees the standings, it notes each team's points for and
//     against under the number of weeks settled so far (the ledger);
//   - a week's score is the change in points for from the week before;
//   - weeks from before the ledger began are taken from scores recorded by hand from
//     Sleeper's app (`RecordedWeek`), checked against the standings.
import type { ScoreHistory, Team } from "./types.ts";

/** Each team's season totals once `weeks` weeks have been settled. */
export interface StandingsMark {
  weeks: number;
  pointsFor: Record<number, number>;
  pointsAgainst: Record<number, number>;
  /** When these totals were last seen (ISO). */
  seenAt: string;
}

export interface StandingsLedger {
  /** Keyed by the number of weeks settled. */
  marks: Record<number, StandingsMark>;
}

/** A finished week's final scores as Sleeper's app shows them, with who played whom. */
export interface RecordedWeek {
  week: number;
  points: Record<number, number>;
  opponent: Record<number, number>;
}

/**
 * A later look at the same settled week may differ by stat corrections. A bigger change means
 * something else moved (totals counting a week in progress, say), so it is not taken.
 */
export const CORRECTION_LIMIT = 15;

/** Points are shown to two decimals; anything closer than this is the same score. */
const SAME = 0.005;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Weeks every team has settled (wins + losses + ties), or null while Sleeper is part way through. */
export function settledWeeks(teams: Team[]): number | null {
  if (teams.length === 0) return null;
  const counts = new Set(teams.map((team) => team.wins + team.losses + team.ties));
  return counts.size === 1 ? [...counts][0]! : null;
}

/**
 * The ledger with the standings as they are now noted down. Returns the same ledger when
 * nothing changed (so the caller knows not to save), or when the change is too big to be a
 * stat correction.
 */
export function noteStandings(ledger: StandingsLedger, teams: Team[], seenAt: string): StandingsLedger {
  const weeks = settledWeeks(teams);
  if (weeks === null) return ledger;
  const pointsFor = Object.fromEntries(teams.map((team) => [team.rosterId, round2(team.pointsFor)]));
  const pointsAgainst = Object.fromEntries(teams.map((team) => [team.rosterId, round2(team.pointsAgainst)]));
  const before = ledger.marks[weeks];
  if (before) {
    const change = teams.map((team) =>
      Math.max(
        Math.abs((before.pointsFor[team.rosterId] ?? 0) - pointsFor[team.rosterId]!),
        Math.abs((before.pointsAgainst[team.rosterId] ?? 0) - pointsAgainst[team.rosterId]!),
      ),
    );
    if (change.every((value) => value < SAME)) return ledger;
    if (change.some((value) => value > CORRECTION_LIMIT)) return ledger;
  }
  return { marks: { ...ledger.marks, [weeks]: { weeks, pointsFor, pointsAgainst, seenAt } } };
}

/**
 * Each week's final score per team, for weeks 1 to `lastWeek`. A recorded week is used as it
 * stands; otherwise a week is known when the totals before and after it are (from the ledger,
 * or added up from the known weeks before). Unknown weeks are left out.
 */
export function weekScores(ledger: StandingsLedger, recorded: RecordedWeek[], lastWeek: number): ScoreHistory {
  const byWeek = new Map(recorded.map((entry) => [entry.week, entry]));
  const rosterIds = new Set<number>();
  for (const mark of Object.values(ledger.marks)) Object.keys(mark.pointsFor).forEach((id) => rosterIds.add(Number(id)));
  for (const entry of recorded) Object.keys(entry.points).forEach((id) => rosterIds.add(Number(id)));

  const weeks: ScoreHistory["weeks"] = [];
  // Each team's season total after each week, where known (0 before week 1).
  const totals = new Map<number, number | null>([...rosterIds].map((id) => [id, 0]));
  for (let week = 1; week <= lastWeek; week++) {
    const entry = byWeek.get(week);
    const mark = ledger.marks[week];
    const points: Record<number, number> = {};
    for (const id of rosterIds) {
      const before = totals.get(id) ?? null;
      const after = mark?.pointsFor[id];
      let score: number | undefined;
      if (entry && typeof entry.points[id] === "number") score = entry.points[id];
      else if (typeof after === "number" && before !== null) score = round2(after - before);
      if (score !== undefined) points[id] = score;
      totals.set(id, typeof after === "number" ? after : before !== null && score !== undefined ? round2(before + score) : null);
    }
    if (Object.keys(points).length > 0) weeks.push({ week, points, source: entry ? "recorded" : "standings" });
  }
  return { weeks };
}

export interface RecordedProblem {
  rosterId: number;
  /** Which total disagrees, what the recorded weeks add up to, and what the standings say. */
  total: "points for" | "points against";
  recorded: number;
  standings: number;
}

/**
 * Recorded weeks 1 to n against the standings after week n: each team's scores must add up to
 * its points for, and its opponents' scores to its points against. Empty when they agree, or
 * when the ledger has no totals for that many weeks yet.
 */
export function checkRecorded(ledger: StandingsLedger, recorded: RecordedWeek[]): RecordedProblem[] {
  const sorted = [...recorded].sort((a, b) => a.week - b.week);
  let run = 0;
  while (sorted[run]?.week === run + 1) run++;
  const mark = ledger.marks[run];
  if (run === 0 || !mark) return [];
  const problems: RecordedProblem[] = [];
  for (const id of Object.keys(mark.pointsFor).map(Number)) {
    const scored = round2(sorted.slice(0, run).reduce((sum, entry) => sum + (entry.points[id] ?? 0), 0));
    const allowed = round2(
      sorted.slice(0, run).reduce((sum, entry) => {
        const opponent = entry.opponent[id];
        return sum + (opponent === undefined ? 0 : (entry.points[opponent] ?? 0));
      }, 0),
    );
    if (Math.abs(scored - mark.pointsFor[id]!) > SAME) problems.push({ rosterId: id, total: "points for", recorded: scored, standings: mark.pointsFor[id]! });
    if (Math.abs(allowed - (mark.pointsAgainst[id] ?? 0)) > SAME)
      problems.push({ rosterId: id, total: "points against", recorded: allowed, standings: mark.pointsAgainst[id] ?? 0 });
  }
  return problems;
}
