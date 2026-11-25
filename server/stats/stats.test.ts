import { describe, expect, it } from "vitest";
import type { PlayerRef, StatLine } from "../../shared/types.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../mock.ts";
import { buildSnapshot, loadPlayers } from "../snapshot.ts";
import { createBalldontlie, createRequestQueue, parseMinutes, toGameLine, toScheduledGame } from "./balldontlie.ts";
import { matchPlayers, normalizeName, sameLastName } from "./match.ts";
import { createMockStats } from "./mock.ts";
import type { GameLine, StatsProvider } from "./provider.ts";
import { careerSeasons, MAX_CAREER_SEASONS, StatsService, teamLines } from "./service.ts";
import { MemoryStorage } from "../storage.ts";
import { playerLog, pointsAllowed, regularSeasonLines, summarize } from "./summary.ts";

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

describe("pointsAllowed", () => {
  it("rates each team by what its opponents score, against the league, shrunk toward average", () => {
    const lines = [
      // MIA gives up 60 a game over two games; NYK 20 over two; BOS (by ID only) 40 over two.
      gameLine({ playerId: "1", team: "BOS", teamId: "2", opponent: "MIA", date: "2026-10-22", pts: 60 }),
      gameLine({ playerId: "2", team: "BOS", teamId: "2", opponent: "MIA", date: "2026-10-24", pts: 60 }),
      gameLine({ playerId: "3", team: "MIA", teamId: "16", opponent: "NYK", date: "2026-10-22", pts: 20 }),
      gameLine({ playerId: "4", team: "MIA", teamId: "16", opponent: "NYK", date: "2026-10-24", pts: 20 }),
      gameLine({ playerId: "5", team: "NYK", teamId: "20", opponentId: "2", date: "2026-10-22", pts: 40 }),
      gameLine({ playerId: "6", team: "NYK", teamId: "20", opponentId: "2", date: "2026-10-24", pts: 40 }),
      // Not counted: preseason, unfinished, and a game with no minutes.
      gameLine({ playerId: "7", team: "BOS", opponent: "NYK", date: "2026-10-10", pts: 500 }),
      gameLine({ playerId: "8", team: "BOS", opponent: "NYK", date: "2026-10-26", pts: 500, final: false }),
      gameLine({ playerId: "9", team: "BOS", opponent: "NYK", date: "2026-10-27", pts: 500, minutes: 0 }),
    ];
    const allowed = pointsAllowed(lines, { pts: 1 }, "2026-10-20");
    // League average 40 a game; MIA (60·2 + 40·3) / (5·40) = 1.2, NYK (20·2 + 120) / 200 = 0.8.
    expect(allowed.MIA).toBeCloseTo(1.2);
    expect(allowed.NYK).toBeCloseTo(0.8);
    expect(allowed.BOS).toBeCloseTo(1);
  });

  it("is empty without finished games", () => {
    expect(pointsAllowed([], { pts: 1 })).toEqual({});
  });
});

describe("regularSeasonLines", () => {
  it("keeps each team's first 82 game days, leaving out the play-in and playoffs after them", () => {
    const lines: GameLine[] = [];
    for (let day = 0; day < 90; day++) {
      const date = new Date(Date.UTC(2025, 9, 21 + day)).toISOString().slice(0, 10);
      lines.push(gameLine({ key: `b${day}`, date, team: "BOS" }));
      if (day < 82) lines.push(gameLine({ key: `w${day}`, playerId: "2", date, team: "WAS" }));
    }
    const regular = regularSeasonLines(lines);
    expect(regular.filter((line) => line.team === "BOS")).toHaveLength(82);
    expect(regular.filter((line) => line.team === "WAS")).toHaveLength(82);
  });
});

