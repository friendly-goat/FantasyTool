import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { assignSlots, rosterPlayers } from "./analysis.ts";
import { lockInValues } from "./lockin.ts";
import {
  bestNineLineup,
  buildModel,
  leagueStrength,
  projectedWeekly,
  projectRoster,
  rosterStrength,
  simulateWeek,
  steadyPlayer,
  strengthScore,
  type StrengthModel,
} from "./strength.ts";
import { deepestSpot, POSITIONS, positionProfile, teamSituations, thinnestSpot } from "./insight.ts";
import { availabilityOutlook, projectPlayer } from "./projection.ts";
import {
  acceptance,
  acceptanceChance,
  chanceParts,
  chanceFrom,
  evaluateTrade,
  findTrades,
  evenOnValue,
  gradeWord,
  letterGrade,
  likelihood,
  playerValue,
  tradeKind,
  tradeStory,
  tradeGrade,
} from "./trade.ts";

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
      expect(team.projected).toBeGreaterThan(0);
      // A bench helps or, at worst, costs next to nothing.
      expect(team.benchAdds).toBeGreaterThan(-0.5);
      expect(team.projected).toBeCloseTo(team.bestNine + team.benchAdds);
      expect(team.starterAvailability).toBeGreaterThan(0.5);
      expect(team.starterAvailability).toBeLessThanOrEqual(1);
    });
  });

  it("lets a deep bench add value by rotating into open slots", () => {
    const benchAdds = strengths.map((team) => team.benchAdds);
    expect(benchAdds.reduce((a, b) => a + b, 0) / benchAdds.length).toBeGreaterThan(1);
  });

  it("follows lock-in rules every week: one game per slot, one slot per player", () => {
    const roster = ids(strengths[3]!.rosterId).map((id) => model.players.get(id)!);
    for (let week = 0; week < 50; week++) {
      const result = simulateWeek(model, roster, week);
      const used = result.lockedBy.filter((index) => index >= 0);
      expect(new Set(used).size).toBe(used.length);
      result.lockedBy.forEach((index, slot) => index >= 0 && expect(roster[index]!.eligible[slot]).toBe(true));
      // Never more than each slot's best possible game.
      const best = Math.max(0, ...roster.flatMap((p) => [...p.gameScore.slice(week * 4, week * 4 + 4)]));
      expect(result.total).toBeLessThanOrEqual(best * model.slots.length + 1e-6);
    }
  });

  it("is quick enough to rate a whole league", () => {
    const started = Date.now();
    leagueStrength(snapshot, buildModel(snapshot, report));
    expect(Date.now() - started).toBeLessThan(3000);
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

  const situations = teamSituations(snapshot, model, strengths);

  it("finds trades that help the asking team, most likely to be accepted first", () => {
    const mine = strengths[4]!.rosterId;
    const started = Date.now();
    const { ideas, outlook } = findTrades(model, snapshot, mine, situations);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ideas.length).toBeLessThanOrEqual(8);
    expect(outlook).not.toBe("none");
    const appearances = new Map<string, number>();
    for (const { offer } of ideas) {
      for (const id of [...offer.aGives, ...offer.bGives]) appearances.set(id, (appearances.get(id) ?? 0) + 1);
    }
    expect(Math.max(0, ...appearances.values())).toBeLessThanOrEqual(2); // variety
    const order = ["likely", "possible", "long shot"];
    ideas.forEach(({ offer, result, chance, likelihood: band }, index) => {
      expect(offer.teamA).toBe(mine);
      expect(result.a.projectedAfter - result.a.projectedBefore).toBeGreaterThanOrEqual(0.3);
      expect(band).toBe(likelihood(chance));
      if (index > 0) expect(order.indexOf(ideas[index - 1]!.likelihood)).toBeLessThanOrEqual(order.indexOf(band));
      expect(ids(mine)).toContain(offer.aGives[0]);
      expect(ids(offer.teamB)).toContain(offer.bGives[0]);
    });
    // Long shots appear only when nothing better exists, and then at most three.
    if (ideas.some((idea) => idea.likelihood === "long shot")) {
      expect(outlook).toBe("long-shot");
      expect(ideas.length).toBeLessThanOrEqual(3);
    }
  });

  it("narrows the search to a position, a player to send, or a player to get", () => {
    const mine = strengths[4]!.rosterId;
    for (const idea of findTrades(model, snapshot, mine, situations, { getPosition: "C" }).ideas) {
      expect(idea.result.a.gets.some((player) => player.positions.includes("C"))).toBe(true);
    }
    const send = ids(mine).map((id) => model.players.get(id)!).filter((p) => p.games > 0)[0]!;
    const sending = findTrades(model, snapshot, mine, situations, { givePlayerId: send.id }).ideas;
    expect(sending.length).toBeGreaterThan(0);
    for (const idea of sending) expect(idea.offer.aGives).toContain(send.id);

    // A mid-level target on another team.
    const other = strengths[0]!.rosterId === mine ? strengths[1]!.rosterId : strengths[0]!.rosterId;
    const sorted = ids(other).map((id) => model.players.get(id)!).filter((p) => p.games > 0).sort((a, b) => b.expected - a.expected);
    const target = sorted[2]!;
    const getting = findTrades(model, snapshot, mine, situations, { getPlayerId: target.id });
    expect(getting.ideas.length).toBeGreaterThan(0);
    for (const idea of getting.ideas) {
      expect(idea.offer.bGives).toEqual([target.id]);
      expect(idea.offer.teamB).toBe(other);
      // You may pay a little for a named player, never more than a point a week.
      expect(idea.result.a.projectedAfter - idea.result.a.projectedBefore).toBeGreaterThanOrEqual(-1);
    }
  });

  it("says so when only long shots exist, and shows few of them", () => {
    // The best player in the league is out of reach for the weakest roster.
    const poorest = strengths[9]!.rosterId;
    const star = [...model.players.values()]
      .filter((p) => snapshot.teams.some((t) => t.rosterId !== poorest && ids(t.rosterId).includes(p.id)))
      .sort((a, b) => b.expected - a.expected)[0]!;
    const result = findTrades(model, snapshot, poorest, situations, { getPlayerId: star.id });
    if (result.outlook === "long-shot") expect(result.ideas.length).toBeLessThanOrEqual(3);
    if (result.outlook === "possible") expect(result.ideas.length).toBeLessThanOrEqual(5);
    for (const idea of result.ideas) expect(idea.likelihood === "likely").toBe(result.outlook === "likely");
  });

  it("lists the best nine slot by slot, each player legal for his slot and used once", () => {
    for (const team of strengths) {
      const lineup = bestNineLineup(model, ids(team.rosterId));
      expect(lineup.map((entry) => entry.slot)).toEqual(model.slots);
      const used = lineup.flatMap((entry) => (entry.player ? [entry.player.id] : []));
      expect(new Set(used).size).toBe(used.length);
      lineup.forEach((entry, index) => {
        if (entry.player) expect(entry.player.eligible[index]).toBe(true);
      });
      // The same nine the strength score counts as "best nine".
      expect(projectedWeekly(model, used)).toBeCloseTo(team.bestNine);
    }
  });

  it("names the thinnest and deepest spots only when they matter", () => {
    const note = (position: string, need: number, cover: number) => ({ position, need, cover, best: null });
    const profile = [note("PG", 0.2, 3), note("SF", 2, 0.4), note("C", 0.4, 0.5)];
    expect(thinnestSpot(profile)?.position).toBe("SF");
    expect(deepestSpot(profile)?.position).toBe("PG");
    expect(thinnestSpot([note("PG", 0.3, 0)])).toBeNull();
    expect(deepestSpot([note("PG", 0, 0.9)])).toBeNull();
  });

  it("measures need and cover at every position", () => {
    const profile = positionProfile(model, snapshot, ids(strengths[4]!.rosterId));
    expect(profile.map((note) => note.position)).toEqual(POSITIONS);
    for (const note of profile) {
      expect(note.need).toBeGreaterThanOrEqual(-1e-9); // an extra player never hurts
      expect(note.cover).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps urgency between 0 and 1 and notices long absences", () => {
    const all = [...situations.values()];
    expect(all).toHaveLength(10);
    for (const situation of all) {
      expect(situation.urgency).toBeGreaterThanOrEqual(0);
      expect(situation.urgency).toBeLessThanOrEqual(1);
    }
    expect(all.some((situation) => situation.longTermOut.length > 0)).toBe(true);
    const out = Object.values(report.players).filter((player) => player.longTermOut);
    expect(out.length).toBeGreaterThan(0);
    for (const player of out) expect(player.missedStreak).toBeGreaterThanOrEqual(4);
  });

  it("bands chances, words grades, and places the balance between teams", () => {
    expect([0.62, 0.55, 0.45, 0.4, 0.39].map(likelihood)).toEqual(["likely", "likely", "possible", "possible", "long shot"]);
    expect([95, 60, 50, 43, 30, 5].map(gradeWord)).toEqual(["Big win", "Win", "About even", "About even", "Loss", "Big loss"]);
    // An even trade with typical pressure lands a little under 50%.
    expect(chanceFrom(0, 30, 30, 0.3)).toBeCloseTo(1 / (1 + Math.exp(-(-0.3 + 0.18))));
    const even = evaluateTrade(model, snapshot, { teamA: strengths[0]!.rosterId, teamB: strengths[1]!.rosterId, aGives: [], bGives: [] });
    expect(even.valueBalance).toBe(50);
  });

  it("measures player value apart from team effect, and the gap between them as fit", () => {
    const [a, b] = [strengths[2]!.rosterId, strengths[6]!.rosterId];
    const sorted = (rosterId: number) =>
      ids(rosterId).map((id) => model.players.get(id)!).filter((p) => p.games > 0).sort((x, y) => y.expected - x.expected);
    const star = sorted(a)[0]!;
    const role = sorted(b)[8]!;
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [star.id], bGives: [role.id] });

    expect(result.a.valueSent).toBeCloseTo(playerValue(model, star));
    expect(result.a.valueReceived).toBeCloseTo(playerValue(model, role));
    expect(result.a.valueChange).toBeCloseTo(-result.b.valueChange);
    for (const side of [result.a, result.b]) {
      expect(side.teamChange).toBeCloseTo(side.projectedAfter - side.projectedBefore);
      expect(side.fit).toBeCloseTo(side.teamChange - side.valueChange);
    }
    // Team B receives the star, so the player-value slider leans toward B.
    expect(result.valueBalance).toBeGreaterThan(60);
    expect(evenOnValue(result)).toBe(false);
    expect(tradeKind(result)).toBe("costs-you");

    const story = tradeStory(model, snapshot, result);
    expect(story.points[0]).toMatch(/^You give up/);
    expect(story.headline).toBe("Costs your team strength");
  });

  it("never counts a player below free-agent level as negative value", () => {
    const worst = [...model.players.values()].filter((p) => p.games > 0).sort((x, y) => x.expected - y.expected)[0]!;
    expect(playerValue(model, worst)).toBe(0);
    expect(model.replacementWeekly).toBeGreaterThan(0);
  });

  it("explains every suggested trade from the user's side", () => {
    const { ideas } = findTrades(model, snapshot, strengths[4]!.rosterId, situations);
    for (const idea of ideas) {
      expect(idea.story.kind).toBe(tradeKind(idea.result));
      expect(idea.story.points.length).toBeGreaterThan(0);
      expect(idea.story.points.length).toBeLessThanOrEqual(7);
      // Every suggestion helps the user, so none is called a loss.
      expect(idea.story.kind).not.toBe("costs-you");
    }
  });

  it("rates acceptance higher when the trade helps them more", () => {
    const [a, b] = [strengths[2]!.rosterId, strengths[3]!.rosterId];
    const sorted = (rosterId: number) =>
      ids(rosterId).map((id) => model.players.get(id)!).filter((p) => p.games > 0).sort((x, y) => y.expected - x.expected);
    const generous = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [sorted(a)[0]!.id], bGives: [sorted(b).at(-1)!.id] });
    const stingy = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [sorted(a).at(-1)!.id], bGives: [sorted(b)[0]!.id] });
    expect(acceptanceChance(generous.b, 0)).toBeGreaterThan(acceptanceChance(stingy.b, 0));
    expect(acceptanceChance(stingy.b, 1)).toBeGreaterThan(acceptanceChance(stingy.b, 0));
    expect(acceptance(stingy.b, 0.5).parts.map((part) => part.label)).toEqual([
      "What they see on averages",
      "What it does to their team",
      "Pressure on their team",
    ]);
  });

  it("does not call a trade likely when it clearly hurts the other team, however fair it looks", () => {
    // Looks a little in their favor on averages, costs them 2 points a week (about a D+).
    const hurt = chanceFrom(-2, 31, 30, 0.3);
    expect(hurt).toBeLessThan(0.4);
    // The same look, helping them by 2 a week, is likely.
    expect(chanceFrom(2, 31, 30, 0.3)).toBeGreaterThan(0.55);
  });

  it("keeps each part within its limit", () => {
    // Even a lopsided look cannot outweigh a trade that wrecks their team, and the reverse.
    expect(chanceFrom(-50, 300, 10, 1)).toBeLessThan(0.5);
    expect(chanceFrom(50, 1, 300, 1)).toBeLessThan(0.5);
    expect(chanceFrom(50, 300, 10, 1)).toBeLessThan(0.96);
    const { parts } = chanceParts(-3, 25, 30, 0);
    expect(parts[0]!.points).toBeLessThan(0); // looks worse for them
    expect(parts[1]!.points).toBeLessThan(0); // hurts their team
    expect(parts[2]!.points).toBe(0); // no pressure
  });

  it("uses last season once it has loaded", async () => {
    expect(report.lastSeason).toBe("loading"); // the first report starts the download
    await service.sync("2025");
    const later = await service.report(snapshot, players);
    expect(later.lastSeason).toBe("ready");
    const withHistory = Object.values(later.players).filter((player) => player.projection.lastSeason);
    expect(withHistory.length).toBeGreaterThan(100);
    expect(withHistory.some((p) => p.projection.factors.some((f) => f.label === "Last season's level"))).toBe(true);
    expect(Object.values(later.players).some((player) => !player.projection.lastSeason)).toBe(true); // rookies
  });
});

