import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { rosterPlayers } from "./analysis.ts";
import { teamSituations } from "./insight.ts";
import { buildModel, leagueStrength } from "./strength.ts";
import {
  evaluateThreeTeam,
  findThreeTeamTrades,
  isThreeTeam,
  movesFor,
  type ThreeTeamOffer,
  threeTeamAcceptance,
  threeTeamProblem,
  withThreeTeam,
} from "./threeTeam.ts";
import { acceptance, BIG_LOSS, droppedOnArrival, evaluateTrade, findTrades, likelihood, MIN_GAIN } from "./trade.ts";

describe("three-team trades (against the mock league)", async () => {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  const model = buildModel(snapshot, await service.report(snapshot, players));
  const strengths = leagueStrength(snapshot, model);
  const situations = teamSituations(snapshot, model, strengths);
  const urgency = (rosterId: number) => situations.get(rosterId)?.urgency ?? 0;
  const ids = (rosterId: number) =>
    rosterPlayers(snapshot.teams.find((team) => team.rosterId === rosterId)!)
      .map((player) => model.players.get(player.id)!)
      .filter((player) => player?.games > 0)
      .sort((x, y) => y.expected - x.expected)
      .map((player) => player.id);
  const [a, b, c] = [strengths[0]!.rosterId, strengths[4]!.rosterId, strengths[8]!.rosterId];
  // A triangle: A sends to B, B sends to C, C sends to A, one player each.
  const triangle: ThreeTeamOffer = {
    teams: [a, b, c],
    moves: [
      { playerId: ids(a)[3]!, from: a, to: b },
      { playerId: ids(b)[3]!, from: b, to: c },
      { playerId: ids(c)[3]!, from: c, to: a },
    ],
  };

  it("measures each team exactly as a two-team trade would", () => {
    const result = evaluateThreeTeam(model, snapshot, triangle);
    // A's roster changes as in a straight swap with C (its player for C's), so its side is the same.
    const swap = evaluateTrade(model, snapshot, { teamA: a, teamB: c, aGives: [ids(a)[3]!], bGives: [ids(c)[3]!] });
    const you = result.sides[0];
    expect([you.grade, you.strengthChange, you.teamChange]).toEqual([swap.a.grade, swap.a.strengthChange, swap.a.teamChange]);
    for (const side of result.sides) {
      const { gives, gets } = movesFor(triangle, side.rosterId);
      expect(side.gives.map((player) => player.id)).toEqual(gives);
      expect(side.gets.map((player) => player.id)).toEqual(gets);
      // One for one keeps every roster the same size.
      expect(side.adds.length).toBe(side.drops.length);
    }
  });

  it("needs both other managers: the chance is their two chances multiplied", () => {
    const result = evaluateThreeTeam(model, snapshot, triangle);
    const both = threeTeamAcceptance(result, urgency);
    const one = acceptance(result.sides[1], urgency(b)).chance;
    const two = acceptance(result.sides[2], urgency(c)).chance;
    expect(both.chance).toBeCloseTo(one * two, 10);
    expect(both.each.map((entry) => entry.rosterId)).toEqual([b, c]);
    expect(both.chance).toBeLessThanOrEqual(Math.min(one, two));
  });

  it("says plainly what is wrong with an offer it cannot measure", () => {
    const name = (rosterId: number) => `Team ${rosterId}`;
    expect(threeTeamProblem(triangle, name)).toBeNull();
    expect(threeTeamProblem({ ...triangle, teams: [a, a, c] }, name)).toBe("Choose three different teams.");
    expect(threeTeamProblem({ ...triangle, moves: triangle.moves.slice(0, 1) }, name)).toBe(
      `Team ${c} is not in the trade yet: tick a player to send, or send one there.`,
    );
  });

  it("finds triangles that follow every rule two-team ideas follow, in reasonable time", () => {
    let found = 0;
    for (const strength of strengths.slice(0, 4)) {
      const start = performance.now();
      const ideas = findThreeTeamTrades(model, snapshot, strength.rosterId, situations);
      expect(performance.now() - start).toBeLessThan(8000);
      found += ideas.length;
      for (const idea of ideas) {
        const [you, ...others] = idea.result.sides;
        expect(idea.offer.teams[0]).toBe(strength.rosterId);
        expect(new Set(idea.offer.teams).size).toBe(3);
        // Every team gives and gets, and the two partners trade with each other too: a real triangle.
        for (const side of idea.result.sides) {
          expect(side.gives.length).toBeGreaterThan(0);
          expect(side.gets.length).toBeGreaterThan(0);
        }
        expect(idea.offer.moves.some((move) => move.from !== strength.rosterId && move.to !== strength.rosterId)).toBe(true);
        expect(you.teamChange).toBeGreaterThanOrEqual(MIN_GAIN);
        for (const side of others) expect(side.grade).toBeGreaterThanOrEqual(BIG_LOSS);
        for (const side of idea.result.sides) expect(droppedOnArrival(side)).toBe(false);
        expect(idea.chance).toBeCloseTo(idea.chances[0]!.chance * idea.chances[1]!.chance, 10);
        expect(idea.likelihood).toBe(likelihood(idea.chance));
        expect(idea.story.points.at(-1)).toMatch(/^Needs a yes from both /);
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 120_000);

  it("leaves the two-team ideas exactly as they were when no three-team idea is added", () => {
    for (const strength of strengths.slice(0, 2)) {
      const two = findTrades(model, snapshot, strength.rosterId, situations);
      const mixed = withThreeTeam(two, []);
      expect(mixed.ideas).toEqual(two.ideas);
      expect(mixed.outlook).toBe(two.outlook);
      expect(mixed.bestThreeLeftOut).toBeNull();
    }
  }, 60_000);

  it("ranks both kinds together by the same rules, and notes the best three-team idea left out", () => {
    for (const strength of strengths.slice(0, 3)) {
      const two = findTrades(model, snapshot, strength.rosterId, situations);
      const three = findThreeTeamTrades(model, snapshot, strength.rosterId, situations);
      const mixed = withThreeTeam(two, three);
      const order = ["likely", "possible", "long shot"];
      const bands = mixed.ideas.map((idea) => order.indexOf(idea.likelihood));
      if (mixed.outlook !== "long-shot") expect(bands).toEqual([...bands].sort((x, y) => x - y));
      // No player in more than two ideas, across both kinds.
      const count = new Map<string, number>();
      for (const idea of mixed.ideas) {
        const players = isThreeTeam(idea) ? idea.offer.moves.map((move) => move.playerId) : [...idea.offer.aGives, ...idea.offer.bGives];
        for (const id of players) count.set(id, (count.get(id) ?? 0) + 1);
      }
      expect(Math.max(0, ...count.values())).toBeLessThanOrEqual(2);
      if (mixed.ideas.some(isThreeTeam)) expect(mixed.bestThreeLeftOut).toBeNull();
      else expect(mixed.bestThreeLeftOut).toBe(three[0] ?? null);
    }
  }, 120_000);
});
