import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "./mock.ts";
import {
  buildMatchups,
  buildSnapshot,
  buildTeams,
  currentWeek,
  loadPlayers,
  loadUserLeagues,
  trimPlayers,
} from "./snapshot.ts";

describe("buildSnapshot (against the mock league)", async () => {
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players, () => 0);

  it("describes the league", () => {
    expect(snapshot.league).toMatchObject({ id: MOCK_LEAGUE_ID, totalRosters: 10 });
    expect(snapshot.week).toBe(4);
    expect(snapshot.fetchedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("ranks teams by wins, then points scored", () => {
    expect(snapshot.teams).toHaveLength(10);
    expect(snapshot.teams.map((team) => team.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < snapshot.teams.length; i++) {
      const above = snapshot.teams[i - 1]!;
      const below = snapshot.teams[i]!;
      expect(above.wins).toBeGreaterThanOrEqual(below.wins);
      if (above.wins === below.wins) {
        expect(above.pointsFor).toBeGreaterThanOrEqual(below.pointsFor);
      }
    }
  });

  it("splits each roster into starters, bench and reserve with real names", () => {
    const team = snapshot.teams[0]!;
    expect(team.starters).toHaveLength(9);
    expect(team.starters.map((s) => s.slot)).toEqual(["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "UTIL"]);
    expect(team.bench).toHaveLength(3);
    expect(team.reserve).toHaveLength(1);
    expect(team.starters[0]!.player!.name).not.toMatch(/Unknown/);
  });

  it("falls back to a manager-based name when no team name is set", () => {
    expect(snapshot.teams.find((team) => team.managerName === "Sam")!.teamName).toBe("Team Sam");
  });

  it("pairs teams into matchups, each side with its lineup", () => {
    expect(snapshot.matchups).toHaveLength(5);
    for (const matchup of snapshot.matchups) {
      expect(matchup.sides).toHaveLength(2);
      for (const side of matchup.sides) {
        expect(side.starters).toHaveLength(9);
        expect(side.bench).toHaveLength(4);
      }
    }
  });

  it("carries the season start date", () => {
    expect(snapshot.league.seasonStartDate).toBe("2026-10-20");
  });

  it("keeps completed transactions only, newest first", () => {
    expect(snapshot.transactions.map((t) => t.id)).toEqual(["t1", "t2", "t4"]);
  });

  it("assigns traded players and picks to the receiving team", () => {
    const trade = snapshot.transactions[0]!;
    expect(trade.type).toBe("trade");
    const receiver = trade.sides.find((side) => side.rosterId === 2)!;
    expect(receiver.adds).toHaveLength(1);
    expect(receiver.drops).toHaveLength(2);
    expect(receiver.picks).toEqual(["2027 2nd-round pick"]);
  });
});

describe("tolerance for incomplete Sleeper data", () => {
  it("handles rosters with missing fields", () => {
    const teams = buildTeams({}, [{ roster_id: 3 }], [], {});
    expect(teams[0]).toMatchObject({
      rosterId: 3,
      managerName: "No manager",
      wins: 0,
      pointsFor: 0,
      starters: [],
      bench: [],
    });
  });

  it("shows empty lineup slots and unknown players without failing", () => {
    const teams = buildTeams(
      { roster_positions: ["PG", "C", "BN"] },
      [{ roster_id: 1, starters: ["0", "999"], players: ["999"] }],
      [],
      {},
    );
    expect(teams[0]!.starters[0]).toEqual({ slot: "PG", player: null });
    expect(teams[0]!.starters[1]!.player!.name).toBe("Unknown player (999)");
  });

  it("combines whole and decimal points", () => {
    const teams = buildTeams({}, [{ roster_id: 1, settings: { fpts: 1234, fpts_decimal: 56 } }], [], {});
    expect(teams[0]!.pointsFor).toBeCloseTo(1234.56);
  });

  it("skips teams on a bye when pairing matchups", () => {
    const matchups = buildMatchups([
      { roster_id: 1, matchup_id: 1, points: 10 },
      { roster_id: 2, matchup_id: 1, points: 20 },
      { roster_id: 3, matchup_id: null, points: 5 },
    ]);
    expect(matchups).toHaveLength(1);
    expect(matchups[0]!.sides.map((side) => [side.rosterId, side.points])).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it("builds each side's lineup with the points Sleeper credited", () => {
    const players = trimPlayers({
      a: { full_name: "Ada Stone" },
      b: { full_name: "Ben Hale" },
      c: { full_name: "Cy Voss" },
    });
    const [matchup] = buildMatchups(
      [
        {
          roster_id: 1,
          matchup_id: 1,
          points: 31.5,
          starters: ["a", "0", "b"],
          players: ["a", "b", "c"],
          starters_points: [31.5, 0, 0],
          players_points: { a: 31.5, c: 12 },
        },
      ],
      { roster_positions: ["PG", "SG", "C", "BN"] },
      players,
    );
    const side = matchup!.sides[0]!;
    expect(side.starters.map((s) => [s.slot, s.player?.name ?? null, s.points])).toEqual([
      ["PG", "Ada Stone", 31.5],
      ["SG", null, null], // empty slot
      ["C", "Ben Hale", 0], // falls back to starters_points
    ]);
    expect(side.bench.map((s) => [s.slot, s.player?.name, s.points])).toEqual([["BN", "Cy Voss", 12]]);
  });

  it("never reports a week below 1", () => {
    expect(currentWeek({ week: 0 })).toBe(1);
    expect(currentWeek({})).toBe(1);
    expect(currentWeek({ leg: 6 })).toBe(6);
  });

  it("builds a name from parts and ignores junk entries", () => {
    const players = trimPlayers({ a: { first_name: "Ada", last_name: "Stone" }, b: null });
    expect(players).toEqual({
      a: { id: "a", name: "Ada Stone", team: null, positions: [], injuryStatus: null },
    });
  });
});

describe("loadUserLeagues", () => {
  it("lists a user's leagues for the current season", async () => {
    const result = await loadUserLeagues("dana", fetchFromMock);
    expect(result.season).toBe("2026");
    expect(result.leagues).toEqual([
      { id: MOCK_LEAGUE_ID, name: "Sample League (mock data)", season: "2026", totalRosters: 10 },
    ]);
  });
});
