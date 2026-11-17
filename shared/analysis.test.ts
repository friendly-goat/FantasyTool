import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import {
  bestLineup,
  freeAgentUpgrades,
  leagueOutlook,
  rosterPlayers,
  slotAccepts,
  startingSlots,
  teamOutlook,
} from "./analysis.ts";
import { lockInValue } from "./lockin.ts";

describe("lockInValue", () => {
  it("equals the average when only one game is left", () => {
    expect(lockInValue([10, 30], 1)).toBe(20);
  });

  it("rises with more games, because a bad game can be passed over", () => {
    // Two games: lock a 30, pass on a 10 and take the average of the next (20). (20 + 30) / 2
    expect(lockInValue([10, 30], 2)).toBe(25);
    // Three games: pass on a 10 (waiting is worth 25), lock a 30. (25 + 30) / 2
    expect(lockInValue([10, 30], 3)).toBe(27.5);
    expect(lockInValue([10, 30])).toBe(27.5); // a typical week has three games
  });

  it("gains nothing for a player who scores the same every game", () => {
    expect(lockInValue([25, 25, 25], 4)).toBe(25);
  });

  it("values a swingy player above a steady one with the same average", () => {
    expect(lockInValue([10, 50])).toBeGreaterThan(lockInValue([29, 31]));
  });

  it("is zero without games", () => {
    expect(lockInValue([])).toBe(0);
  });
});

describe("slotAccepts", () => {
  it("follows position rules", () => {
    expect(slotAccepts("PG", ["PG", "SG"])).toBe(true);
    expect(slotAccepts("PG", ["SG"])).toBe(false);
    expect(slotAccepts("G", ["SG"])).toBe(true);
    expect(slotAccepts("F", ["C", "PF"])).toBe(true);
    expect(slotAccepts("C", ["PF"])).toBe(false);
    expect(slotAccepts("UTIL", ["C"])).toBe(true);
    expect(slotAccepts("BN", ["C"])).toBe(false);
  });
});

describe("bestLineup", () => {
  const player = (id: string, positions: string[], value: number) => ({ id, positions, value });

  it("finds the best assignment where taking the best player first would fail", () => {
    // Putting the 50 at UTIL first would leave PG to nobody.
    const lineup = bestLineup(
      ["UTIL", "PG", "C"],
      [player("guard", ["PG"], 50), player("center", ["C"], 40), player("wing", ["SF"], 30), player("big", ["C"], 20)],
    );
    expect(lineup).toEqual({ total: 120, playerIds: ["wing", "guard", "center"] });
  });

  it("leaves a slot empty when nobody is eligible", () => {
    expect(bestLineup(["C", "PG"], [player("guard", ["PG"], 30)])).toEqual({
      total: 30,
      playerIds: [null, "guard"],
    });
  });

  it("uses each player once", () => {
    const lineup = bestLineup(["G", "G", "UTIL"], [player("a", ["PG"], 40), player("b", ["SG"], 10)]);
    expect(lineup.total).toBe(50);
    expect(new Set(lineup.playerIds.filter(Boolean)).size).toBe(2);
  });
});

describe("team analysis (against the mock league)", async () => {
  const rawPlayers = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(rawPlayers), { dir: null });
  await service.sync("2026");
  const report = await service.report(snapshot, players);
  const slots = startingSlots(snapshot);
  const team = snapshot.teams[0]!;

  it("reads the starting slots from the league", () => {
    expect(slots).toEqual(["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "UTIL"]);
  });

  it("gives every player with games a lock-in value at or above his average", () => {
    for (const stats of Object.values(report.players)) {
      expect(stats.lockInValue).toBeGreaterThanOrEqual(stats.fantasyAvg - 1e-9);
      expect(stats.bestGame).toBeGreaterThanOrEqual(stats.lockInValue - 1e-9);
    }
  });

  it("builds a best lineup that follows the rules and leaves out unavailable players", () => {
    const outlook = teamOutlook(team, slots, report.players);
    const roster = new Map(rosterPlayers(team).map((player) => [player.id, player]));
    const reserve = new Set(team.reserve.map((player) => player.id));
    outlook.best.playerIds.forEach((id, index) => {
      if (!id) return;
      const chosen = roster.get(id)!;
      expect(slotAccepts(slots[index]!, chosen.positions)).toBe(true);
      expect(reserve.has(id)).toBe(false);
      expect(chosen.injuryStatus).not.toBe("OUT");
    });
    expect(outlook.best.playerIds.filter(Boolean).length).toBe(new Set(outlook.best.playerIds.filter(Boolean)).size);
  });

  it("ranks all teams by best lineup", () => {
    const outlooks = leagueOutlook(snapshot, report);
    expect(outlooks).toHaveLength(10);
    for (let i = 1; i < outlooks.length; i++) {
      expect(outlooks[i - 1]!.bestValue).toBeGreaterThanOrEqual(outlooks[i]!.bestValue);
    }
  });

  it("suggests only free agents who raise the best lineup, biggest gain first", () => {
    const rostered = new Set(snapshot.teams.flatMap((other) => rosterPlayers(other).map((p) => p.id)));
    const upgrades = freeAgentUpgrades(team, snapshot, report);
    expect(upgrades.length).toBeLessThanOrEqual(5);
    upgrades.forEach((upgrade, index) => {
      expect(rostered.has(upgrade.player.id)).toBe(false);
      expect(upgrade.gain).toBeGreaterThan(0);
      expect(slotAccepts(upgrade.slot, upgrade.player.positions)).toBe(true);
      if (index > 0) expect(upgrades[index - 1]!.gain).toBeGreaterThanOrEqual(upgrade.gain);
    });
  });
});