describe("projectPlayer", () => {
  const flat = (value: number, games: number) => Array.from({ length: games }, () => value);

  it("projects a steady player at his average", () => {
    const projection = projectPlayer(flat(30, 12), flat(32, 12));
    expect(projection.perGame).toBeCloseTo(30);
    expect(projection.trend).toBe("steady");
    expect(projection.factors).toEqual([]);
  });

  it("leans toward recent games, but not all the way", () => {
    const scores = [...flat(20, 10), ...flat(40, 5)]; // average 26.67, last five 40
    const projection = projectPlayer(scores, flat(30, 15));
    expect(projection.perGame).toBeGreaterThan(26.67);
    expect(projection.perGame).toBeLessThan(30);
    expect(projection.factors.map((factor) => factor.label)).toEqual(["Recent games count more"]);
  });

  it("pulls a hot start toward last season, less as games pile up", () => {
    const last = { games: 70, average: 30 };
    const early = projectPlayer(flat(40, 5), flat(30, 5), last); // (5*40 + 10*30) / 15
    const late = projectPlayer(flat(40, 40), flat(30, 40), last); // (40*40 + 10*30) / 50
    expect(early.perGame).toBeCloseTo(33.33, 1);
    expect(late.perGame).toBeCloseTo(38);
    expect(early.trend).toBe("fading");
    expect(early.factors[0]).toMatchObject({ label: "Last season's level" });
  });

  it("ignores a last season of only a few games", () => {
    expect(projectPlayer(flat(40, 5), flat(30, 5), { games: 6, average: 10 }).perGame).toBeCloseTo(40);
  });

  it("moves at most 8% for a change in minutes", () => {
    const up = projectPlayer(flat(30, 10), [...flat(20, 5), ...flat(40, 5)]);
    expect(up.perGame).toBeCloseTo(30 * 1.08);
    expect(up.factors[0]!.label).toBe("Minutes rising");
    const small = projectPlayer(flat(30, 10), [...flat(30, 5), ...flat(32, 5)]); // +3.2% minutes -> +1.6%
    expect(small.perGame).toBeCloseTo(30 * (1 + (32 / 31 - 1) * 0.5));
  });

  it("has nothing to say without games", () => {
    expect(projectPlayer([], []).perGame).toBe(0);
  });
});

