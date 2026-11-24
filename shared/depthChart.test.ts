import { describe, expect, it } from "vitest";
import { depthChart, minutesTone } from "./depthChart.ts";
import { type InjuryNews, newsOutText, outText } from "./injury.ts";
import type { PlayerStats } from "./types.ts";

const player = (id: string, positions: string[], minutes: number, extra: Partial<PlayerStats> = {}): PlayerStats =>
  ({
    id,
    name: `Player ${id}`,
    team: "MEM",
    positions,
    injuryStatus: null,
    games: 10,
    minutes,
    recentMinutes: minutes,
    injury: null,
    ...extra,
  }) as PlayerStats;

describe("depth chart", () => {
  it("puts the players who play most first, each at his thinnest listed position, three at most", () => {
    const players = [
      player("pg1", ["PG"], 33),
      player("g", ["PG", "SG"], 30),
      player("sf", ["SF", "PF"], 31),
      player("pf", ["PF"], 29),
      player("c", ["C"], 28),
      player("pg2", ["PG"], 20),
      player("pg3", ["PG"], 15),
      player("pg4", ["PG"], 12),
      player("other", ["SG"], 36, { team: "LAL" }),
      player("unused", ["C"], 0, { games: 0 }),
    ];
    const rows = Object.fromEntries(depthChart(players, "MEM").map((row) => [row.position, row.players.map((p) => p.id)]));
    expect(rows.PG).toEqual(["pg1", "pg2", "pg3"]);
    expect(rows.SG).toEqual(["g"]);
    expect(rows.SF).toEqual(["sf"]);
    expect(rows.PF).toEqual(["pf"]);
    expect(rows.C).toEqual(["c"]);
  });

  it("orders by recent minutes, so a player whose role grew moves up", () => {
    const rows = depthChart([player("a", ["C"], 30, { recentMinutes: 18 }), player("b", ["C"], 20, { recentMinutes: 27 })], "MEM");
    expect(rows.find((row) => row.position === "C")!.players.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("keeps an injured player with no games when he is on the report", () => {
    const injury = { status: "Out" } as InjuryNews;
    const rows = depthChart([player("hurt", ["SF"], 0, { games: 0, injury, recentMinutes: null })], "MEM");
    expect(rows.find((row) => row.position === "SF")!.players).toHaveLength(1);
  });
});

describe("minutes color", () => {
  it("leaves steady minutes plain, so regulars read cleanly", () => {
    expect(minutesTone(35, 34)).toBeNull();
    expect(minutesTone(31.5, 34)).toBeNull(); // within 10% of a starter's minutes
    expect(minutesTone(null, 20)).toBeNull();
    expect(minutesTone(10, 0)).toBeNull();
  });

  it("goes green for a real rise and red for a real fall, stronger the bigger it is", () => {
    expect(minutesTone(23, 18)).toBeGreaterThanOrEqual(4);
    expect(minutesTone(30, 18)).toBe(6);
    expect(minutesTone(13, 18)).toBeLessThanOrEqual(2);
    expect(minutesTone(5, 18)).toBe(0);
    expect(minutesTone(23, 18)!).toBeLessThan(minutesTone(26, 18)!);
  });
});

describe("how long a player is out", () => {
  it("says weeks, days, or the season, and the report's status for a game or two", () => {
    expect(outText(21, "Out")).toBe("Out 3 weeks");
    expect(outText(5, "Out")).toBe("Out 5 days");
    expect(outText(1, "Day-To-Day")).toBe("Day-To-Day");
    expect(outText("season", "Out")).toBe("Out for season");
    expect(outText(null, null)).toBeNull();
  });

  it("counts from the report's day to the expected return", () => {
    const news = { status: "Out", asOf: "2026-11-23", returnDate: "2026-12-14", seasonOut: false, reevaluation: false } as InjuryNews;
    expect(newsOutText(news)).toMatch(/^Out \d weeks$/);
    expect(newsOutText({ ...news, returnDate: null, seasonOut: true } as InjuryNews)).toBe("Out for season");
    expect(newsOutText(null, "Questionable")).toBe("Questionable");
    // Counted from today, not the report's day: a report from Monday read on Tuesday.
    const paolo = { ...news, asOf: "2026-11-23", returnDate: "2026-11-29" } as InjuryNews;
    expect(newsOutText(paolo)).toBe("Out 6 days");
    expect(newsOutText(paolo, null, "2026-11-24")).toBe("Out 5 days");
  });
});
