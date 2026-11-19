import { describe, expect, it } from "vitest";
import type { Team } from "./types.ts";
import { checkRecorded, CORRECTION_LIMIT, noteStandings, settledWeeks, type RecordedWeek, type StandingsLedger, weekScores } from "./weekScores.ts";

function team(rosterId: number, record: [number, number], pointsFor: number, pointsAgainst: number): Team {
  return {
    rosterId,
    ownerId: null,
    managerName: "",
    teamName: `Team ${rosterId}`,
    avatarUrl: null,
    rank: rosterId,
    wins: record[0],
    losses: record[1],
    ties: 0,
    pointsFor,
    pointsAgainst,
    starters: [],
    bench: [],
    reserve: [],
  };
}

// Two teams playing each other every week: 1 scores 100, 110, 120; 2 scores 90, 115, 100.
const after = (weeks: number) => {
  const one = [100, 110, 120].slice(0, weeks).reduce((sum, value) => sum + value, 0);
  const two = [90, 115, 100].slice(0, weeks).reduce((sum, value) => sum + value, 0);
  return [team(1, [weeks, 0], one, two), team(2, [0, weeks], two, one)];
};
const empty: StandingsLedger = { marks: {} };

describe("settled weeks", () => {
  it("counts the weeks every team has settled, or none while Sleeper is part way through", () => {
    expect(settledWeeks(after(2))).toBe(2);
    expect(settledWeeks([after(2)[0]!, after(1)[1]!])).toBeNull();
    expect(settledWeeks([])).toBeNull();
  });
});

describe("noting the standings", () => {
  it("keeps the totals under the weeks settled, and only saves a change", () => {
    const ledger = noteStandings(empty, after(1), "t1");
    expect(ledger.marks[1]).toMatchObject({ weeks: 1, pointsFor: { 1: 100, 2: 90 }, pointsAgainst: { 1: 90, 2: 100 } });
    expect(noteStandings(ledger, after(1), "t2")).toBe(ledger);
  });

  it("takes a stat correction but not a change too big to be one", () => {
    const ledger = noteStandings(empty, after(1), "t1");
    const corrected = noteStandings(ledger, [team(1, [1, 0], 101.5, 90), team(2, [0, 1], 90, 101.5)], "t2");
    expect(corrected.marks[1]!.pointsFor[1]).toBe(101.5);
    const jump = noteStandings(ledger, [team(1, [1, 0], 100 + CORRECTION_LIMIT + 1, 90), team(2, [0, 1], 90, 100)], "t3");
    expect(jump).toBe(ledger);
  });
});

describe("week scores", () => {
  it("is the change in points for between settled weeks", () => {
    let ledger = empty;
    for (const weeks of [1, 2, 3]) ledger = noteStandings(ledger, after(weeks), `t${weeks}`);
    const history = weekScores(ledger, [], 3);
    expect(history.weeks).toEqual([
      { week: 1, points: { 1: 100, 2: 90 }, source: "standings" },
      { week: 2, points: { 1: 110, 2: 115 }, source: "standings" },
      { week: 3, points: { 1: 120, 2: 100 }, source: "standings" },
    ]);
  });

  it("leaves out weeks it cannot split, and fills them from recorded weeks", () => {
    // The ledger began after week 2 had settled.
    let ledger = noteStandings(empty, after(2), "t2");
    ledger = noteStandings(ledger, after(3), "t3");
    expect(weekScores(ledger, [], 3).weeks.map((entry) => entry.week)).toEqual([3]);
    const recorded: RecordedWeek[] = [
      { week: 1, points: { 1: 100, 2: 90 }, opponent: { 1: 2, 2: 1 } },
      { week: 2, points: { 1: 110, 2: 115 }, opponent: { 1: 2, 2: 1 } },
    ];
    const history = weekScores(ledger, recorded, 3);
    expect(history.weeks.map((entry) => [entry.week, entry.source, entry.points[1]])).toEqual([
      [1, "recorded", 100],
      [2, "recorded", 110],
      [3, "standings", 120],
    ]);
  });

  it("adds up recorded weeks when the ledger missed the week before", () => {
    // Recorded weeks 1 and 2, but the standings were only seen after week 3.
    const ledger = noteStandings(empty, after(3), "t3");
    const recorded: RecordedWeek[] = [
      { week: 1, points: { 1: 100, 2: 90 }, opponent: { 1: 2, 2: 1 } },
      { week: 2, points: { 1: 110, 2: 115 }, opponent: { 1: 2, 2: 1 } },
    ];
    expect(weekScores(ledger, recorded, 3).weeks[2]).toEqual({ week: 3, points: { 1: 120, 2: 100 }, source: "standings" });
  });
});

describe("checking recorded weeks", () => {
  const ledger = noteStandings(empty, after(2), "t2");
  const good: RecordedWeek[] = [
    { week: 1, points: { 1: 100, 2: 90 }, opponent: { 1: 2, 2: 1 } },
    { week: 2, points: { 1: 110, 2: 115 }, opponent: { 1: 2, 2: 1 } },
  ];

  it("agrees when every team's weeks add up to its points for and against", () => {
    expect(checkRecorded(ledger, good)).toEqual([]);
  });

  it("names the team and total when a score was misread", () => {
    const misread = [good[0]!, { ...good[1]!, points: { 1: 101, 2: 115 } }];
    expect(checkRecorded(ledger, misread)).toEqual([
      { rosterId: 1, total: "points for", recorded: 201, standings: 210 },
      { rosterId: 2, total: "points against", recorded: 201, standings: 210 },
    ]);
  });

  it("says nothing before the standings for those weeks are known", () => {
    expect(checkRecorded(empty, good)).toEqual([]);
  });
});
