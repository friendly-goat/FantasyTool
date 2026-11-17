import { describe, expect, it } from "vitest";
import { draftTrends } from "./draft.ts";

const pick = (pickNo: number, id: string) => ({ pickNo, player: { id } });

describe("draftTrends", () => {
  it("marks players a full round ahead of or behind their draft spot", () => {
    // Four teams, eight picks. Values put pick 8 first and pick 1 sixth.
    const values: Record<string, number> = { a: 30, b: 50, c: 45, d: 40, e: 20, f: 10, g: 5, h: 60 };
    const picks = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id, index) => pick(index + 1, id));
    const trends = draftTrends(picks, (id) => values[id] ?? null, 4);

    expect(trends.get(8)).toEqual({ pickOrder: 8, valueRank: 1, shift: 7, trend: "up" });
    expect(trends.get(1)).toMatchObject({ valueRank: 5, shift: -4, trend: "down" });
    // Picks 2-4 moved by one or two spots: no mark.
    expect(trends.get(2)?.trend).toBeNull();
    expect(trends.get(3)?.trend).toBeNull();
    expect(trends.get(4)?.trend).toBeNull();
  });

  it("leaves out players with no known value and ranks the rest among themselves", () => {
    const values: Record<string, number> = { a: 10, c: 20 };
    const trends = draftTrends([pick(1, "a"), pick(2, "b"), pick(3, "c")], (id) => values[id] ?? null, 1);
    expect(trends.has(2)).toBe(false);
    expect(trends.get(3)).toMatchObject({ pickOrder: 2, valueRank: 1, trend: "up" });
    expect(trends.get(1)).toMatchObject({ pickOrder: 1, valueRank: 2, trend: "down" });
  });

  it("breaks value ties by draft order, so equal players show no mark", () => {
    const trends = draftTrends([pick(1, "a"), pick(2, "b")], () => 10, 1);
    expect(trends.get(1)?.trend).toBeNull();
    expect(trends.get(2)?.trend).toBeNull();
  });
});
