import { describe, expect, it } from "vitest";
import type { PlayerRef, StatLine } from "../../shared/types.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../mock.ts";
import { buildSnapshot, loadPlayers } from "../snapshot.ts";
import { createBalldontlie, parseMinutes, toGameLine, toScheduledGame } from "./balldontlie.ts";
import { matchPlayers, normalizeName, sameLastName } from "./match.ts";
import { createMockStats } from "./mock.ts";
import type { GameLine, StatsProvider } from "./provider.ts";
import { StatsService } from "./service.ts";
import { playerLog, summarize } from "./summary.ts";

const EMPTY: StatLine = {
  pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0,
  fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0,
};

function gameLine(overrides: Partial<GameLine> & { pts?: number }): GameLine {
  const { pts = 0, ...rest } = overrides;
  return {
    key: `${rest.date ?? "d"}:${rest.playerId ?? "1"}`,
    playerId: "1",
    playerName: "Ada Stone",
    team: "BOS",
    date: "2026-10-21",
    final: true,
    minutes: 30,
    stats: { ...EMPTY, pts },
    ...rest,
  };
}

function sleeper(id: string, name: string, team: string | null): PlayerRef {
  return { id, name, team, positions: [], injuryStatus: null };
}

describe("normalizeName", () => {
  it("removes accents, punctuation and suffixes", () => {
    expect(normalizeName("Luka Dončić")).toBe("luka doncic");
    expect(normalizeName("Jaren Jackson Jr.")).toBe("jaren jackson");
    expect(normalizeName("De'Aaron Fox")).toBe("deaaron fox");
    expect(normalizeName("Shai Gilgeous-Alexander")).toBe("shai gilgeous alexander");
    expect(normalizeName("P.J. Washington")).toBe("pj washington");
  });
});