describe("availabilityOutlook", () => {
  const P = true;
  const M = false;

  it("treats scattered missed games as a rate", () => {
    const outlook = availabilityOutlook([P, P, M, P, P, P, M, P, P, P], 70);
    expect(outlook).toMatchObject({ missedStreak: 0, longTermOut: false });
    expect(outlook.rate).toBeCloseTo((8 + 4.5) / 15);
  });

  it("does not call one rest day an injury", () => {
    const outlook = availabilityOutlook([P, P, P, P, P, P, P, P, P, M], 70);
    expect(outlook).toMatchObject({ missedStreak: 1, longTermOut: false });
    expect(outlook.rate).toBeGreaterThan(0.85);
  });

  it("does not hold a finished long absence against him", () => {
    const outlook = availabilityOutlook([P, P, M, M, M, M, M, M, P, P, P, P], 70);
    expect(outlook.longTermOut).toBe(false);
    expect(outlook.rate).toBeCloseTo((6 + 4.5) / 11); // the six-game absence is left out
  });

  it("expects a current long absence to last about as long again", () => {
    const outlook = availabilityOutlook([P, P, P, P, M, M, M, M, M, M, M, M, M, M], 68);
    expect(outlook).toMatchObject({ missedStreak: 10, longTermOut: true });
    expect(outlook.rate).toBeCloseTo(((4 + 4.5) / 9) * (1 - 10 / 68));
  });
});

