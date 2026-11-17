import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { assignSlots, rosterPlayers } from "./analysis.ts";
import { lockInValues } from "./lockin.ts";
import { buildModel, leagueStrength, projectedWeekly, rosterStrength, strengthScore } from "./strength.ts";
import { evaluateTrade, letterGrade, suggestTrades, tradeGrade } from "./trade.ts";

describe("assignSlots", () => {
  // Reference answer: try every way of filling the slots.
  function bruteForce(eligible: boolean[][], values: number[], slots: number): number {
    const used = new Array(values.length).fill(false);
    const solve = (slot: number): number => {
      if (slot === slots) return 0;
      let best = solve(slot + 1);
      for (let p = 0; p < values.length; p++) {
        if (used[p] || !eligible[p]![slot]) continue;
        used[p] = true;
        best = Math.max(best, values[p]! + solve(slot + 1));
        used[p] = false;
      }
      return best;
    };
    return solve(0);
  }

  it("agrees with trying every lineup, on 300 random rosters", () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 300; round++) {
      const slots = 1 + Math.floor(random() * 5);
      const count = Math.floor(random() * 8);
      const eligible = Array.from({ length: count }, () => Array.from({ length: slots }, () => random() < 0.5));
      const values = Array.from({ length: count }, () => Math.round(random() * 60));
      const result = assignSlots(eligible, values, slots);
      expect(result.total).toBe(bruteForce(eligible, values, slots));
      // The picks are legal, distinct, and add up to the total.
      const chosen = result.picks.filter((index) => index >= 0);
      expect(new Set(chosen).size).toBe(chosen.length);
      result.picks.forEach((index, slot) => index >= 0 && expect(eligible[index]![slot]).toBe(true));
      expect(chosen.reduce((sum, index) => sum + values[index]!, 0)).toBe(result.total);
    }
  });
});

describe("lockInValues", () => {
  it("lists the value for weeks of one to four games", () => {
    expect(lockInValues([10, 30])).toEqual([20, 25, 27.5, 28.75]);
  });
});

describe("trade grades", () => {
  it("is 50 for no change and symmetric around it", () => {
    expect(tradeGrade(0)).toBe(50);
    expect(tradeGrade(4)).toBe(73);
    expect(tradeGrade(-4)).toBe(27);
    expect(tradeGrade(8)).toBe(88);
    expect(tradeGrade(100)).toBe(100);
    expect(tradeGrade(-100)).toBe(1);
  });

  it("maps to letters", () => {
    expect([100, 88, 73, 64, 50, 43, 27, 10].map(letterGrade)).toEqual(["A+", "A", "B+", "B", "C", "C-", "D-", "F"]);
  });
});