describe("matchPlayers", () => {
  it("matches by name across formatting differences", () => {
    const lines = [gameLine({ playerId: "77", playerName: "Luka Doncic" })];
    const matches = matchPlayers({ a: sleeper("a", "Luka Dončić", "LAL") }, lines);
    expect(matches.get("a")).toBe("77");
  });

  it("uses the NBA team to separate two players with the same name", () => {
    const lines = [
      gameLine({ playerId: "1", playerName: "Sam Reed", team: "BOS" }),
      gameLine({ playerId: "2", playerName: "Sam Reed", team: "NYK" }),
    ];
    const matches = matchPlayers(
      { a: sleeper("a", "Sam Reed", "NY"), b: sleeper("b", "Sam Reed", "BOS") },
      lines,
    );
    expect(matches.get("a")).toBe("2"); // "NY" and "NYK" are the same team
    expect(matches.get("b")).toBe("1");
  });

  it("gives a stats player to only one Sleeper entry", () => {
    const lines = [gameLine({ playerId: "1", playerName: "Sam Reed", team: "BOS" })];
    const matches = matchPlayers(
      { old: sleeper("old", "Sam Reed", null), current: sleeper("current", "Sam Reed", "BOS") },
      lines,
    );
    expect([...matches.entries()]).toEqual([["current", "1"]]);
  });

  it("matches a nickname to a full first name on the same team", () => {
    const lines = [
      gameLine({ playerId: "1", playerName: "Nicolas Claxton", team: "BKN" }),
      gameLine({ playerId: "2", playerName: "Alexandre Sarr", team: "WAS" }),
    ];
    const matches = matchPlayers(
      { a: sleeper("a", "Nic Claxton", "BKN"), b: sleeper("b", "Alex Sarr", "WAS") },
      lines,
    );
    expect([...matches.entries()].sort()).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("does not guess a nickname across teams, initials, or when two players fit", () => {
    const lines = [
      gameLine({ playerId: "1", playerName: "Nicolas Claxton", team: "BKN" }),
      gameLine({ playerId: "2", playerName: "Jalen Williams", team: "OKC" }),
      gameLine({ playerId: "3", playerName: "Jaylin Williams", team: "OKC" }),
    ];
    const matches = matchPlayers(
      {
        a: sleeper("a", "Nic Claxton", "NYK"), // other team
        b: sleeper("b", "Rob Claxton", "BKN"), // other initial
        c: sleeper("c", "JJ Williams", "OKC"), // two candidates
      },
      lines,
    );
    expect(matches.size).toBe(0);
  });

  it("never gives an already matched stats player to a nickname", () => {
    const lines = [gameLine({ playerId: "2", playerName: "Stephen Curry", team: "GSW" })];
    const matches = matchPlayers(
      { a: sleeper("a", "Stephen Curry", "GSW"), b: sleeper("b", "Steph Curry", "GSW") },
      lines,
    );
    expect([...matches.entries()]).toEqual([["a", "2"]]);
  });

  it("lists stats players with the same last name", () => {
    const lines = [gameLine({ playerId: "1", playerName: "Airious Bailey", team: "UTA" })];
    expect(sameLastName("Ace Bailey", lines)).toEqual([{ name: "Airious Bailey", team: "UTA", games: 1 }]);
    expect(sameLastName("Carmelo Anthony", lines)).toEqual([]);
  });

  it("lets a manual override win", () => {
    const lines = [gameLine({ playerId: "9", playerName: "Nickname Guy" })];
    const matches = matchPlayers({ a: sleeper("a", "Legal Name", "BOS") }, lines, { a: "9" });
    expect(matches.get("a")).toBe("9");
  });
});

describe("summarize", () => {
  const players = { a: sleeper("a", "Ada Stone", "BOS") };
  const matches = new Map([["a", "1"]]);
  const dates = ["2026-10-21", "2026-10-23", "2026-10-25", "2026-10-27", "2026-10-29", "2026-10-31", "2026-11-02"];

  it("averages over games played and reports a recent-games average", () => {
    const lines = dates.map((date, index) => gameLine({ date, pts: (index + 1) * 10 }));
    const stats = summarize(lines, matches, players, { pts: 1 }).a!;
    expect(stats.games).toBe(7);
    expect(stats.fantasyAvg).toBeCloseTo(40); // mean of 10..70
    expect(stats.recentGames).toBe(5);
    expect(stats.recentAvg).toBeCloseTo(50); // mean of 30..70
    expect(stats.averages.pts).toBeCloseTo(40);
    expect(stats.minutes).toBe(30);
  });

  it("leaves out unfinished games and games the player sat out", () => {
    const lines = [
      gameLine({ date: dates[0]!, pts: 20 }),
      gameLine({ date: dates[1]!, pts: 99, final: false }),
      gameLine({ date: dates[2]!, pts: 0, minutes: 0 }),
    ];
    const stats = summarize(lines, matches, players, { pts: 1 }).a!;
    expect(stats.games).toBe(1);
    expect(stats.fantasyAvg).toBe(20);
  });

  it("omits players with no games", () => {
    expect(summarize([], matches, players, { pts: 1 })).toEqual({});
  });

  it("leaves out games played before the season started", () => {
    const lines = [
      gameLine({ date: "2026-10-10", pts: 4 }), // preseason
      gameLine({ date: "2026-10-12", pts: 6 }), // preseason
      gameLine({ date: "2026-10-20", pts: 30 }), // opening night counts
      gameLine({ date: "2026-10-22", pts: 20 }),
    ];
    expect(summarize(lines, matches, players, { pts: 1 }).a!.fantasyAvg).toBe(15); // no start date known
    const stats = summarize(lines, matches, players, { pts: 1 }, "2026-10-20").a!;
    expect(stats.games).toBe(2);
    expect(stats.fantasyAvg).toBe(25);
  });
});

describe("playerLog", () => {
  const player = sleeper("a", "Ada Stone", "BOS");

  it("lists counted games newest first, with fantasy points and opponents", () => {
    const lines = [
      gameLine({ date: "2026-10-10", pts: 4 }),
      gameLine({ date: "2026-10-21", pts: 10, teamId: "2", opponentId: "7", home: true }),
      gameLine({ date: "2026-10-23", pts: 30, teamId: "2", opponentId: "9", opponent: "MIA", home: false }),
      // Another player's line teaches the log that team 7 is "DEN".
      gameLine({ playerId: "55", date: "2026-10-21", team: "DEN", teamId: "7" }),
    ];
    const log = playerLog(player, "1", lines, { pts: 1 }, "2026-10-20");
    expect(log.stats!.games).toBe(2);
    expect(log.games.map((g) => [g.date, g.opponent, g.home, g.fantasyPoints])).toEqual([
      ["2026-10-23", "MIA", false, 30],
      ["2026-10-21", "DEN", true, 10],
    ]);
  });

  it("returns nothing for a player without a match or games", () => {
    expect(playerLog(player, undefined, [], { pts: 1 })).toEqual({ stats: null, games: [] });
  });
});

describe("balldontlie client", () => {
  it("reads minutes in either format", () => {
    expect(parseMinutes("34")).toBe(34);
    expect(parseMinutes("34:30")).toBe(34.5);
    expect(parseMinutes(null)).toBe(0);
    expect(parseMinutes("")).toBe(0);
  });

  it("converts an API row", () => {
    const line = toGameLine({
      min: "31",
      pts: 25,
      reb: 7,
      turnover: 3,
      fg3m: 4,
      player: { id: 15, first_name: "Ada", last_name: "Stone" },
      team: { abbreviation: "BOS" },
      game: { id: 900, date: "2026-10-21T00:00:00.000Z", status: "Final" },
    });
    expect(line).toMatchObject({
      key: "900:15",
      playerId: "15",
      playerName: "Ada Stone",
      team: "BOS",
      date: "2026-10-21",
      final: true,
      minutes: 31,
      stats: { pts: 25, reb: 7, tov: 3, tpm: 4, ast: 0 },
    });
  });

  it("finds the opponent whether teams arrive as IDs or as objects", () => {
    const base = { player: { id: 1 }, team: { id: 10, abbreviation: "BOS" } };
    const byId = toGameLine({
      ...base,
      game: { id: 2, date: "2026-10-21", status: "Final", home_team_id: 10, visitor_team_id: 20 },
    });
    expect(byId).toMatchObject({ teamId: "10", opponentId: "20", opponent: null, home: true });

    const byObject = toGameLine({
      ...base,
      game: {
        id: 3,
        date: "2026-10-23",
        status: "Final",
        home_team: { id: 30, abbreviation: "MIA" },
        visitor_team: { id: 10, abbreviation: "BOS" },
      },
    });
    expect(byObject).toMatchObject({ opponentId: "30", opponent: "MIA", home: false });

    const unknown = toGameLine({ ...base, game: { id: 4, date: "2026-10-25" } });
    expect(unknown).toMatchObject({ opponentId: null, opponent: null, home: null });
  });

  it("marks games in progress as not final and skips rows without a game", () => {
    const row = { player: { id: 1 }, game: { id: 2, date: "2026-10-21", status: "3rd Qtr" } };
    expect(toGameLine(row)!.final).toBe(false);
    expect(toGameLine({ player: { id: 1 } })).toBeNull();
  });

  it("follows the cursor through every page and sends the key", async () => {
    const urls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("test-key");
      const second = url.includes("cursor=100");
      return new Response(
        JSON.stringify({
          data: [{ player: { id: second ? 2 : 1 }, game: { id: 5, date: "2026-10-21", status: "Final" } }],
          meta: { next_cursor: second ? null : 100 },
        }),
      );
    }) as typeof fetch;

    const pages: number[] = [];
    const provider = createBalldontlie("test-key", fakeFetch, 0);
    const lines = await provider.fetchGameLines("2026", "2026-11-01", (n) => pages.push(n));

    expect(lines.map((l) => l.playerId)).toEqual(["1", "2"]);
    expect(pages).toEqual([1, 2]);
    expect(urls[0]).toContain("seasons%5B%5D=2026");
    expect(urls[0]).toContain("start_date=2026-11-01");
    expect(urls[0]).toContain("per_page=100");
  });

  it("explains a rejected key", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const provider = createBalldontlie("bad", fakeFetch, 0);
    await expect(provider.fetchGameLines("2026", null, () => {})).rejects.toThrow(/rejected the API key/);
  });
});

