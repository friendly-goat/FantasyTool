import { describe, expect, it } from "vitest";
import {
  careerLayout,
  careerScale,
  EMPTY_SEASON_ROOM,
  fittingLabels,
  formWindow,
  FORM_WINDOW_MAX,
  FORM_WINDOW_MIN,
  MIN_SEASON_ROOM,
  seasonLabel,
  seasonOfDate,
  smoothSeason,
} from "./career.ts";
import type { CareerGame, CareerSeason } from "./types.ts";

const season = (year: string, games: number): CareerSeason => ({
  season: year,
  teams: games > 0 ? ["BOS"] : [],
  games,
  fantasyAvg: games > 0 ? 40 : null,
  minutes: games > 0 ? 30 : null,
  averages: null,
  current: false,
});
const gamesOf = (year: string, points: number[]): CareerGame[] =>
  points.map((value, index) => ({ season: year, date: `${year}-11-${String(index + 1).padStart(2, "0")}`, points: value }));

describe("seasonOfDate", () => {
  it("counts September on as the new season, and the 2020 bubble as the season before", () => {
    expect(seasonOfDate("2015-10-28")).toBe("2015");
    expect(seasonOfDate("2016-04-13")).toBe("2015");
    expect(seasonOfDate("2020-08-14")).toBe("2019");
    expect(seasonOfDate("2020-12-22")).toBe("2020");
  });
});

describe("formWindow", () => {
  it("averages more games for a longer career, odd and within its limits", () => {
    expect(formWindow(30)).toBe(FORM_WINDOW_MIN);
    expect(formWindow(300)).toBeGreaterThan(formWindow(94));
    expect(formWindow(5000)).toBe(FORM_WINDOW_MAX);
    for (const games of [0, 94, 300, 1100]) expect(formWindow(games) % 2).toBe(1);
  });
});

describe("smoothSeason", () => {
  it("averages the games around each, fewer at the ends", () => {
    expect(smoothSeason([10, 20, 30, 40, 50], 3)).toEqual([15, 20, 30, 40, 45]);
    expect(smoothSeason([10], 5)).toEqual([10]);
  });
});

describe("careerLayout", () => {
  it("fills the graph left to right for a two-season player", () => {
    const layout = careerLayout(
      [season("2025", 70), season("2026", 12)],
      [...gamesOf("2025", Array.from({ length: 70 }, () => 40)), ...gamesOf("2026", Array.from({ length: 12 }, () => 50))],
    );
    expect(layout.line[0]!.x).toBe(0);
    expect(layout.line.at(-1)!.x).toBe(1);
    expect(layout.spans.map((span) => span.games)).toEqual([70, 12]);
    // The short current season gets the floor's room, not 12 games' worth.
    expect(layout.spans[1]!.to - layout.spans[1]!.from).toBeCloseTo(MIN_SEASON_ROOM / (70 + MIN_SEASON_ROOM));
    expect(layout.spans[1]!.average).toBe(50);
    expect(layout.peak).toBe(50);
  });

  it("gives a long career one span per season, room by games played", () => {
    const seasons = Array.from({ length: 18 }, (_, index) => season(String(2009 + index), index === 5 ? 30 : 80));
    const games = seasons.flatMap((entry) => gamesOf(entry.season, Array.from({ length: entry.games }, () => 45)));
    const layout = careerLayout(seasons, games);
    expect(layout.spans).toHaveLength(18);
    const room = (index: number) => layout.spans[index]!.to - layout.spans[index]!.from;
    expect(room(5) / room(0)).toBeCloseTo(30 / 80);
    expect(layout.line.every((point) => point.value === 45)).toBe(true);
  });

  it("leaves off empty seasons before his first game and breaks the line at one after it", () => {
    const layout = careerLayout(
      [season("2021", 0), season("2022", 60), season("2023", 0), season("2024", 60)],
      [...gamesOf("2022", Array(60).fill(30)), ...gamesOf("2024", Array(60).fill(35))],
    );
    expect(layout.spans.map((span) => span.season)).toEqual(["2022", "2023", "2024"]);
    expect(layout.spans[1]!.average).toBeNull();
    expect(layout.spans[1]!.to - layout.spans[1]!.from).toBeCloseTo(EMPTY_SEASON_ROOM / (120 + EMPTY_SEASON_ROOM));
    expect(layout.line.some((point) => point.value === null)).toBe(true);
  });

  it("draws nothing for a player with no games", () => {
    expect(careerLayout([season("2026", 0)], []).spans).toEqual([]);
  });
});

describe("career graph axis", () => {
  it("rounds the scale up to three or four steps", () => {
    expect(careerScale(52)).toEqual({ top: 60, step: 20 });
    expect(careerScale(30)).toEqual({ top: 40, step: 10 });
    expect(careerScale(0).top).toBeGreaterThanOrEqual(10);
  });

  it("keeps the newest season's label and every older one that fits", () => {
    expect(fittingLabels([10, 30, 50, 70, 90], 40)).toEqual([true, false, true, false, true]);
    expect(fittingLabels([10, 100], 40)).toEqual([true, true]);
  });

  it("names seasons in three lengths", () => {
    expect(seasonLabel("2009", "full")).toBe("2009-10");
    expect(seasonLabel("2009", "short")).toBe("09-10");
    expect(seasonLabel("2009", "year")).toBe("’09");
  });
});
