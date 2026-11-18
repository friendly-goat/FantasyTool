import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats, mockInjuries } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { rosterPlayers } from "./analysis.ts";
import { teamSituations } from "./insight.ts";
import { buildModel, fillRoster, leagueStrength, type ModelPlayer, projectedWeekly } from "./strength.ts";
import { acceptance, evaluateTrade, findTrades, isInjuredTarget, seenAverage, tradePhases } from "./trade.ts";

describe("injuries, IR and waiver pickups (against the mock league)", async () => {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  await service.sync("2025");
  const healthy = buildModel(snapshot, await service.report(snapshot, players));
  const model = buildModel(snapshot, await service.report(snapshot, players, mockInjuries(raw)));
  const strengths = leagueStrength(snapshot, model);
  const situations = teamSituations(snapshot, model, strengths);
  const all = [...model.players.values()];
  const named = (description: RegExp) => {
    const entry = mockInjuries(raw).find((injury) => description.test(injury.description))!;
    return all.find((player) => player.name === entry.playerName)!;
  };
  const teamOf = (player: ModelPlayer) =>
    snapshot.teams.find((team) => rosterPlayers(team).some((ref) => ref.id === player.id))!;
  const ids = (rosterId: number) =>
    rosterPlayers(snapshot.teams.find((team) => team.rosterId === rosterId)!).map((player) => player.id);

  it("counts an injured player for the weeks he is back, and keeps everyone else as they were", () => {
    const reevaluated = named(/re-evaluated/);
    expect(reevaluated.back).not.toBeNull();
    expect(reevaluated.back![0]).toBe(0);
    expect(reevaluated.back![reevaluated.back!.length - 1]).toBe(1);
    expect(reevaluated.outShare).toBeGreaterThan(0.1);
    expect(reevaluated.expected).toBeLessThan(healthy.players.get(reevaluated.id)!.expected * (1 - reevaluated.outShare / 2));

    const season = named(/for the season/);
    expect(season.outShare).toBe(1);
    expect(season.expected).toBe(0);
    expect(season.returnExpected).toBe("season");

    // Same imaginary weeks for a player the report does not name.
    const fit = all.find((player) => !player.back && player.games > 5)!;
    expect(Array.from(fit.gameDay)).toEqual(Array.from(healthy.players.get(fit.id)!.gameDay));
    expect(model.calendar.weeks.length).toBeGreaterThan(0);
  });

  it("puts a player marked out on IR and has a free agent stand in only while he is out", () => {
    const injured = named(/six weeks/);
    const team = teamOf(injured);
    const filled = fillRoster(model, ids(team.rosterId));
    expect(filled.reserve.length).toBeLessThanOrEqual(model.rosterLimits.reserve);
    const active = filled.ids.filter((id) => !id.includes("~") && !filled.reserve.some((p) => p.id === id));
    expect(active.length).toBeLessThanOrEqual(model.rosterLimits.active);
    expect(filled.reserve.map((p) => p.id)).toContain(injured.id);
    for (const add of filled.adds.filter((pickup) => pickup.forInjured)) {
      const standInId = `${add.player.id}~${add.forInjured!.id}`;
      expect(filled.ids).toContain(standInId);
      expect(model.extra.get(standInId)!.expected).toBeCloseTo(add.player.expected * add.forInjured!.outShare);
    }
  });

  it("credits a trade only with the roster spots it opens", () => {
    // Swap two healthy bench players between teams: any IR stand-in each team
    // already had is in both its before and after rosters, so it is not a trade pickup.
    const [a, b] = [strengths[0]!.rosterId, strengths[1]!.rosterId];
    const benchOf = (rosterId: number) =>
      ids(rosterId).map((id) => model.players.get(id)!).filter((p) => !p.back && p.games > 0).sort((x, y) => x.expected - y.expected)[0]!;
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [benchOf(a).id], bGives: [benchOf(b).id] });
    expect(result.a.pickups).toHaveLength(0);
    expect(result.b.pickups).toHaveLength(0);
    // Sending two for one opens a spot that stays open: a lasting pickup.
    const two = ids(a).map((id) => model.players.get(id)!).filter((p) => !p.back && p.games > 0).slice(0, 2);
    const twoForOne = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: two.map((p) => p.id), bGives: [benchOf(b).id] });
    expect(twoForOne.a.pickups.some((pickup) => pickup.forInjured === null)).toBe(true);
  });

  it("splits a trade for an injured player into the weeks he is out and the weeks after", () => {
    const idea = strengths
      .flatMap(({ rosterId }) => findTrades(model, snapshot, rosterId, situations, { getInjured: true }).ideas)
      .find((candidate) => tradePhases(model, candidate.result.a))!;
    const phases = tradePhases(model, idea.result.a)!;
    expect(idea.result.a.gets.map((player) => player.id)).toContain(phases.player.id);
    expect(phases.weeksOut).toBeGreaterThan(0);
    // He gives you nothing until he is back, then his full level.
    expect(phases.afterBack).toBeGreaterThan(phases.whileOut);
    // The whole-season change is the weeks blended.
    const weeks = model.calendar.weeks.length;
    const blended = (phases.whileOut * phases.weeksOut + phases.afterBack * (weeks - phases.weeksOut)) / weeks;
    expect(blended).toBeCloseTo(idea.result.a.teamChange, 0);
  }, 30_000);

  it("makes an injured player look worth less to the manager weighing a trade, within a limit", () => {
    const injured = named(/six weeks/);
    expect(seenAverage(injured)).toBeLessThan(injured.average * (1 - injured.outShare));
    expect(seenAverage(injured)).toBeGreaterThanOrEqual(injured.average * 0.2 - 1e-9);
    const fit = all.find((player) => !player.back && player.games > 5)!;
    expect(seenAverage(fit)).toBe(fit.average);
    expect(seenAverage(named(/for the season/))).toBeCloseTo(named(/for the season/).average * 0.2);
    // Selling their injured player is easier than selling the same player healthy.
    const seller = teamOf(injured);
    const buyer = strengths.find((entry) => entry.rosterId !== seller.rosterId)!.rosterId;
    const give = ids(buyer).map((id) => model.players.get(id)!).find((p) => !p.back && p.games > 0)!;
    const offer = { teamA: buyer, teamB: seller.rosterId, aGives: [give.id], bGives: [injured.id] };
    const now = acceptance(evaluateTrade(model, snapshot, offer).b, 0).chance;
    const ifHealthy = acceptance(evaluateTrade(healthy, snapshot, offer).b, 0).chance;
    expect(now).toBeGreaterThan(ifHealthy);
  });

  it("finds trades for injured players only when asked, each worth it over the rest of the season", () => {
    let found = 0;
    for (const { rosterId } of strengths.slice(0, 4)) {
      const { ideas } = findTrades(model, snapshot, rosterId, situations, { getInjured: true });
      for (const idea of ideas) {
        found++;
        expect(idea.result.a.gets.some(isInjuredTarget)).toBe(true);
        expect(idea.result.a.teamChange).toBeGreaterThan(0);
        expect(idea.story.points[0]).toMatch(/is back around/);
      }
    }
    expect(found).toBeGreaterThan(0);
  }, 30_000);

  it("keeps projections repeatable", async () => {
    const team = ids(strengths[2]!.rosterId);
    const rebuilt = buildModel(snapshot, await service.report(snapshot, players, mockInjuries(raw)));
    expect(projectedWeekly(rebuilt, fillRoster(rebuilt, team).ids)).toBe(projectedWeekly(model, fillRoster(model, team).ids));
  });

  it("drops the least valuable player when a player on IR is back, and nobody for one out for the season", () => {
    for (const team of snapshot.teams) {
      const filled = fillRoster(model, ids(team.rosterId));
      const goes = [
        ...filled.adds.filter((add) => add.forInjured).map((add) => ({ player: add.player, when: add.forInjured! })),
        ...filled.leaving,
      ];
      const returning = filled.reserve.filter((p) => p.back && p.outShare > 0 && p.outShare < 1);
      expect(goes.length).toBe(returning.length);
      for (const { player, when } of goes) {
        expect(when.outShare).toBeLessThan(1);
        expect(filled.ids).toContain(`${player.id}~${when.id}`);
        // Everyone who stays is worth at least as much as whoever goes first.
        const staying = filled.ids.flatMap((id) => model.players.get(id) ?? []).filter((p) => !filled.reserve.includes(p));
        expect(staying.every((p) => p.expected >= goes[0]!.player.expected)).toBe(true);
      }
      const active = filled.ids.filter((id) => !filled.reserve.some((p) => p.id === id));
      expect(active.length).toBeLessThanOrEqual(model.rosterLimits.active);
    }
  });
});
