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
  MISSED_RED_SHARE,
  missedStops,
  missedTone,
  seasonLabel,
  seasonOfDate,
  smoothSeason,
} from "./career.ts";
import type { CareerGame, CareerSeason } from "./types.ts";

const season = (year: string, games: number): CareerSeason => ({
  season: year,
  teams: games > 0 ? ["BOS"] : [],
  games,
  missed: 0,
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

  it("gives missed games their slots, runs the line straight across them and colors them", () => {
    // 10 games, then 10 missed, then 10 games: room for all 30 team games.
    const played = gamesOf("2024", [...Array(10).fill(30), ...Array(10).fill(50)]).map((game, index) => ({
      ...game,
      date: `2024-11-${String(index < 10 ? index + 1 : index + 11).padStart(2, "0")}`,
    }));
    const missed = Array.from({ length: 10 }, (_, index) => ({ season: "2024", date: `2024-11-${String(index + 11).padStart(2, "0")}` }));
    const layout = careerLayout([{ ...season("2024", 20), missed: 10 }, season("2025", 40)], played.concat(gamesOf("2025", Array(40).fill(40))), missed);
    expect(layout.spans[0]).toMatchObject({ games: 20, missed: 10 });
    expect(layout.spans[0]!.to).toBeCloseTo(30 / 70);
    const first = layout.line.filter((point) => point.x > 0 && point.x < layout.spans[0]!.to);
    expect(first).toHaveLength(30);
    // Across the absence the line climbs from his form before to his form after.
    const across = first.slice(10, 20).map((point) => point.value!);
    expect(across.every((value, index) => index === 0 || value >= across[index - 1]!)).toBe(true);
    // The middle of the absence is fully missed; his healthy games are not.
    expect(first[15]!.missedShare).toBe(1);
    expect(first[0]!.missedShare).toBe(0);
    expect(layout.line.filter((point) => point.x > layout.spans[0]!.to).every((point) => point.missedShare === 0)).toBe(true);
  });

  it("looks at a short window for a short career, so two seasons still show each stretch", () => {
    const short = careerLayout([season("2025", 80)], gamesOf("2025", Array(80).fill(30)));
    const long = careerLayout(
      Array.from({ length: 15 }, (_, index) => season(String(2010 + index), 80)),
      Array.from({ length: 15 }, (_, index) => gamesOf(String(2010 + index), Array(80).fill(30))).flat(),
    );
    expect(short.missedWindow).toBeLessThan(long.missedWindow);
  });

  it("draws nothing for a player with no games", () => {
    expect(careerLayout([season("2026", 0)], []).spans).toEqual([]);
  });
});

describe("missed games color", () => {
  it("runs from green with no games missed to red at the red share", () => {
    expect(missedTone(0)).toBe(6);
    expect(missedTone(MISSED_RED_SHARE / 2)).toBe(3);
    expect(missedTone(MISSED_RED_SHARE)).toBe(0);
    expect(missedTone(1)).toBe(0);
  });

  it("adds a stop where the color changes and keeps long careers to a few hundred", () => {
    const line = Array.from({ length: 2000 }, (_, index) => ({ x: index / 1999, value: 30, missedShare: index > 1000 && index < 1040 ? 1 : 0 }));
    const stops = missedStops(line);
    expect(stops.length).toBeLessThan(120);
    expect(stops.some((stop) => stop.tone === 0)).toBe(true);
    expect(stops[0]).toEqual({ offset: 0, tone: 6 });
    expect(missedStops([{ x: 0, value: null, missedShare: 0 }])).toEqual([]);
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
