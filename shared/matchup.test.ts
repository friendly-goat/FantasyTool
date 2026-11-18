import { describe, expect, it } from "vitest";
import {
  forecastMatchup,
  foulDeductions,
  gameChances,
  injuryKind,
  lockAdvice,
  probablyLocked,
  settledPoints,
  slotStatus,
  stillToPlay,
  teamWeek,
  waitWorth,
  type SimSlot,
} from "./matchup.ts";
import type { NbaGame, WeekLine } from "./types.ts";

const game = (date: string, state: NbaGame["state"], home = "CLE", away = "CHI"): NbaGame => ({
  id: `${date}-${home}`,
  date,
  startTime: `${date}T23:00:00Z`,
  home,
  away,
  state,
  homeScore: null,
  awayScore: null,
  statusText: null,
});
const NO_STATS = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, tpm: 0, tpa: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, pf: 0 };
const line = (date: string, points: number): WeekLine => ({
  date,
  points,
  minutes: 30,
  final: true,
  opponent: "CHI",
  home: true,
  stats: NO_STATS,
});
const deductions = foulDeductions([-2, -3]);

describe("teamWeek", () => {
  it("lists the team's games in order with his box scores, matching team spellings", () => {
    const games = [game("2026-11-18", "scheduled"), game("2026-11-16", "final"), game("2026-11-17", "final", "NYK", "BOS")];
    const week = teamWeek(games, "CLE", [line("2026-11-16", 30)], true);
    expect(week.map((entry) => entry.game.date)).toEqual(["2026-11-16", "2026-11-18"]);
    expect(week[0]!.line?.points).toBe(30);
    expect(week[0]!.opponent).toBe("CHI");
    expect(week[1]!.line).toBeNull();
    expect(teamWeek([game("2026-11-16", "final", "GS", "SA")], "GSW", [], true)).toHaveLength(1);
  });
});

describe("slotStatus", () => {
  const week = (states: NbaGame["state"][], points: (number | null)[]) =>
    states.map((state, index) => {
      const date = `2026-11-${16 + index}`;
      return { game: game(date, state), opponent: "CHI", home: true, line: points[index] != null ? line(date, points[index]!) : null };
    });

  it("calls a score locked when it matches an earlier game", () => {
    const status = slotStatus(40, week(["final", "final", "scheduled"], [40, 25, null]), true, deductions);
    expect(status).toMatchObject({ state: "locked", counted: 0, gamesLeft: 1 });
  });

  it("calls the latest game open while games remain, and final once none do", () => {
    expect(slotStatus(25, week(["final", "final", "scheduled"], [40, 25, null]), true, deductions).state).toBe("open");
    expect(slotStatus(25, week(["final", "final"], [40, 25]), true, deductions).state).toBe("final");
  });

  it("allows for technical and flagrant fouls, which box scores lack", () => {
    expect(slotStatus(38, week(["final", "final", "scheduled"], [40, 25, null]), true, deductions)).toMatchObject({
      state: "locked",
      counted: 0,
    });
  });

  it("leaves nothing to lock after a game he sat out: he is waiting for his next one", () => {
    expect(slotStatus(0, week(["final", "final", "scheduled"], [30, null, null]), true, deductions)).toMatchObject({
      state: "waiting",
      counted: null,
    });
    expect(slotStatus(0, week(["final", "final"], [30, null]), true, deductions).state).toBe("done");
    // An earlier game still counts as locked even if he sat out the latest one.
    expect(slotStatus(30, week(["final", "final", "scheduled"], [30, null, null]), true, deductions).state).toBe("locked");
  });

  it("counts Sleeper's yet-to-play starters and the settled points", () => {
    const statuses = [
      slotStatus(40, week(["final", "final", "scheduled"], [40, 25, null]), true, deductions), // locked
      slotStatus(25, week(["final", "final", "scheduled"], [40, 25, null]), true, deductions), // open
      slotStatus(0, week(["scheduled"], [null]), true, deductions), // waiting
      slotStatus(25, week(["final", "final"], [40, 25]), true, deductions), // final
    ];
    expect(stillToPlay(statuses)).toBe(2);
    expect(settledPoints(statuses, [40, 25, 0, 25])).toBe(65);
  });

  it("knows waiting, live, done and unclear starters", () => {
    expect(slotStatus(0, week(["scheduled", "scheduled"], [null, null]), true, deductions).state).toBe("waiting");
    expect(slotStatus(12, week(["in_progress", "scheduled"], [12, null]), true, deductions).state).toBe("live");
    expect(slotStatus(0, [], true, deductions).state).toBe("done");
    expect(slotStatus(33.3, week(["final", "scheduled"], [20, null]), true, deductions).state).toBe("unclear");
  });

  it("still spots locks without a schedule, but cannot count games left", () => {
    const games = teamWeek([], "CLE", [line("2026-11-16", 40), line("2026-11-17", 25)], false);
    expect(slotStatus(40, games, false, deductions)).toMatchObject({ state: "locked", gamesLeft: null });
    expect(slotStatus(25, games, false, deductions)).toMatchObject({ state: "open", gamesLeft: null });
  });
});