describe("careerSeasons", () => {
  it("runs from this season back to his first, newest first", () => {
    expect(careerSeasons("2026", 17, true, () => true)).toHaveLength(18);
    expect(careerSeasons("2026", 17, true, () => true).at(-1)).toBe("2009");
    expect(careerSeasons("2026", 0, true, () => true)).toEqual(["2026"]);
    expect(careerSeasons("2026", 40, true, () => true)).toHaveLength(MAX_CAREER_SEASONS);
  });

  it("offers only last season without a source for older ones, and without his experience", () => {
    expect(careerSeasons("2026", 10, false, () => true)).toEqual(["2026", "2025"]);
    expect(careerSeasons("2026", undefined, true, () => true)).toEqual(["2026", "2025"]);
    expect(careerSeasons("2026", undefined, true, () => false)).toEqual(["2026"]);
  });
});

describe("teamLines", () => {
  it("gives each finished game of the team a line with no minutes, from its side", () => {
    const game = (id: string, home: string, away: string, state: "final" | "scheduled" = "final") => ({
      id, date: `2015-11-0${id}`, startTime: null, home, away, state, homeScore: null, awayScore: null, statusText: null,
    });
    const lines = teamLines("BOS", [game("1", "BOS", "NYK"), game("2", "MIA", "BOS"), game("3", "LAL", "GSW"), game("4", "BOS", "CHI", "scheduled")]);
    expect(lines.map((line) => [line.date, line.opponent, line.home, line.minutes])).toEqual([
      ["2015-11-01", "NYK", true, 0],
      ["2015-11-02", "MIA", false, 0],
    ]);
    // They mark his team's games without counting as anyone's.
    const played = gameLine({ key: "p1", date: "2015-11-01", pts: 20 });
    const log = playerLog(sleeper("a", "Ada Stone", "BOS"), played.playerId, [played, ...lines], { pts: 1 });
    expect(log.games).toHaveLength(1);
    expect(log.missed.map((missed) => missed.date)).toEqual(["2015-11-02"]);
  });
});