describe("team strength and trades (against the mock league)", async () => {
  const rawPlayers = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(rawPlayers), { dir: null });
  await service.sync("2026");
  const report = await service.report(snapshot, players);
  const model = buildModel(snapshot, report);
  const strengths = leagueStrength(snapshot, model);
  const ids = (rosterId: number) =>
    rosterPlayers(snapshot.teams.find((team) => team.rosterId === rosterId)!).map((player) => player.id);

  it("reports how often each player plays", () => {
    for (const stats of Object.values(report.players)) {
      expect(stats.teamGames).toBeGreaterThanOrEqual(stats.games);
      expect(stats.lockInByGames).toHaveLength(4);
      expect(stats.lockInByGames[2]).toBeCloseTo(stats.lockInValue);
    }
  });

  it("scores every team between 1 and 1000, strongest first", () => {
    expect(strengths).toHaveLength(10);
    strengths.forEach((team, index) => {
      expect(team.score).toBeGreaterThanOrEqual(1);
      expect(team.score).toBeLessThanOrEqual(1000);
      expect(team.rank).toBe(index + 1);
      if (index > 0) expect(strengths[index - 1]!.projected).toBeGreaterThanOrEqual(team.projected);
      // Missed games can only cost points, and never more than the whole lineup.
      expect(team.lostToAbsences).toBeGreaterThanOrEqual(-1e-9);
      expect(team.projected).toBeGreaterThan(0);
      expect(team.starterAvailability).toBeGreaterThan(0.5);
      expect(team.starterAvailability).toBeLessThanOrEqual(1);
    });
  });

  it("anchors the scale to the two reference teams", () => {
    expect(strengthScore(model, model.replacementProjection)).toBe(1);
    expect(strengthScore(model, model.idealProjection)).toBe(1000);
    expect(model.idealProjection).toBeGreaterThan(model.replacementProjection);
  });

  it("gives the same answer every time", () => {
    const again = leagueStrength(snapshot, buildModel(snapshot, report));
    expect(again.map((team) => [team.rosterId, team.projected])).toEqual(
      strengths.map((team) => [team.rosterId, team.projected]),
    );
  });

  it("values a roster higher with a strong player added and lower with one removed", () => {
    const roster = ids(strengths[5]!.rosterId);
    const base = rosterStrength(model, roster);
    const best = model.freeAgentIds[0]!;
    expect(rosterStrength(model, [...roster, best]).projected).toBeGreaterThanOrEqual(base.projected);
    const star = roster
      .map((id) => model.players.get(id)!)
      .reduce((a, b) => (b.expected > a.expected ? b : a));
    expect(projectedWeekly(model, roster.filter((id) => id !== star.id))).toBeLessThan(base.projected);
  });

  it("grades a lopsided trade well for one side and badly for the other", () => {
    const [a, b] = [strengths[0]!.rosterId, strengths[9]!.rosterId];
    const byValue = (rosterId: number) =>
      ids(rosterId).map((id) => model.players.get(id)!).sort((x, y) => y.expected - x.expected);
    const star = byValue(a)[0]!;
    const scrub = byValue(b).filter((player) => player.games > 0).at(-1)!;
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [star.id], bGives: [scrub.id] });

    expect(result.a.grade).toBeLessThan(40);
    expect(result.b.grade).toBeGreaterThan(60);
    expect(result.a.strengthChange).toBeLessThan(0);
    expect(result.b.strengthChange).toBeGreaterThan(0);
    expect(result.a.strengthBefore).toBe(strengths[0]!.score);
    expect(result.a.letter).toBe(letterGrade(result.a.grade));
  });

  it("changes nothing when nothing is traded", () => {
    const [a, b] = [strengths[0]!.rosterId, strengths[1]!.rosterId];
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [], bGives: [] });
    expect([result.a.grade, result.a.strengthChange, result.b.grade, result.b.strengthChange]).toEqual([50, 0, 50, 0]);
  });

  it("keeps rosters the same size in an uneven trade", () => {
    const [a, b] = [strengths[2]!.rosterId, strengths[3]!.rosterId];
    const give = ids(a).slice(0, 2);
    const get = ids(b).slice(0, 1);
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: give, bGives: get });
    expect(result.a.adds).toHaveLength(1); // sent two, received one: picks up a free agent
    expect(result.a.drops).toHaveLength(0);
    expect(result.b.drops).toHaveLength(1); // received two, sent one: drops a player
    expect(result.b.adds).toHaveLength(0);
    expect(model.freeAgentIds).toContain(result.a.adds[0]!.id);
  });

  it("suggests only swaps that help the asking team and do not hurt the other", () => {
    const mine = strengths[4]!.rosterId;
    const started = Date.now();
    const ideas = suggestTrades(model, snapshot, mine);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ideas.length).toBeLessThanOrEqual(8);
    for (const { offer, result } of ideas) {
      expect(offer.teamA).toBe(mine);
      expect(result.a.grade).toBeGreaterThan(50);
      expect(result.b.grade).toBeGreaterThanOrEqual(50);
      expect(ids(mine)).toContain(offer.aGives[0]);
      expect(ids(offer.teamB)).toContain(offer.bGives[0]);
    }
  });
});