describe("StatsService", async () => {
  const rawPlayers = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);

  it("reports that stats are off when there is no provider", async () => {
    const service = new StatsService(null, { dir: null });
    const report = await service.report(snapshot, players);
    expect(report.status).toBe("unconfigured");
    expect(report.players).toEqual({});
  });

  it("starts a download on first use, then serves stats for rostered players", async () => {
    const service = new StatsService(createMockStats(rawPlayers), { dir: null });
    expect((await service.report(snapshot, players)).status).toBe("syncing");

    await service.sync("2026"); // waits for the download already running
    const report = await service.report(snapshot, players);

    expect(report.status).toBe("ready");
    expect(report.source).toBe("mock");
    expect(report.syncedAt).not.toBeNull();
    const starter = snapshot.teams[0]!.starters[0]!.player!;
    expect(report.players[starter.id]).toMatchObject({ name: starter.name });
    expect(report.players[starter.id]!.fantasyAvg).toBeGreaterThan(0);
    // The mock leaves a few players without games; rostered ones are listed.
    expect(report.unmatchedRostered.length).toBeGreaterThan(0);
    expect(report.unmatchedRostered.length).toBeLessThan(10);
  });

  it("ignores preseason games and serves a player's game log", async () => {
    const service = new StatsService(createMockStats(rawPlayers), { dir: null });
    await service.sync("2026");

    const overview = await service.overview("2026", snapshot.league.seasonStartDate);
    expect(overview.firstDate).toBe("2026-10-10");
    expect(overview.beforeSeasonStart).toBeGreaterThan(0);

    const starter = snapshot.teams[0]!.starters[0]!.player!;
    const detail = (await service.playerDetail(snapshot, players, starter.id))!;
    expect(detail.player.name).toBe(starter.name);
    expect(detail.games.length).toBe(detail.stats!.games);
    expect(detail.games.every((game) => game.date >= "2026-10-20")).toBe(true);
    expect(detail.games[0]!.date > detail.games[detail.games.length - 1]!.date).toBe(true);
    expect(detail.games[0]!.opponent).toMatch(/^[A-Z]{3}$/);

    const report = await service.report(snapshot, players);
    expect(report.players[starter.id]!.fantasyAvg).toBeCloseTo(detail.stats!.fantasyAvg);
    expect(await service.playerDetail(snapshot, players, "no-such-id")).toBeNull();
  });

  it("asks only for recent days on later downloads and merges the result", async () => {
    const requests: (string | null)[] = [];
    let day = 1;
    const provider: StatsProvider = {
      name: "fake",
      async fetchGameLines(_season, fromDate, onPage) {
        requests.push(fromDate);
        onPage(1);
        const date = `2026-11-0${day++}`;
        return [gameLine({ key: `k-${date}`, date, pts: 10 })];
      },
    };
    const service = new StatsService(provider, { dir: null });
    await service.sync("2026");
    await service.sync("2026");
    expect(requests).toEqual([null, "2026-10-30"]); // two days before the latest game

    const report = await service.report(snapshot, { a: sleeper("a", "Ada Stone", "BOS") });
    expect(report.players.a!.games).toBe(2);
  });

  it("records a failed download and keeps answering", async () => {
    const provider: StatsProvider = {
      name: "fake",
      async fetchGameLines() {
        throw new Error("boom");
      },
    };
    const service = new StatsService(provider, { dir: null });
    await service.sync("2026");
    const report = await service.report(snapshot, players);
    expect(report).toMatchObject({ status: "error", message: "boom", players: {} });
  });
});

