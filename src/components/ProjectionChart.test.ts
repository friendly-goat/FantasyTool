import { describe, expect, it } from "vitest";
import type { MissedGame, PlayerGame } from "../../shared/types.ts";
import { timeline } from "./ProjectionChart.tsx";

const played = (date: string) => ({ date, fantasyPoints: 30 }) as PlayerGame;
const out = (date: string): MissedGame => ({ date, opponent: null, home: null });
const days = (from: number, count: number) => Array.from({ length: count }, (_, index) => `2026-11-${String(from + index).padStart(2, "0")}`);

describe("the chart's timeline", () => {
  it("gives room to stretches of three missed games or more, and none to a game or two", () => {
    // 2 games, 6 out, 5 games, 2 out (rest), 1 game.
    const games = [...days(1, 2), ...days(9, 5), "2026-11-16"].map(played);
    const missed = [...days(3, 6), ...days(14, 2)].map(out);
    const { slots, trailing } = timeline(games, missed, false);
    expect(slots.map((slot) => slot.kind[0]).join("")).toBe("ggoooooogggggg");
    expect(trailing).toBe(0);
    // Three in a row is the shortest stretch shown; two is not.
    const short = timeline([...days(1, 1), ...days(5, 1), ...days(8, 1)].map(played), [...days(2, 3), ...days(6, 2)].map(out), false);
    expect(short.slots.map((slot) => slot.kind[0]).join("")).toBe("gooogg");
  });

  it("starts the current absence at the first game he has missed since his last, however few", () => {
    const games = days(1, 3).map(played);
    const { slots, trailing } = timeline(games, days(4, 2).map(out), true);
    expect(slots.map((slot) => slot.kind[0]).join("")).toBe("gggoo");
    expect(trailing).toBe(2);
    // Not out now: two missed games at the end are just rest.
    expect(timeline(games, days(4, 2).map(out), false).slots).toHaveLength(3);
    // Several earlier injuries and out now.
    const many = timeline(
      [...days(1, 2), ...days(8, 2), ...days(15, 2)].map(played),
      [...days(3, 5), ...days(10, 5), ...days(17, 1)].map(out),
      true,
    );
    expect(many.slots.map((slot) => slot.kind[0]).join("")).toBe("ggoooooggoooooggo");
    expect(many.trailing).toBe(1);
  });
});
