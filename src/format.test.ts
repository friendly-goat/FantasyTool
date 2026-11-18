import { describe, expect, it } from "vitest";
import { formatStatLine } from "./format.ts";

const empty = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0 };

describe("formatStatLine", () => {
  it("reads like Sleeper's box score line", () => {
    expect(formatStatLine({ ...empty, pts: 6, ast: 3, fgm: 3, fga: 4, tpa: 1, pf: 1 })).toBe("6 PTS, 3 AST, 3/4 FG, 0/1 3PM, 1 PF");
  });

  it("adds minutes when given and says when there is nothing", () => {
    expect(formatStatLine({ ...empty, reb: 2 }, 12.4)).toBe("12 MIN, 2 REB");
    expect(formatStatLine(empty)).toBe("No stats");
  });
});

describe("formatDay", async () => {
  const { formatDay } = await import("./format.ts");
  it("shows the year only when it differs from today's", () => {
    expect(formatDay("2026-12-09", "2026-11-18")).toBe("Dec 9");
    expect(formatDay("2027-01-04", "2026-11-18")).toBe("Jan 4, 2027");
  });
});