describe("a lock-in week, on made-up players", () => {
  // One UTIL slot keeps the arithmetic easy to follow.
  const model: StrengthModel = {
    slots: ["UTIL"],
    slotOrder: [0],
    weeks: 1,
    players: new Map(),
    freeAgentIds: [],
    replacementProjection: 0,
    idealProjection: 0,
    replacementWeekly: 0,
  };
  const player = (id: string, games: [number, number][]) => {
    const made = steadyPlayer(model, id, ["SF"], 30);
    made.gameDay.fill(-1);
    games.forEach(([day, score], index) => {
      made.gameDay[index] = day;
      made.gameScore[index] = score;
    });
    return made;
  };

  it("locks a game that beats what is still to come", () => {
    // A steady 30 who plays Monday (50) and Friday: 50 beats waiting for a 30.
    expect(simulateWeek(model, [player("a", [[0, 50], [4, 30]])], 0).total).toBe(50);
  });

  it("passes on a poor game when a better one is likely later", () => {
    expect(simulateWeek(model, [player("a", [[0, 10], [4, 30]])], 0).total).toBe(30);
  });

  it("uses a bench player's big game on a day the starter is off", () => {
    // The starter plays only Friday. The bench player's 45 on Tuesday beats waiting for Friday's 30.
    const starter = player("a", [[4, 30]]);
    const bench = player("b", [[1, 45]]);
    expect(simulateWeek(model, [starter], 0).total).toBe(30);
    expect(simulateWeek(model, [starter, bench], 0).total).toBe(45);
  });

  it("can lose by waiting, as a real manager can", () => {
    // Monday's 10 is passed over for a likely 30 on Wednesday, which comes in at 5.
    expect(simulateWeek(model, [player("a", [[0, 10], [2, 5]])], 0).total).toBe(5);
  });

  it("averages weeks in projectRoster", () => {
    expect(projectRoster(model, [player("a", [[2, 25]])])).toBe(25);
  });
});
