import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats, mockInjuries } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { buildModel, leagueStrength } from "./strength.ts";
import { extremes, leagueProfiles, weekHighlights } from "./teamProfile.ts";

describe("team profiles (against the mock league)", async () => {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  const report = await service.report(snapshot, players, mockInjuries(raw));
  const model = buildModel(snapshot, report);
  const strengths = leagueStrength(snapshot, model);
  const profiles = leagueProfiles(snapshot, model, strengths, report.players);

  it("places every team on the league's range, with one best and one worst on each axis", () => {
    expect(profiles.size).toBe(snapshot.teams.length);
    const all = [...profiles.values()];
    for (const view of ["shape", "mix"] as const) {
      const axes = all[0]![view];
      expect(axes.length).toBeGreaterThan(3);
      axes.forEach((axis, index) => {
        const column = all.map((profile) => profile[view][index]!);
        expect(column.every((entry) => entry.key === axis.key)).toBe(true);
        expect(column.every((entry) => entry.scaled >= 0 && entry.scaled <= 10)).toBe(true);
        expect(column.filter((entry) => entry.rank === 1).length).toBeGreaterThanOrEqual(1);
        expect(Math.max(...column.map((entry) => entry.scaled))).toBeCloseTo(10);
        expect(Math.min(...column.map((entry) => entry.scaled))).toBeCloseTo(0);
        // The league's average is the same for every team.
        expect(new Set(column.map((entry) => entry.league.toFixed(6))).size).toBe(1);
      });
    }
  });

  it("follows team strength: the strongest team has the higher ceiling and floor than the weakest", () => {
    const top = profiles.get(strengths[0]!.rosterId)!.shape;
    const bottom = profiles.get(strengths.at(-1)!.rosterId)!.shape;
    const axis = (shape: typeof top, key: string) => shape.find((entry) => entry.key === key)!.value;
    expect(axis(top, "ceiling")).toBeGreaterThan(axis(bottom, "ceiling"));
    expect(axis(top, "floor")).toBeGreaterThan(axis(bottom, "floor"));
    expect(axis(top, "ceiling")).toBeGreaterThan(axis(top, "floor"));
  });

  it("gives each real week left the team's score, inside the league's range, with its rank", () => {
    const profile = profiles.get(strengths[3]!.rosterId)!;
    expect(profile.weeks).toHaveLength(model.calendar.weeks.length);
    for (const point of profile.weeks) {
      expect(point.team).toBeGreaterThanOrEqual(point.leagueLow - 1e-9);
      expect(point.team).toBeLessThanOrEqual(point.leagueHigh + 1e-9);
      expect(point.rank).toBeGreaterThanOrEqual(1);
      expect(point.rank).toBeLessThanOrEqual(snapshot.teams.length);
    }
    const highlights = weekHighlights(profile.weeks)!;
    expect(highlights.best.length).toBeGreaterThan(0);
    const best = extremes(profile.shape)!;
    expect(best.best.rank).toBeLessThanOrEqual(best.worst.rank);
  });

  it("splits the mix only by what the league scores, and ranks fewest mistakes first", () => {
    const all = [...profiles.values()];
    expect(all.every((profile) => profile.mistakes !== null)).toBe(true);
    expect(all.filter((profile) => profile.mistakes!.rank === 1)).toHaveLength(1);
  });
});
