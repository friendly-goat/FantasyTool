import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { activityEffects, moveEffect } from "./activity.ts";
import { rosterPlayers } from "./analysis.ts";
import { buildModel, rosterStrength } from "./strength.ts";
import type { PlayerRef, TransactionSide } from "./types.ts";

describe("strength effect of a transaction (against the mock league)", async () => {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  const model = buildModel(snapshot, await service.report(snapshot, players));
  const team = snapshot.teams[0]!;
  const ids = rosterPlayers(team).map((player) => player.id);
  const ref = (id: string): PlayerRef => {
    const player = model.players.get(id)!;
    return { id, name: player.name, positions: player.positions, team: player.team, injuryStatus: null };
  };
  const byValue = ids.map((id) => model.players.get(id)!).filter((p) => p.games > 0).sort((a, b) => b.expected - a.expected);
  const bestFreeAgent = model.freeAgentIds.map((id) => model.players.get(id)!).sort((a, b) => b.expected - a.expected)[0]!;

  it("credits a pickup of a good free agent for a weak player with a gain, measured from today's roster", () => {
    const weakest = byValue[byValue.length - 1]!;
    // As if the team had picked up the free agent for its weakest player: undo it first.
    const current = [...ids.filter((id) => id !== weakest.id), bestFreeAgent.id];
    const side: TransactionSide = { rosterId: team.rosterId, adds: [ref(bestFreeAgent.id)], drops: [ref(weakest.id)], picks: [] };
    const effect = moveEffect(model, current, side);
    expect(effect.change).toBeGreaterThan(0);
    expect(effect.strengthChange).toBeGreaterThanOrEqual(0);
    expect(effect.change).toBeCloseTo(effect.with - effect.without, 6);
    expect(effect.since).toEqual({ gone: [], back: [] });
  });

  it("shows dropping the best player for nothing as a loss, and agrees with the strength model", () => {
    const best = byValue[0]!;
    const side: TransactionSide = { rosterId: team.rosterId, adds: [], drops: [ref(best.id)], picks: [] };
    const current = ids.filter((id) => id !== best.id);
    const effect = moveEffect(model, current, side);
    expect(effect.change).toBeLessThan(0);
    expect(effect.without).toBeCloseTo(rosterStrength(model, ids).projected, 6);
  });

  it("gives the same answer whether or not later moves undid it", () => {
    const weakest = byValue[byValue.length - 1]!;
    const side: TransactionSide = { rosterId: team.rosterId, adds: [ref(bestFreeAgent.id)], drops: [ref(weakest.id)], picks: [] };
    const kept = moveEffect(model, [...ids.filter((id) => id !== weakest.id), bestFreeAgent.id], side);
    // Later the team let the pickup go and took the dropped player back: today's roster is the old one.
    const undone = moveEffect(model, ids, side);
    expect(undone.change).toBeCloseTo(kept.change, 6);
    expect(undone.since).toEqual({ gone: [bestFreeAgent.id], back: [weakest.id] });
  });

  it("measures every side of the league's transactions and skips sides with no players", () => {
    const effects = activityEffects(model, snapshot);
    expect(effects.size).toBe(snapshot.transactions.length);
    for (const transaction of snapshot.transactions) {
      for (const side of transaction.sides) {
        const measured = effects.get(transaction.id)!.get(side.rosterId);
        if (side.adds.length === 0 && side.drops.length === 0) expect(measured).toBeUndefined();
        else expect(Number.isFinite(measured!.change)).toBe(true);
      }
    }
  });
});