describe("schedule", () => {
  it("reads balldontlie games in each state", () => {
    const base = { id: 1, date: "2026-11-17", home_team: { abbreviation: "CLE" }, visitor_team: { abbreviation: "CHI" } };
    expect(
      toScheduledGame({ ...base, status: "2026-11-18T00:00:00Z", status_state: "scheduled", period: 0, home_team_score: 0, visitor_team_score: 0 }),
    ).toMatchObject({ state: "scheduled", startTime: "2026-11-18T00:00:00Z", homeScore: null, statusText: null, home: "CLE", away: "CHI" });
    expect(toScheduledGame({ ...base, status: "3rd Qtr", period: 3, home_team_score: 70, visitor_team_score: 66 })).toMatchObject({
      state: "in_progress",
      homeScore: 70,
      statusText: "3rd Qtr",
    });
    expect(
      toScheduledGame({ ...base, status: "Final", datetime: "2026-11-17T23:00:00Z", home_team_score: 110, visitor_team_score: 99 }),
    ).toMatchObject({ state: "final", startTime: "2026-11-17T23:00:00Z", awayScore: 99 });
    expect(toScheduledGame({ date: "2026-11-17" })).toBeNull();
  });

  it("asks for a day either side and keeps only the week's games", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          data: [
            { id: 1, date: "2026-11-15", status: "Final" },
            { id: 2, date: "2026-11-16", status: "Final" },
            { id: 3, date: "2026-11-22", status: "2026-11-23T01:00:00Z" },
            { id: 4, date: "2026-11-23", status: "2026-11-24T01:00:00Z" },
          ],
          meta: { next_cursor: null },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const games = await createBalldontlie("key", fetchImpl, 0).fetchSchedule!("2026-11-16", "2026-11-22");
    expect(games.map((game) => game.id)).toEqual(["2", "3"]);
    expect(urls[0]).toContain("start_date=2026-11-15");
    expect(urls[0]).toContain("end_date=2026-11-23");
    expect(urls[0]).toContain("/games?");
  });
});
