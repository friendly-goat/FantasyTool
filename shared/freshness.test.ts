import { describe, expect, it } from "vitest";
import { gamePhase, liveDates } from "./freshness.ts";
import type { NbaGame } from "./types.ts";

const game = (state: NbaGame["state"], startTime: string, date = startTime.slice(0, 10)): NbaGame => ({
  id: startTime,
  date,
  startTime,
  home: "MEM",
  away: "LAL",
  state,
  homeScore: null,
  awayScore: null,
  statusText: null,
});
const now = Date.parse("2026-11-24T01:00:00Z");

describe("game phase", () => {
  it("is live while a game is played, pregame in the run-up to a tip, quiet otherwise", () => {
    expect(gamePhase([game("in_progress", "2026-11-24T00:00:00Z")], now)).toBe("live");
    expect(gamePhase([game("scheduled", "2026-11-24T02:00:00Z")], now)).toBe("pregame");
    expect(gamePhase([game("scheduled", "2026-11-24T05:00:00Z")], now)).toBe("quiet");
    expect(gamePhase([game("final", "2026-11-23T20:00:00Z")], now)).toBe("quiet");
    // Past tip-off with no update yet counts as live.
    expect(gamePhase([game("scheduled", "2026-11-24T00:30:00Z")], now)).toBe("live");
  });

  it("names the days whose box scores are moving, a game just over included", () => {
    expect(
      liveDates(
        [
          game("in_progress", "2026-11-24T00:00:00Z", "2026-11-23"),
          game("final", "2026-11-23T21:45:00Z", "2026-11-23"),
          game("final", "2026-11-22T21:00:00Z", "2026-11-22"),
          game("scheduled", "2026-11-25T00:00:00Z", "2026-11-24"),
        ],
        now,
      ),
    ).toEqual(["2026-11-23"]);
  });
});