describe("playerLog live game", () => {
  it("shows the game he is playing now, with his numbers so far, apart from the games that count", () => {
    const lines = [
      gameLine({ key: "a", date: "2026-11-20", pts: 20 }),
      gameLine({ key: "b", date: "2026-11-24", pts: 12, final: false, minutes: 18, opponent: "NYK", home: false, status: "3rd Qtr 4:12" }),
    ];
    const log = playerLog(sleeper("x", "Ada Stone", "BOS"), "1", lines, { pts: 1 });
    expect(log.games).toHaveLength(1);
    expect(log.live).toMatchObject({ date: "2026-11-24", opponent: "NYK", home: false, minutes: 18, fantasyPoints: 12, status: "3rd Qtr 4:12" });
    expect(log.stats!.games).toBe(1);
  });

  it("shows no live game before he takes the court, or once it is final", () => {
    const benched = [gameLine({ key: "a", date: "2026-11-20", pts: 20 }), gameLine({ key: "b", date: "2026-11-24", final: false, minutes: 0 })];
    expect(playerLog(sleeper("x", "Ada Stone", "BOS"), "1", benched, { pts: 1 }).live).toBeNull();
    const done = [gameLine({ key: "a", date: "2026-11-20", pts: 20 })];
    expect(playerLog(sleeper("x", "Ada Stone", "BOS"), "1", done, { pts: 1 }).live).toBeNull();
  });

  it("shows a debut in progress even with no finished games yet", () => {
    const debut = [gameLine({ key: "b", date: "2026-11-24", pts: 8, final: false, minutes: 10 })];
    const log = playerLog(sleeper("x", "Ada Stone", "BOS"), "1", debut, { pts: 1 });
    expect(log.stats).toBeNull();
    expect(log.live?.fantasyPoints).toBe(8);
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
    expect(playerLog(player, undefined, [], { pts: 1 })).toEqual({ stats: null, games: [], missed: [], live: null });
  });

  it("lists his team's games he missed, a no-minutes game included, against the team he was on", () => {
    const teammate = (date: string, team: string, opponent: string) =>
      gameLine({ playerId: "9", key: `${date}:9:${team}`, date, team, opponent, home: true });
    const lines = [
      teammate("2026-10-21", "BOS", "NYK"),
      teammate("2026-10-23", "BOS", "MIA"),
      teammate("2026-10-25", "BOS", "PHI"),
      teammate("2026-10-27", "BOS", "TOR"),
      teammate("2026-10-29", "LAL", "DEN"),
      teammate("2026-10-31", "LAL", "PHX"),
      teammate("2026-11-02", "LAL", "SAC"),
      gameLine({ date: "2026-10-21", pts: 10 }),
      gameLine({ date: "2026-10-25", minutes: 0 }), // in uniform, no minutes
      gameLine({ date: "2026-10-31", pts: 20, team: "LAL" }), // traded
    ];
    const log = playerLog(player, "1", lines, { pts: 1 }, "2026-10-20");
    expect(log.missed.map((game) => [game.date, game.opponent])).toEqual([
      ["2026-11-02", "SAC"],
      // Between teams (no trade date) he counts as his old team's until he plays for the new one.
      ["2026-10-27", "TOR"],
      ["2026-10-25", "PHI"],
      ["2026-10-23", "MIA"],
    ]);
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
    const service = new StatsService(null, { storage: null });
    const report = await service.report(snapshot, players);
    expect(report.status).toBe("unconfigured");
    expect(report.players).toEqual({});
  });

  it("starts a download on first use, then serves stats for rostered players", async () => {
    // The download waits until released, so the first report sees it running.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mock = createMockStats(rawPlayers);
    const slow = { ...mock, fetchGameLines: async (...args: Parameters<typeof mock.fetchGameLines>) => (await gate, mock.fetchGameLines(...args)) };
    const service = new StatsService(slow, { storage: null });
    expect((await service.report(snapshot, players)).status).toBe("syncing");

    release();
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

  it("keeps reporting ready, with the same version, while a routine update runs behind data in hand", async () => {
    let calls = 0;
    let release = () => {};
    const mock = createMockStats(rawPlayers);
    const provider = {
      ...mock,
      fetchGameLines: async (...args: Parameters<typeof mock.fetchGameLines>) => {
        calls += 1;
        if (calls > 2) await new Promise<void>((resolve) => (release = resolve));
        return mock.fetchGameLines(...args);
      },
    };
    let now = Date.parse("2026-11-20T12:00:00Z");
    const service = new StatsService(provider, { storage: null, staleMs: 60_000, now: () => now });
    await service.sync("2026");
    await service.sync("2025"); // last season too, so nothing else arrives in between
    const first = await service.report(snapshot, players);
    expect(first.status).toBe("ready");
    expect(first.version).toMatch(/^[0-9a-f]{16}$/);

    now += 2 * 60_000; // stale: the next report starts an update
    const during = await service.report(snapshot, players);
    expect(during.status).toBe("ready");
    expect(during.version).toBe(first.version);
    expect(during.players).toBe(first.players); // worked out once, not again
    release();
  });

  it("ignores preseason games and serves a player's game log", async () => {
    const service = new StatsService(createMockStats(rawPlayers), { storage: null });
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

  it("lists each player's seasons and fetches an older one once, then keeps it", async () => {
    const mock = createMockStats(rawPlayers);
    const calls: string[] = [];
    const provider: StatsProvider = {
      ...mock,
      async fetchPlayerSeason(playerId, season) {
        calls.push(`player ${season}`);
        return mock.fetchPlayerSeason!(playerId, season);
      },
      async fetchTeamSeason(team, season) {
        calls.push(`team ${team.abbreviation} ${season}`);
        return mock.fetchTeamSeason!(team, season);
      },
    };
    const storage = new MemoryStorage();
    const service = new StatsService(provider, { storage });
    await service.sync("2026");
    await service.sync("2025");

    // A veteran: this season back to his first. A rookie: this season only.
    const veteran = Object.values(players).find((player) => (player.yearsExp ?? 0) >= 6 && snapshot.teams.some((team) => team.starters.some((s) => s.player?.id === player.id)))!;
    const detail = (await service.playerDetail(snapshot, players, veteran.id))!;
    expect(detail.seasons).toHaveLength(veteran.yearsExp! + 1);
    expect(detail.seasons![0]).toBe("2026");
    expect(detail.seasons!.at(-1)).toBe(String(2026 - veteran.yearsExp!));
    expect(detail.player).not.toHaveProperty("yearsExp");
    expect(detail.rookie).toBe(false);
    expect(detail.lastSeason?.games).toBeGreaterThan(0);
    const rookie = Object.values(players).find((player) => player.yearsExp === 0)!;
    const rookieDetail = (await service.playerDetail(snapshot, players, rookie.id))!;
    expect(rookieDetail.seasons).toEqual(["2026"]);
    expect(rookieDetail.rookie).toBe(true);

    // Last season comes from the saved box scores: no request for it.
    const last = (await service.playerDetail(snapshot, players, veteran.id, "2025"))!;
    expect(last.season).toBe("2025");
    expect(calls).toEqual([]);

    // An odd year: the sample source sits him four games in a row, which show as missed.
    const old = (await service.playerDetail(snapshot, players, veteran.id, "2023"))!;
    expect(old.season).toBe("2023");
    expect(old.stats!.games).toBeGreaterThan(0);
    expect(old.games.every((game) => game.date.startsWith("2023") || game.date.startsWith("2024"))).toBe(true);
    expect(old.missed).toHaveLength(4);
    expect(calls).toEqual(["player 2023", `team ${veteran.team} 2023`]);

    // Kept in memory, then in storage after a restart: no second fetch.
    await service.playerDetail(snapshot, players, veteran.id, "2023");
    const restarted = new StatsService(provider, { storage });
    await restarted.sync("2026");
    await restarted.sync("2025");
    const again = (await restarted.playerDetail(snapshot, players, veteran.id, "2023"))!;
    expect(again.stats!.games).toBe(old.stats!.games);
    expect(calls).toHaveLength(2);

    // A season outside his career is never fetched.
    const outside = (await service.playerDetail(snapshot, players, veteran.id, "1990"))!;
    expect(outside.stats).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("builds a career in the background, without waiting, and keeps it", async () => {
    const mock = createMockStats(rawPlayers);
    const asked: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: StatsProvider = {
      ...mock,
      async fetchPlayerSeasons(playerId, seasons) {
        asked.push(seasons);
        await gate;
        return mock.fetchPlayerSeasons!(playerId, seasons);
      },
    };
    const storage = new MemoryStorage();
    const service = new StatsService(provider, { storage });
    await service.sync("2026");
    await service.sync("2025");
    const veteran = Object.values(players).find((player) => (player.yearsExp ?? 0) >= 6 && snapshot.teams.some((team) => team.starters.some((s) => s.player?.id === player.id)))!;

    // First ask: older seasons are being fetched (all in one request), the answer does not wait.
    expect((await service.career(snapshot, players, veteran.id))!.status).toBe("loading");
    expect((await service.career(snapshot, players, veteran.id))!.status).toBe("loading");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(veteran.yearsExp! - 1); // all but this season and last
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const career = (await service.career(snapshot, players, veteran.id))!;
    expect(career.status).toBe("ready");
    expect(career.seasons.map((season) => season.season)).toEqual(
      Array.from({ length: veteran.yearsExp! + 1 }, (_, index) => String(2026 - veteran.yearsExp! + index)),
    );
    expect(career.seasons.at(-1)!.current).toBe(true);
    expect(career.games).toHaveLength(career.seasons.reduce((sum, season) => sum + season.games, 0));
    // Odd years: the four games the sample source sits him show as missed, from his team's schedule.
    for (const season of career.seasons.filter((entry) => Number(entry.season) % 2 === 1 && !entry.current && entry.season !== "2025")) {
      expect(season.missed).toBeGreaterThanOrEqual(4);
    }
    expect(career.missed).toHaveLength(career.seasons.reduce((sum, season) => sum + season.missed, 0));
    for (const season of career.seasons.filter((entry) => entry.games > 0)) {
      const points = career.games.filter((game) => game.season === season.season).map((game) => game.points);
      expect(season.fantasyAvg).toBeCloseTo(points.reduce((sum, value) => sum + value, 0) / points.length);
    }

    // Saved for good: a restarted server answers at once, and the season view reuses his games.
    const restarted = new StatsService(provider, { storage });
    await restarted.sync("2026");
    await restarted.sync("2025");
    expect((await restarted.career(snapshot, players, veteran.id))!.status).toBe("ready");
    expect(asked).toHaveLength(1);

    // A rookie's career is this season alone.
    const rookie = Object.values(players).find((player) => player.yearsExp === 0 && snapshot.teams.some((team) => team.starters.some((s) => s.player?.id === player.id)));
    if (rookie) expect((await service.career(snapshot, players, rookie.id))!.seasons.map((season) => season.season)).toEqual(["2026"]);
  });

  it("warms careers in the background, one player a round, then leaves them alone", async () => {
    const mock = createMockStats(rawPlayers);
    let fetches = 0;
    const provider: StatsProvider = {
      ...mock,
      async fetchPlayerSeasons(playerId, seasons) {
        fetches++;
        return mock.fetchPlayerSeasons!(playerId, seasons);
      },
    };
    const service = new StatsService(provider, { storage: new MemoryStorage() });
    await service.sync("2026");
    await service.sync("2025");
    const rostered = snapshot.teams.flatMap((team) => team.starters.flatMap((s) => (s.player ? [s.player.id] : [])));
    const veterans = rostered.filter((id) => (players[id]?.yearsExp ?? 0) >= 4).slice(0, 2);
    const order = [rostered.find((id) => players[id]?.yearsExp === 0) ?? veterans[0]!, ...veterans];

    expect(await service.warmCareers(snapshot, players, order)).toBe(veterans[0]);
    expect((await service.career(snapshot, players, veterans[0]!))!.status).toBe("ready");
    expect(await service.warmCareers(snapshot, players, order)).toBe(veterans[1]);
    expect(await service.warmCareers(snapshot, players, order)).toBeNull();
    expect(fetches).toBe(2);
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
    const service = new StatsService(provider, { storage: null });
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
    const service = new StatsService(provider, { storage: null });
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
    expect(toScheduledGame({ ...base, status: "3rd Qtr", period: 3, time: "4:12", home_team_score: 70, visitor_team_score: 66 })).toMatchObject({
      state: "in_progress",
      homeScore: 70,
      statusText: "3rd Qtr 4:12",
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

describe("balldontlie request queue", () => {
  it("spaces every request apart and lets urgent ones go first", async () => {
    const turn = createRequestQueue(20);
    const order: string[] = [];
    const times: number[] = [];
    const start = Date.now();
    const go = (name: string, urgent: boolean) =>
      turn(urgent).then(() => {
        order.push(name);
        times.push(Date.now() - start);
      });
    // Three background requests queue up, then an urgent one arrives.
    const all = [go("b1", false), go("b2", false), go("b3", false)];
    await new Promise((resolve) => setTimeout(resolve, 5));
    all.push(go("u1", true));
    await Promise.all(all);
    expect(order).toEqual(["b1", "u1", "b2", "b3"]);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(18);
  });

  it("stays under 60 requests a minute at the default spacing", () => {
    // 1100 ms apart: at most 55 in any minute.
    expect(Math.floor(60_000 / 1100) + 1).toBeLessThanOrEqual(60);
  });
});
