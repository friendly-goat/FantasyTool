import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "./mock.ts";
import {
  buildDraftBoard,
  loadDraftBoard,
  playoffSettings,
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

describe("draft board", () => {
  it("loads the mock league's snake draft with Sleeper-style pick labels", async () => {
    const players = await loadPlayers(fetchFromMock);
    const board = await loadDraftBoard(MOCK_LEAGUE_ID, fetchFromMock, players);
    expect(board).not.toBeNull();
    expect(board!.teams).toBe(10);
    expect(board!.rounds).toBe(13);
    expect(board!.picks).toHaveLength(130);
    expect(board!.slots.every((slot) => slot.rosterId !== null)).toBe(true);
    // Round 2 runs backwards: slot 1 makes the tenth pick of the round.
    const back = board!.picks.find((pick) => pick.round === 2 && pick.slot === 1)!;
    expect(back.pickInRound).toBe(10);
    expect(back.pickNo).toBe(20);
    expect(back.player.name).not.toMatch(/^Player /);
  });

  it("copes with missing fields and unknown players", () => {
    const board = buildDraftBoard(
      { draft_id: "d", type: "snake", settings: { teams: 2 } },
      [
        { player_id: "x", round: 1, draft_slot: 2, metadata: { first_name: "Al", last_name: "Bee", position: "C", team: "LAL" } },
        { player_id: "y", round: 2, draft_slot: 2 },
        { round: 1, draft_slot: 1 },
      ],
      {},
    );
    expect(board.picks.map((pick) => [pick.pickNo, pick.pickInRound])).toEqual([[2, 2], [3, 1]]);
    expect(board.picks[0]!.player).toMatchObject({ name: "Al Bee", team: "LAL", positions: ["C"] });
    expect(board.slots).toEqual([{ slot: 1, rosterId: null }, { slot: 2, rosterId: null }]);
  });

  it("returns null when the league has no draft", async () => {
    expect(await loadDraftBoard("x", async () => [], {})).toBeNull();
  });
});

describe("playoffSettings", () => {
  it("reads the start week and team count", () => {
    expect(playoffSettings({ settings: { playoff_week_start: 22, playoff_teams: 6 } })).toEqual({
      startWeek: 22,
      teams: 6,
    });
  });

  it("returns null when either is missing or nonsense", () => {
    expect(playoffSettings({})).toBeNull();
    expect(playoffSettings({ settings: null })).toBeNull();
    expect(playoffSettings({ settings: { playoff_week_start: 22 } })).toBeNull();
    expect(playoffSettings({ settings: { playoff_week_start: 0, playoff_teams: 6 } })).toBeNull();
    expect(playoffSettings({ settings: { playoff_week_start: 22.5, playoff_teams: 6 } })).toBeNull();
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

describe("past weeks (against the mock league)", async () => {
  const { foulDeductions, slotStatus, teamWeek } = await import("../shared/matchup.ts");
  const { createMockStats } = await import("./stats/mock.ts");
  const { fantasyPoints } = await import("./scoring.ts");
  const { weekRange } = await import("../shared/weeks.ts");
  const players = await loadPlayers(fetchFromMock);
  const rawPlayers = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const league = (await fetchFromMock(`/league/${MOCK_LEAGUE_ID}`)) as Parameters<typeof buildMatchups>[1];

  it("pairs every team once in a finished week, and has nothing after the current week", async () => {
    const raw = (await fetchFromMock(`/league/${MOCK_LEAGUE_ID}/matchups/2`)) as unknown[];
    const matchups = buildMatchups(raw as never, league, players);
    const rosterIds = matchups.flatMap((matchup) => matchup.sides.map((side) => side.rosterId));
    expect(new Set(rosterIds).size).toBe(10);
    expect(matchups.every((matchup) => matchup.sides.length === 2)).toBe(true);
    expect(await fetchFromMock(`/league/${MOCK_LEAGUE_ID}/matchups/9`)).toEqual([]);
  });

  it("tells locked, final and unclear scores apart from that week's box scores", async () => {
    const week = 2;
    const { start, end } = weekRange("2026-10-20", week);
    const raw = (await fetchFromMock(`/league/${MOCK_LEAGUE_ID}/matchups/${week}`)) as unknown[];
    const matchups = buildMatchups(raw as never, league, players);
    const stats = createMockStats(rawPlayers);
    const games = await stats.fetchSchedule!(start, end);
    const allLines = await stats.fetchGameLines("2026", start, () => {});
    const scoring = (league as { scoring_settings?: Record<string, number> }).scoring_settings ?? {};
    const counts: Record<string, number> = {};
    for (const side of matchups.flatMap((matchup) => matchup.sides)) {
      for (const entry of side.starters) {
        if (!entry.player) continue;
        const lines = allLines
          .filter((line) => line.playerId === `p${entry.player!.id}` && line.date <= end)
          .map((line) => ({
            date: line.date,
            points: fantasyPoints(line.stats, scoring),
            minutes: line.minutes,
            final: line.final,
            opponent: line.opponent ?? null,
            home: line.home ?? null,
            stats: line.stats,
          }));
        const nbaGames = games.map((game) => ({ ...game, startTime: game.startTime ?? null }));
        const status = slotStatus(
          entry.points ?? 0,
          teamWeek(nbaGames as never, entry.player.team, lines, true),
          true,
          foulDeductions([scoring.tf ?? 0, scoring.ff ?? 0]),
        );
        expect(status.gamesLeft).toBe(0);
        counts[status.state] = (counts[status.state] ?? 0) + 1;
      }
    }
    expect(counts.locked).toBeGreaterThan(0);
    expect(counts.final).toBeGreaterThan(0);
    expect(counts.unclear).toBeGreaterThan(0);
  });
});

describe("reserveSlots", async () => {
  const { reserveSlots } = await import("./snapshot.ts");
  it("reads Sleeper's reserve_slots setting, and an IR roster position if a league lists one", () => {
    expect(reserveSlots({ roster_positions: ["PG", "BN"], settings: { reserve_slots: 1 } })).toBe(1);
    expect(reserveSlots({ roster_positions: ["PG", "BN", "IR", "IR"] })).toBe(2);
    expect(reserveSlots({ roster_positions: ["PG", "BN"] })).toBe(0);
    expect(reserveSlots({ roster_positions: ["PG", "IR"], settings: { reserve_slots: 0 } })).toBe(1);
  });
});
