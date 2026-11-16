import { describe, expect, it } from "vitest";
import type { PlayerRef, StatLine } from "../../shared/types.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../mock.ts";
import { buildSnapshot, loadPlayers } from "../snapshot.ts";
import { createBalldontlie, parseMinutes, toGameLine } from "./balldontlie.ts";
import { matchPlayers, normalizeName } from "./match.ts";
import { createMockStats } from "./mock.ts";
import type { GameLine, StatsProvider } from "./provider.ts";
import { StatsService } from "./service.ts";
import { summarize } from "./summary.ts";

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
