import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats, mockInjuries } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { buildModel, leagueStrength } from "./strength.ts";
import { extremes, leagueProfiles } from "./teamProfile.ts";

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
        // The best team sits at the top of the scale used (10, or below when the league is close).
        const best = column.reduce((top, entry) => (entry.rank < top.rank ? entry : top));
        expect(best.scaled).toBeCloseTo(Math.max(...column.map((entry) => entry.scaled)));
        expect(best.scaled).toBeGreaterThanOrEqual(5);
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
    expect(profile.weeks.every((point) => !point.final)).toBe(true);
    // The season so far is ranked by the standings' points for, not by any weekly feed.
    const team = snapshot.teams.find((entry) => entry.rosterId === profile.rosterId)!;
    expect(profile.season).toEqual({
      rank: 1 + snapshot.teams.filter((other) => other.pointsFor > team.pointsFor).length,
      weeks: team.wins + team.losses + team.ties,
    });
    for (const point of profile.weeks) {
      expect(point.team).toBeGreaterThanOrEqual(point.leagueLow - 1e-9);
      expect(point.team).toBeLessThanOrEqual(point.leagueHigh + 1e-9);
      expect(point.rank).toBeGreaterThanOrEqual(1);
      expect(point.rank).toBeLessThanOrEqual(snapshot.teams.length);
    }
    // The weeks ahead, averaged and ranked against the league's averages.
    const averages = [...profiles.values()].map((entry) => entry.ahead!.average);
    expect(profile.ahead!.average).toBeCloseTo(profile.weeks.reduce((sum, point) => sum + point.team, 0) / profile.weeks.length);
    expect(profile.ahead!.rank).toBe(1 + averages.filter((value) => value > profile.ahead!.average).length);
    const best = extremes(profile.shape)!;
    expect(best.best.rank).toBeLessThanOrEqual(best.worst.rank);
  });

  it("counts an injured star in his team's health, over the next few weeks", () => {
    const rosterId = strengths[0]!.rosterId;
    const team = snapshot.teams.find((entry) => entry.rosterId === rosterId)!;
    const star = [...team.starters.flatMap((slot) => (slot.player ? [slot.player.id] : [])), ...team.bench.map((player) => player.id)]
      .flatMap((id) => model.players.get(id) ?? [])
      .sort((a, b) => b.healthy - a.healthy)[0]!;
    // Out for the next three weeks, back after.
    const back = new Float32Array(model.calendar.weeks.length).fill(1);
    back.fill(0, 0, 3);
    const players = new Map(model.players);
    players.set(star.id, { ...star, back, outShare: 3 / back.length, expected: star.expected * (1 - 3 / back.length) });
    const hurt = leagueProfiles(snapshot, { ...model, players }, strengths, report.players);
    const health = (map: typeof profiles) => map.get(rosterId)!.shape.find((axis) => axis.key === "health")!.value;
    expect(health(hurt)).toBeLessThan(health(profiles) - 5);
  });

  it("puts finished weeks first, as final scores, and leaves them out of the projected average", () => {
    const first = model.calendar.weeks[0]!.week;
    const ids = snapshot.teams.map((team) => team.rosterId);
    // Two finished weeks: the first team scores most in both; one more score from the future is ignored.
    const history = {
      weeks: [first - 2, first - 1, first].map((week) => ({
        week,
        points: Object.fromEntries(ids.map((id, index) => [id, (index === 0 ? 900 : 600) + index - (week === first ? 2000 : 0)])),
        source: "recorded" as const,
      })),
    };
    const withHistory = leagueProfiles(snapshot, model, strengths, report.players, { history });
    const leader = withHistory.get(ids[0]!)!;
    const finals = leader.weeks.filter((point) => point.final);
    expect(finals.map((point) => point.week)).toEqual([first - 2, first - 1]);
    expect(leader.weeks.slice(0, 2)).toEqual(finals);
    expect(finals[0]).toMatchObject({ team: 900, rank: 1, leagueHigh: 900, leagueLow: 601 });
    expect(leader.weeks).toHaveLength(2 + model.calendar.weeks.length);
    // The projected average leaves out the finished weeks.
    const projected = leader.weeks.filter((point) => !point.final);
    expect(leader.ahead!.average).toBeCloseTo(projected.reduce((sum, point) => sum + point.team, 0) / projected.length);
  });

  it("scores the schedule from the real games left, weighted by how soft each opponent is", () => {
    const { today, weeks } = model.calendar;
    const end = weeks.at(-1)!.end;
    const rosterId = strengths[0]!.rosterId;
    const team = snapshot.teams.find((entry) => entry.rosterId === rosterId)!;
    const clubs = new Set(
      [...team.starters.flatMap((slot) => (slot.player ? [slot.player] : [])), ...team.bench].flatMap((player) => (player.team ? [player.team] : [])),
    );
    const all = [...new Set(snapshot.teams.flatMap((entry) => [...entry.starters.flatMap((slot) => (slot.player ? [slot.player] : [])), ...entry.bench]).flatMap((player) => (player.team ? [player.team] : [])))];
    const days: string[] = [];
    for (let day = Date.parse(`${today}T00:00:00Z`); day <= Date.parse(`${end}T00:00:00Z`); day += 86_400_000) days.push(new Date(day).toISOString().slice(0, 10));
    // Every NBA team plays every other day against a team called OPP; this team's clubs also play on the days between.
    const games = days.flatMap((date, index) =>
      all.flatMap((club) => (index % 2 === 0 || clubs.has(club) ? [{ date, home: club, away: "OPP" }] : [])),
    );
    const schedule = { status: "ready" as const, games };
    const axis = (map: typeof profiles, id: number) => map.get(id)!.shape.find((entry) => entry.key === "schedule")!;
    const even = leagueProfiles(snapshot, model, strengths, report.players, { schedule });
    // Its clubs play every day, so it has the league's best schedule (tied with any team on the same clubs).
    expect(axis(even, rosterId).value).toBeCloseTo(Math.max(...snapshot.teams.map((entry) => axis(even, entry.rosterId).value)));
    expect(axis(even, rosterId).value).toBeGreaterThan(Math.min(...snapshot.teams.map((entry) => axis(even, entry.rosterId).value)));
    expect(axis(even, rosterId).schedule!.games).toBeGreaterThan(5);
    expect(axis(even, rosterId).schedule!.opponents).toBeCloseTo(1);
    // A soft opponent raises every team's figure by the same share.
    const soft = leagueProfiles(snapshot, model, strengths, report.players, { schedule, allowed: { OPP: 1.1 } });
    expect(axis(soft, rosterId).value).toBeCloseTo(axis(even, rosterId).value * 1.1);
    expect(axis(soft, rosterId).schedule!.opponents).toBeCloseTo(1.1);
    // Without a schedule the model's games stand in, with no split.
    expect(axis(profiles, rosterId).schedule).toBeUndefined();
    expect(leagueProfiles(snapshot, model, strengths, report.players, { schedule: { status: "unavailable", games: [] } }).get(rosterId)!.shape.find((entry) => entry.key === "schedule")!.schedule).toBeUndefined();
  });

  it("scales the shape by the league's rate and the weeks ahead by each team's own", () => {
    const first = model.calendar.weeks[0]!.week;
    // The first team scored all of its projection, every other team 80%.
    const leader = strengths[0]!.rosterId;
    const points = Object.fromEntries(
      [...profiles.values()].map((profile) => [profile.rosterId, (profile.rosterId === leader ? 1 : 0.8) * profile.ahead!.average]),
    );
    const history = { weeks: [first - 2, first - 1].map((week) => ({ week, points, source: "recorded" as const })) };
    const scaled = leagueProfiles(snapshot, model, strengths, report.players, { history });
    const after = scaled.get(leader)!;
    const before = profiles.get(leader)!;
    expect(after.rate.team).toBeGreaterThan(after.rate.league);
    const axis = (profile: typeof before, key: string) => profile.shape.find((entry) => entry.key === key)!;
    for (const key of ["ceiling", "floor", "depth"]) {
      expect(axis(after, key).value).toBeCloseTo(after.rate.league * axis(before, key).value);
      // How well a team has been managed does not move its place among the rosters.
      for (const other of scaled.values()) expect(axis(other, key).rank).toBe(axis(profiles.get(other.rosterId)!, key).rank);
    }
    expect(after.ahead!.average).toBeCloseTo(after.rate.team * before.ahead!.average);
  });

  it("scales projected points by how much of its projection each team really scores", () => {
    const first = model.calendar.weeks[0]!.week;
    // Every team scored 80% of its projection in the two weeks before.
    const points = Object.fromEntries([...profiles.values()].map((profile) => [profile.rosterId, 0.8 * profile.ahead!.average]));
    const history = { weeks: [first - 2, first - 1].map((week) => ({ week, points, source: "recorded" as const })) };
    const scaled = leagueProfiles(snapshot, model, strengths, report.players, { history });
    const id = strengths[2]!.rosterId;
    const before = profiles.get(id)!;
    const after = scaled.get(id)!;
    expect(before.rate).toEqual({ team: 1, league: 1, weeks: 0 });
    expect(after.rate.team).toBeCloseTo(0.8);
    expect(after.rate.league).toBeCloseTo(0.8);
    const value = (profile: typeof before, key: string) => profile.shape.find((axis) => axis.key === key)!.value;
    for (const key of ["ceiling", "floor", "depth"]) expect(value(after, key)).toBeCloseTo(after.rate.league * value(before, key));
    // Player values are not team totals: the top three stay as they are.
    expect(value(after, "stars")).toBeCloseTo(value(before, "stars"));
    expect(after.ahead!.average).toBeCloseTo(0.8 * before.ahead!.average);
    expect(after.weeks.find((point) => !point.final)!.team).toBeCloseTo(0.8 * before.weeks[0]!.team);
  });

  it("splits the mix only by what the league scores, and ranks fewest mistakes first", () => {
    const all = [...profiles.values()];
    expect(all.every((profile) => profile.mistakes !== null)).toBe(true);
    expect(all.filter((profile) => profile.mistakes!.rank === 1)).toHaveLength(1);
  });
});
