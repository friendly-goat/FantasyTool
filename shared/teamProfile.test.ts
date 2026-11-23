import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats, mockInjuries } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { buildModel, leagueStrength } from "./strength.ts";
import { extremes, leagueProfiles, MAX_REAL_SHARE, place, REAL_WEEKS_PRIOR, RINGS_PER_SPREAD } from "./teamProfile.ts";

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

  it("places the league's average on the middle ring and each team by the typical gap from it", () => {
    const raw = new Map([
      [1, 100],
      [2, 110],
      [3, 120],
      [4, 130],
    ]);
    const placed = place(raw, 1);
    const sd = Math.sqrt((15 ** 2 + 5 ** 2 + 5 ** 2 + 15 ** 2) / 4);
    expect(placed.get(3)!.scaled).toBeCloseTo(5 + (RINGS_PER_SPREAD * 5) / sd);
    expect([...placed.values()].every((entry) => entry.league === 5)).toBe(true);
    // A team far out at one end moves its own place, not everyone else's (as a range would).
    const outlier = place(new Map([...raw, [5, 400]]), 1);
    const ordinary = place(new Map([...raw, [5, 135]]), 1);
    expect(outlier.get(4)!.rank).toBe(ordinary.get(4)!.rank);
    // A near tie is placed by the smallest gap allowed, not stretched across the rings.
    const tie = place(new Map([[1, 100], [2, 100.2]]), 5);
    expect(tie.get(2)!.scaled - tie.get(1)!.scaled).toBeCloseTo((RINGS_PER_SPREAD * 0.2) / 5);
    // However far below average, a team stays drawn, inside the outer ring.
    const far = place(new Map([[1, 0], [2, 100], [3, 100], [4, 100]]), 1);
    expect(far.get(1)!.scaled).toBeGreaterThan(0);
    expect(Math.max(...[...far.values()].map((entry) => entry.scaled))).toBeLessThanOrEqual(10);
  });

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
    // The weeks ahead on average are the team's locks a week (team strength's figure), ranked.
    const averages = [...profiles.values()].map((entry) => entry.ahead!.average);
    const strength = strengths.find((entry) => entry.rosterId === profile.rosterId)!;
    expect(profile.ahead!.locks).toBeCloseTo(strength.projected);
    expect(profile.ahead!.average).toBeCloseTo(strength.projected);
    expect(profile.ahead!.average).toBeCloseTo(profile.weeks.reduce((sum, point) => sum + point.team, 0) / profile.weeks.length, -1);
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

  it("leans ceiling and floor on the team's real finished weeks, by how many there are, up to a limit", () => {
    const first = model.calendar.weeks[0]!.week;
    const leader = strengths[0]!.rosterId;
    const axis = (profile: ReturnType<typeof profiles.get>, key: string) => profile!.shape.find((entry) => entry.key === key)!;
    const before = profiles.get(leader)!;
    // Two finished weeks: the leader scored 60 above its old ceiling both times; everyone else as projected.
    const points = Object.fromEntries(
      [...profiles.values()].map((profile) => [
        profile.rosterId,
        profile.rosterId === leader ? axis(before, "ceiling").value + 60 : profile.ahead!.average,
      ]),
    );
    const two = { weeks: [first - 2, first - 1].map((week) => ({ week, points, source: "recorded" as const })) };
    const after = leagueProfiles(snapshot, model, strengths, report.players, { history: two }).get(leader)!;
    expect(axis(after, "ceiling").real).toMatchObject({ weeks: 2, share: 2 / (2 + REAL_WEEKS_PRIOR) });
    expect(axis(after, "ceiling").real!.average).toBeCloseTo(axis(before, "ceiling").value + 60);
    expect(axis(after, "ceiling").value).toBeGreaterThan(axis(before, "ceiling").value);
    expect(axis(after, "floor").value).toBeGreaterThan(axis(before, "floor").value);
    expect(axis(after, "ceiling").value).toBeGreaterThan(axis(after, "floor").value);
    // Without real weeks there is nothing to say about them.
    expect(axis(before, "ceiling").real).toBeUndefined();

    // A long run of weeks counts for no more than MAX_REAL_SHARE.
    const many = { weeks: Array.from({ length: 30 }, (_, index) => ({ week: first - 30 + index, points, source: "recorded" as const })) };
    const capped = leagueProfiles(snapshot, model, strengths, report.players, { history: many }).get(leader)!;
    expect(axis(capped, "ceiling").real!.share).toBe(MAX_REAL_SHARE);
  });

  it("scales the depth by the league's rate and the weeks ahead by each team's own", () => {
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
    expect(axis(after, "depth").value).toBeCloseTo(after.rate.league * axis(before, "depth").value);
    // How well a team has been managed does not move its place among the rosters' benches.
    for (const other of scaled.values()) expect(axis(other, "depth").rank).toBe(axis(profiles.get(other.rosterId)!, "depth").rank);
    expect(after.ahead!.average).toBeCloseTo(after.rate.team * before.ahead!.average);
  });

  it("gives the weeks ahead the league's likely high and low, wider than the spread of the teams' averages", () => {
    const weeks = model.calendar.weeks.length;
    let likely = 0;
    let averages = 0;
    for (let index = 0; index < weeks; index++) {
      const scores = [...profiles.values()].map((entry) => entry.weeks[index]!.team);
      const point = profiles.get(strengths[0]!.rosterId)!.weeks[index]!;
      expect(point.leagueHigh).toBeGreaterThanOrEqual(Math.max(...scores) - 1e-9);
      expect(point.leagueLow).toBeLessThanOrEqual(Math.min(...scores) + 1e-9);
      likely += point.leagueHigh - point.leagueLow;
      averages += Math.max(...scores) - Math.min(...scores);
    }
    expect(likely).toBeGreaterThan(averages);
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
    // Teams that score less than projected have lower good and bad weeks.
    for (const key of ["ceiling", "floor"]) expect(value(after, key)).toBeLessThan(value(before, key));
    expect(value(after, "depth")).toBeCloseTo(0.8 * value(before, "depth"));
    // Player values are not team totals: the top three stay as they are.
    expect(value(after, "stars")).toBeCloseTo(value(before, "stars"));
    expect(after.ahead!.average).toBeCloseTo(0.8 * before.ahead!.average);
    expect(after.weeks.find((point) => !point.final)!.team).toBeCloseTo(before.weeks[0]!.team - 0.2 * before.ahead!.locks, 1);
  });

  it("splits the mix only by what the league scores, and ranks fewest mistakes first", () => {
    const all = [...profiles.values()];
    expect(all.every((profile) => profile.mistakes !== null)).toBe(true);
    expect(all.filter((profile) => profile.mistakes!.rank === 1)).toHaveLength(1);
  });

  it("gives the mix in points a week: the sources, less mistakes, add up to the team's week", () => {
    for (const profile of profiles.values()) {
      const week = profile.mix.reduce((sum, axis) => sum + axis.value, 0) - profile.mistakes!.value;
      expect(week).toBeCloseTo(profile.ahead!.locks, 0);
    }
  });
});
