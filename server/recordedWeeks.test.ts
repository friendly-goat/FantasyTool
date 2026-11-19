import { describe, expect, it } from "vitest";
import type { Team } from "../shared/types.ts";
import { checkRecorded, noteStandings, weekScores } from "../shared/weekScores.ts";
import { RECORDED_WEEKS } from "./recordedWeeks.ts";

// The owner's league standings after week 4, as Sleeper's API reported them on Nov 19, 2026:
// roster ID -> [wins, losses, points for, points against].
const STANDINGS: Record<number, [number, number, number, number]> = {
  1: [3, 1, 1498.6, 1417.99],
  2: [2, 2, 1304.2, 1422.2],
  3: [1, 3, 1349.9, 1479.2],
  4: [2, 2, 1505.4, 1420.8],
  5: [4, 0, 1522, 1347],
  6: [2, 2, 1316.8, 1306.1],
  7: [3, 1, 1540.7, 1345.5],
  8: [1, 3, 1320.1, 1345.1],
  9: [2, 2, 1340.4, 1326.1],
  10: [0, 4, 1332.3, 1500.2],
  11: [3, 1, 1430.1, 1391.3],
  12: [1, 3, 1311.6, 1470.6],
};

const teams: Team[] = Object.entries(STANDINGS).map(([id, [wins, losses, pointsFor, pointsAgainst]]) => ({
  rosterId: Number(id),
  ownerId: null,
  managerName: "",
  teamName: "",
  avatarUrl: null,
  rank: 0,
  wins,
  losses,
  ties: 0,
  pointsFor,
  pointsAgainst,
  starters: [],
  bench: [],
  reserve: [],
}));

describe("the owner's recorded weeks", () => {
  const recorded = RECORDED_WEEKS["1416212537531211776"]!;
  const ledger = noteStandings({ marks: {} }, teams, "2026-11-19");

  it("covers every team in every week, each against one opponent who plays him back", () => {
    expect(recorded.map((entry) => entry.week)).toEqual([1, 2, 3, 4]);
    for (const entry of recorded) {
      expect(Object.keys(entry.points)).toHaveLength(12);
      for (const [id, opponent] of Object.entries(entry.opponent)) expect(entry.opponent[opponent]).toBe(Number(id));
    }
  });

  it("adds up to the standings' points for and against, and gives the same wins and losses", () => {
    expect(checkRecorded(ledger, recorded)).toEqual([]);
    for (const team of teams) {
      const wins = recorded.filter((entry) => entry.points[team.rosterId]! > entry.points[entry.opponent[team.rosterId]!]!).length;
      expect(wins).toBe(team.wins);
    }
  });

  it("is what the history serves for weeks 1 to 4, then the standings take over", () => {
    const history = weekScores(ledger, recorded, 4);
    expect(history.weeks.map((entry) => entry.source)).toEqual(["recorded", "recorded", "recorded", "recorded"]);
    expect(history.weeks.map((entry) => entry.points[7])).toEqual([357.4, 380.6, 354.8, 447.9]);
  });
});