describe("lock advice", () => {
  const player = { waitValue: [0, 30, 36, 40, 43], availability: 1 };

  it("locks when the score beats what waiting should bring", () => {
    expect(lockAdvice(37, 2, player)).toEqual({ lock: true, current: 37, waiting: 36 });
    expect(lockAdvice(35, 2, player).lock).toBe(false);
  });

  it("values waiting less for a player likely to miss games", () => {
    expect(waitWorth(player.waitValue, 0.5, 2)).toBeCloseTo(0.5 * 30 + 0.25 * 36);
    expect(waitWorth(player.waitValue, 1, 0)).toBe(0);
  });
});

describe("injuries", () => {
  it("reads Sleeper's tags", () => {
    expect(injuryKind("OUT")).toBe("out");
    expect(injuryKind("Sus")).toBe("out");
    expect(injuryKind("DTD")).toBe("day-to-day");
    expect(injuryKind("GTD")).toBe("day-to-day");
    expect(injuryKind(null)).toBeNull();
    expect(injuryKind("NA")).toBeNull();
  });

  it("lowers his chance of playing this week's games by fixed amounts", () => {
    expect(gameChances(0.9, 3, null)).toEqual([0.9, 0.9, 0.9]);
    expect(gameChances(0.9, 3, "out")).toEqual([0, 0.45, 0.45]);
    expect(gameChances(1, 2, "day-to-day")).toEqual([0.6, 1]);
  });

  it("makes locking more attractive for a hurt player", () => {
    const player = { waitValue: [0, 30, 36, 40, 43], availability: 1 };
    // One game left: a healthy player is worth waiting for (30), a doubtful one is not (0.6 x 30).
    expect(lockAdvice(29, 1, player).lock).toBe(false);
    expect(lockAdvice(29, 1, player, "day-to-day")).toMatchObject({ lock: true, waiting: 18 });
  });
});

describe("probablyLocked", () => {
  const player = { waitValue: [0, 30, 36, 40, 43], availability: 1 };

  it("expects a manager to have locked a score worth more than waiting", () => {
    expect(probablyLocked("open", 45.6, 2, player)).toBe(true);
    expect(probablyLocked("open", 28.8, 2, player)).toBe(false);
  });

  it("only applies to open scores with games left and known players", () => {
    expect(probablyLocked("locked", 45.6, 2, player)).toBe(false);
    expect(probablyLocked("open", 45.6, 0, player)).toBe(false);
    expect(probablyLocked("open", 45.6, 2, null)).toBe(false);
    expect(probablyLocked("waiting", 0, 2, player)).toBe(false);
  });
});

describe("forecastMatchup", () => {
  const settled = (points: number): SimSlot => ({ state: "locked", points, gamesLeft: 0, player: null });
  const waiting = (projected: number, games: number): SimSlot => ({
    state: "waiting",
    points: 0,
    gamesLeft: games,
    player: { projected, spread: 0.3, availability: 1, waitValue: [0, projected, projected * 1.15, projected * 1.25, projected * 1.3] },
  });

  it("projects an out player well below a healthy one", () => {
    const healthy = forecastMatchup([[waiting(40, 2)], [settled(0)]], 2000);
    const out = forecastMatchup([[{ ...waiting(40, 2), injury: "out" }], [settled(0)]], 2000);
    expect(out.projected[0]).toBeLessThan(healthy.projected[0] * 0.6);
  });

  it("keeps settled scores and is certain when nothing is left to play", () => {
    const forecast = forecastMatchup([[settled(100)], [settled(90)]], 200);
    expect(forecast.projected).toEqual([100, 90]);
    expect(forecast.winChance).toEqual([1, 0]);
  });

  it("favors the side with more to come, and gives the same answer every time", () => {
    const sides: [SimSlot[], SimSlot[]] = [[settled(20), waiting(40, 3)], [settled(30), waiting(25, 2)]];
    const first = forecastMatchup(sides, 2000);
    expect(first.winChance[0]).toBeGreaterThan(0.7);
    expect(first.winChance[0] + first.winChance[1]).toBeCloseTo(1);
    // Choosing the best of three games beats one game's average.
    expect(first.slotProjections[0][1]).toBeGreaterThan(40);
    expect(forecastMatchup(sides, 2000)).toEqual(first);
  });
});
