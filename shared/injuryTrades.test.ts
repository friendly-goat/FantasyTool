import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats, mockInjuries } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { rosterPlayers } from "./analysis.ts";
import { teamSituations } from "./insight.ts";
import { topMoves } from "./moves.ts";
import {
  buildModel,
  expectedOnceBack,
  fillRoster,
  FREE_UPGRADES,
  leagueStrength,
  type ModelPlayer,
  projectedWeekly,
  reserveEligible,
} from "./strength.ts";
import {
  acceptance,
  chanceWord,
  chanceFrom,
  droppedOnArrival,
  evaluateTrade,
  findTrades,
  isLongInjury,
  outLabel,
  daysOut,
  isInjuredTarget,
  playerValue,
  POSSIBLE,
  reserveMoves,
  seenAverage,
  sumOwn,
  heldInjury,
  similarityKey,
  tradePhases,
} from "./trade.ts";

describe("injuries, IR and waiver pickups (against the mock league)", async () => {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  await service.sync("2025");
  const healthy = buildModel(snapshot, await service.report(snapshot, players));
  const stats = await service.report(snapshot, players, mockInjuries(raw));
  const model = buildModel(snapshot, stats);
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

  it("takes IR slots from the league settings, as Sleeper sends them", () => {
    expect(snapshot.league.rosterPositions).not.toContain("IR");
    expect(snapshot.league.reserveSlots).toBe(1);
    expect(model.rosterLimits).toEqual({ active: snapshot.league.rosterPositions.length, reserve: 1 });
  });

  it("puts a benched player marked out on a free IR slot instead of dropping someone for a two-for-one", () => {
    // A team whose Sleeper IR is empty, with a player marked out on its bench, receives two for one.
    const team = snapshot.teams.find((candidate) => candidate.rosterId === strengths[3]!.rosterId)!;
    const benched = { ...snapshot, teams: snapshot.teams.map((t) => (t === team ? { ...t, bench: [...t.bench, ...t.reserve], reserve: [] } : t)) };
    const local = buildModel(benched, { ...stats, players: { ...stats.players } });
    for (const id of ids(team.rosterId)) local.players.get(id)!.irEligible = false;
    const out = ids(team.rosterId).map((id) => local.players.get(id)!).filter((p) => p.games > 0).sort((a, b) => a.expected - b.expected)[0]!;
    out.irEligible = true;
    const other = strengths.find((entry) => entry.rosterId !== team.rosterId)!.rosterId;
    const theirs = ids(other).map((id) => local.players.get(id)!).filter((p) => p.games > 0 && !p.irEligible);
    const give = ids(team.rosterId).map((id) => local.players.get(id)!).find((p) => p !== out && p.games > 0)!;
    const result = evaluateTrade(local, benched, {
      teamA: team.rosterId,
      teamB: other,
      aGives: [give.id],
      bGives: theirs.slice(0, 2).map((p) => p.id),
    });
    expect(result.a.reserve).toContain(out);
    expect(result.a.drops).not.toContain(out);
    const active = result.a.afterIds.filter((id) => !id.includes("~") && id !== out.id);
    expect(active.length).toBeLessThanOrEqual(local.rosterLimits.active);
    expect(reserveMoves(result.a, [], local)).toContain(`Move ${out.name} to IR: he is out and an IR slot is free.`);
  });

  it("lets only the statuses the league allows onto IR", () => {
    const standard = { out: true, doubtful: false, suspended: false, dayToDay: false };
    expect(reserveEligible("Out", standard)).toBe(true);
    expect(reserveEligible("OUT", undefined)).toBe(true);
    expect(reserveEligible("DTD", standard)).toBe(false);
    expect(reserveEligible("Day-To-Day", { ...standard, dayToDay: true })).toBe(true);
    expect(reserveEligible("Suspended", standard)).toBe(false);
    expect(reserveEligible("Questionable", { out: true, doubtful: true, suspended: true, dayToDay: true })).toBe(false);
    expect(reserveEligible(null, standard)).toBe(false);
  });

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
    // Swap two healthy mid-roster players between teams (the weakest could be worth less than a
    // free agent, and so be swapped out as soon as he arrives): any IR stand-in or free upgrade
    // each team already had is in both its before and after rosters, so it is not a trade pickup.
    const [a, b] = [strengths[0]!.rosterId, strengths[1]!.rosterId];
    const benchOf = (rosterId: number) => {
      const healthy = ids(rosterId).map((id) => model.players.get(id)!).filter((p) => !p.back && p.games > 0).sort((x, y) => x.expected - y.expected);
      return healthy[Math.floor(healthy.length / 2)]!;
    };
    const result = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: [benchOf(a).id], bGives: [benchOf(b).id] });
    // No IR stand-in shows up as the trade's pickup. (A free upgrade at the end of the bench may:
    // one worth just under the bar before the trade can be worth just over it after.)
    expect(result.a.pickups.filter((pickup) => pickup.forInjured)).toHaveLength(0);
    expect(result.b.pickups.filter((pickup) => pickup.forInjured)).toHaveLength(0);
    // Sending two for one opens a spot, and it is filled: by a lasting pickup, or by a player
    // the team's free upgrades would otherwise have let go. Never left empty.
    const two = ids(a).map((id) => model.players.get(id)!).filter((p) => !p.back && p.games > 0).slice(0, 2);
    const twoForOne = evaluateTrade(model, snapshot, { teamA: a, teamB: b, aGives: two.map((p) => p.id), bGives: [benchOf(b).id] });
    expect(twoForOne.a.afterIds).toHaveLength(twoForOne.a.beforeIds.length);
    expect(twoForOne.a.pickups.every((pickup) => !twoForOne.a.beforeIds.includes(pickup.player.id))).toBe(true);
  });

  it("splits a trade for an injured player into the weeks he is out and the weeks after", () => {
    let idea: ReturnType<typeof findTrades>["ideas"][number] | undefined;
    for (const { rosterId } of strengths) {
      // One where he is all you get (in a package, someone else can matter more while he is out).
      idea = findTrades(model, snapshot, rosterId, situations, { getInjured: true }).ideas.find((candidate) => {
        const phases = tradePhases(model, candidate.result.a);
        return phases && candidate.result.a.gets.length === 1 && candidate.result.a.gets[0] === phases.player;
      });
      if (idea) break;
    }
    if (!idea) throw new Error("no trade for an injured player found");
    const phases = tradePhases(model, idea.result.a)!;
    expect(idea.result.a.gets.map((player) => player.id)).toContain(phases.player.id);
    expect(phases.weeksOut).toBeGreaterThan(0);
    // He gives you nothing until he is back, then his full level.
    expect(phases.afterBack).toBeGreaterThan(phases.whileOut);
    // The whole-season change is the weeks blended.
    const weeks = model.calendar.weeks.length;
    const blended = (phases.whileOut * phases.weeksOut + phases.afterBack * (weeks - phases.weeksOut)) / weeks;
    expect(blended).toBeCloseTo(idea.result.a.teamChange, 0);
  }, 120_000);

  it("discounts an injured player a manager would receive, never his own", () => {
    const injured = named(/six weeks/);
    expect(seenAverage(injured)).toBeLessThan(injured.average * (1 - injured.outShare));
    expect(seenAverage(injured)).toBeGreaterThanOrEqual(injured.average * 0.2 - 1e-9);
    const fit = all.find((player) => !player.back && player.games > 5)!;
    expect(seenAverage(fit)).toBe(fit.average);
    expect(seenAverage(named(/for the season/))).toBeCloseTo(named(/for the season/).average * 0.2);
    expect(sumOwn([injured, fit])).toBeCloseTo(injured.average + fit.average);
  });

  it("judges the team of a manager selling his injured star from the star's return, so he is no easier to get", () => {
    const injured = named(/six weeks/);
    const seller = teamOf(injured);
    const buyer = strengths.find((entry) => entry.rosterId !== seller.rosterId)!.rosterId;
    const give = ids(buyer).map((id) => model.players.get(id)!).find((p) => !p.back && p.games > 0)!;
    const offer = { teamA: buyer, teamB: seller.rosterId, aGives: [give.id], bGives: [injured.id] };
    const result = evaluateTrade(model, snapshot, offer);
    expect(result.b.held?.player.id).toBe(injured.id);
    expect(result.a.held).toBeNull();
    const now = acceptance(result.b, 0);
    expect(now.parts[1]!.label).toContain(injured.name);
    // Selling him now is no easier than selling him healthy (as the zeros once made it).
    const ifHealthy = acceptance(evaluateTrade(healthy, snapshot, offer).b, 0).chance;
    expect(now.chance).toBeLessThanOrEqual(ifHealthy + 0.02);
    // The grade still counts the whole season, weeks out included.
    expect(result.b.teamChange).not.toBeCloseTo(result.b.held!.change, 2);
    // A healthy player, or one out for the season (who never comes back), is not held this way.
    expect(heldInjury(model, [give])).toBeNull();
    expect(heldInjury(model, [named(/for the season/)])).toBeNull();
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

  it("calls only long injuries long: a few games out is not", () => {
    // A calendar of its own (the sample league's week can lag the clock): today is a Tuesday.
    const weeks = ["2026-11-23", "2026-11-30", "2026-12-07", "2026-12-14"].map((start, index) => ({
      week: 6 + index,
      start,
      end: ["2026-11-29", "2026-12-06", "2026-12-13", "2026-12-20"][index]!,
    }));
    const dated = { ...model, calendar: { ...model.calendar, today: "2026-11-24", weeks } } as typeof model;
    const out = (back: number[]) => ({ ...named(/ankle soreness/), back: Float32Array.from(back), outShare: 0.1 });
    expect(daysOut(dated, out([0.6, 1, 1, 1]))).toBeCloseTo(2.4, 1); // a game or two
    expect(isLongInjury(dated, out([0, 0.7, 1, 1]))).toBe(false); // about eight days, a few games
    expect(isLongInjury(dated, out([0, 0, 0.7, 1]))).toBe(true); // about two weeks
    expect(isLongInjury(model, named(/six weeks/))).toBe(true);
    expect(isLongInjury(model, named(/for the season/))).toBe(true);
    expect(isLongInjury(healthy, healthy.players.get(named(/six weeks/).id)!)).toBe(false);
    expect(outLabel(model, named(/for the season/))).toBe("Out for season");
    expect(outLabel(model, named(/six weeks/))).toMatch(/^Out \d+ weeks$/);
    expect(outLabel(dated, out([0.6, 1, 1, 1])) ?? "").not.toMatch(/weeks|days/);
  });

  it("leaves long injuries out of every trade by default, on both sides, but never a named player", () => {
    const longOut = (player: ModelPlayer) => isLongInjury(model, player);
    let found = 0;
    for (const { rosterId } of strengths.slice(0, 4)) {
      const { ideas } = findTrades(model, snapshot, rosterId, situations);
      for (const idea of ideas) {
        found++;
        expect([...idea.result.a.gives, ...idea.result.a.gets].some(longOut)).toBe(false);
      }
    }
    expect(found).toBeGreaterThan(0);
    // Named: an injured player asked for by name is still searched for.
    const injured = named(/six weeks/);
    const buyer = strengths.find((entry) => entry.rosterId !== teamOf(injured).rosterId)!.rosterId;
    const { ideas } = findTrades(model, snapshot, buyer, situations, { getPlayerId: injured.id });
    for (const idea of ideas) expect(idea.result.a.gets.some((player) => player.id === injured.id)).toBe(true);
    // Trading for an injured player lets them in, as does asking for them.
    const forInjured = findTrades(model, snapshot, strengths[0]!.rosterId, situations, { getInjured: true, includeInjured: true });
    const plain = findTrades(model, snapshot, strengths[0]!.rosterId, situations, { getInjured: true });
    expect(forInjured.ideas.map((idea) => idea.offer)).toEqual(plain.ideas.map((idea) => idea.offer));
  }, 60_000);

  it("gives the top moves one trade for an injured player, and no long injuries elsewhere", () => {
    let withInjured = 0;
    for (const { rosterId } of strengths.slice(0, 4)) {
      const best = findTrades(model, snapshot, rosterId, situations);
      const injured = findTrades(model, snapshot, rosterId, situations, { getInjured: true });
      const moves = topMoves(model, snapshot, rosterId, situations, undefined, undefined, best, injured);
      expect(moves.length).toBeLessThanOrEqual(5);
      const forInjured = moves.filter((move) => move.forInjured);
      expect(forInjured.length).toBeLessThanOrEqual(1);
      const helps = injured.ideas.some((idea) => idea.likelihood !== "long shot" && idea.result.a.teamChange > 0);
      if (helps) expect(forInjured.length).toBe(1);
      withInjured += forInjured.length;
      for (const move of moves.filter((candidate) => candidate.kind === "trade" && !candidate.forInjured)) {
        expect([...move.gets, ...move.gives].some((player) => isLongInjury(model, player))).toBe(false);
      }
      moves.forEach((move, index) => {
        expect(move.weeklyChange).toBeGreaterThan(0);
        if (index > 0) expect(move.strengthChange).toBeLessThanOrEqual(moves[index - 1]!.strengthChange);
      });
    }
    expect(withInjured).toBeGreaterThan(0);
  }, 120_000);

  it("counts an injured player's value only in the weeks he plays", () => {
    const injured = named(/six weeks/);
    const playing = 1 - injured.outShare;
    expect(playerValue(model, injured)).toBeCloseTo(
      Math.max(0, injured.expected / playing - model.replacementWeekly) * playing,
    );
    expect(playerValue(model, injured)).toBeGreaterThanOrEqual(Math.max(0, injured.expected - model.replacementWeekly));
    expect(playerValue(model, named(/for the season/))).toBe(0);
  });

  it("says when a received injured player cannot go on IR because it is full", () => {
    const injured = named(/six weeks/);
    // A team whose own IR holds a player out longer (out for the season).
    const season = named(/for the season/);
    const buyer = teamOf(season);
    if (buyer.rosterId === teamOf(injured).rosterId) return;
    const give = ids(buyer.rosterId).map((id) => model.players.get(id)!).find((p) => !p.back && p.games > 0)!;
    const result = evaluateTrade(model, snapshot, { teamA: buyer.rosterId, teamB: teamOf(injured).rosterId, aGives: [give.id], bGives: [injured.id] });
    expect(result.a.reserve.map((p) => p.id)).toContain(season.id);
    expect(result.a.noReserve.map((p) => p.id)).toContain(injured.id);
    expect(result.a.pickups.some((pickup) => pickup.forInjured?.id === injured.id)).toBe(false);
  });

  it("keeps a trade that clearly costs the other team unlikely, however good it looks on averages", () => {
    // Seen at its best (+0.8) and no pressure: a loss of 7 a week still leaves it a long shot.
    expect(chanceFrom(-7, 40, 20, 0)).toBeLessThan(POSSIBLE);
  });

  it("never lists two versions of the same offer (same team, same players back, same main piece)", () => {
    for (const { rosterId } of strengths.slice(0, 3)) {
      for (const options of [{}, { getInjured: true }]) {
        const { ideas } = findTrades(model, snapshot, rosterId, situations, options);
        const keys = ideas.map((idea) => similarityKey(idea.offer, idea.result));
        expect(new Set(keys).size).toBe(keys.length);
        // Nobody is sent a player he would drop as soon as he arrives.
        for (const idea of ideas) {
          expect(droppedOnArrival(idea.result.a)).toBe(false);
          expect(droppedOnArrival(idea.result.b)).toBe(false);
        }
      }
    }
  }, 120_000);

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
        // Everyone who stays is worth at least as much as whoever goes first, once he is back.
        const first = goes[0]!;
        const staying = filled.ids.flatMap((id) => model.players.get(id) ?? []).filter((p) => !filled.reserve.includes(p));
        expect(staying.every((p) => expectedOnceBack(p, first.when) >= expectedOnceBack(first.player, first.when))).toBe(true);
      }
      const active = filled.ids.filter((id) => !filled.reserve.some((p) => p.id === id));
      expect(active.length).toBeLessThanOrEqual(model.rosterLimits.active);
    }
  });
  it("never drops a player who is out for now but back before the player who takes his IR slot", () => {
    // A team with a good player out for a few weeks on IR sends two for one to get a player out
    // longer. The newcomer takes the IR slot and the first player waits on the bench; when the
    // newcomer is back, the one to go is the pickup made for the open spot, never the first player,
    // even though his weeks out make his average over the season lower than the pickup's.
    const local = buildModel(snapshot, { ...stats, players: { ...stats.players } });
    const weeks = local.calendar.weeks.length;
    const team = snapshot.teams.find((candidate) => candidate.rosterId === strengths[2]!.rosterId)!;
    const other = snapshot.teams.find((candidate) => candidate.rosterId === strengths[5]!.rosterId)!;
    for (const id of [...ids(team.rosterId), ...ids(other.rosterId)]) local.players.get(id)!.irEligible = false;
    const injure = (player: ModelPlayer, out: number) => {
      const back = Float32Array.from({ length: weeks }, (_, week) => (week < out ? 0 : 1));
      player.irEligible = true;
      player.back = back;
      player.outShare = out / weeks;
      const weekly = player.weekly;
      player.weekly = Float32Array.from(back, (chance, week) => weekly[week % weekly.length]! * chance);
      player.expected = player.weekly.reduce((sum, value) => sum + value, 0) / player.weekly.length;
    };
    const roster = ids(team.rosterId).map((id) => local.players.get(id)!).sort((a, b) => b.expected - a.expected);
    const bestFree = Math.max(...local.freeAgentIds.slice(0, 20).map((id) => local.players.get(id)!.expected));
    // A player clearly better than any free agent, out long enough to average less this season than
    // anyone staying on the roster and any free agent.
    const first = roster.find((p) => p.expected > bestFree * 1.1 && p.expected < bestFree * 1.6)!;
    // The roster the trade is made on (after the free upgrades a two-for-one allows), less the two
    // mid-roster players the team sends.
    const kept = fillRoster(local, ids(team.rosterId), new Set(), [], FREE_UPGRADES).kept.map((id) => local.players.get(id)!);
    const others = roster.filter((p) => p !== first && kept.includes(p));
    const two = others.slice(Math.floor(others.length / 2) - 1, Math.floor(others.length / 2) + 1);
    const lowest = Math.min(bestFree, ...kept.filter((p) => p !== first && !two.includes(p)).map((p) => p.expected));
    const out = Math.ceil(weeks * (1 - (lowest * 0.9) / first.expected));
    expect(out).toBeLessThan(weeks - 4);
    injure(first, out);
    expect(first.expected).toBeLessThan(lowest);
    const target = rosterPlayers(other).map((ref) => local.players.get(ref.id)!).sort((a, b) => b.expected - a.expected)[0]!;
    injure(target, out + 3);
    const result = evaluateTrade(local, snapshot, { teamA: team.rosterId, teamB: other.rosterId, aGives: two.map((p) => p.id), bGives: [target.id] });
    expect(result.a.reserve).toEqual([target]);
    expect(result.a.leaving.some((entry) => entry.player === first)).toBe(false);
    expect(result.a.drops).not.toContain(first);
    // Sending two for one, nobody on the roster now goes, then or later.
    expect(result.a.leaving.filter((entry) => !entry.pickedUp)).toHaveLength(0);
    expect(result.a.drops).toHaveLength(0);
    const onIr = [{ id: first.id, name: first.name }];
    expect(reserveMoves(result.a, onIr, local).join(" ")).toContain(`${first.name} waits on the bench until he is back`);
  });

  it("never credits a trade with a free agent the team could pick up anyway", () => {
    // Adding a player worth less than the best free agent to a trade changes nothing: either way
    // the team swaps him for that free agent (a free upgrade), before the trade and after it.
    let checked = 0;
    const best = model.players.get(model.freeAgentIds[0]!)!;
    for (const { rosterId } of strengths) {
      const mine = ids(rosterId).map((id) => model.players.get(id)!).filter((p) => !p.back);
      const weakest = mine.reduce((low, p) => (p.expected < low.expected ? p : low));
      if (best.expected <= weakest.expected) continue;
      const mid = [...mine].sort((x, y) => x.expected - y.expected)[Math.floor(mine.length / 2)]!;
      const other = strengths.find((team) => team.rosterId !== rosterId)!.rosterId;
      const theirs = ids(other).map((id) => model.players.get(id)!).filter((p) => !p.back).sort((x, y) => x.expected - y.expected);
      const target = theirs[Math.floor(theirs.length / 2)]!;
      const gain = (aGives: string[]) => {
        const { a } = evaluateTrade(model, snapshot, { teamA: rosterId, teamB: other, aGives, bGives: [target.id] });
        return a.projectedAfter - a.projectedBefore;
      };
      // The same up to how the free agents and the traded players fit together (the two-for-one
      // is made on the roster after the team's free upgrades, the one-for-one on the roster as it is).
      const [one, two] = [gain([mid.id]), gain([mid.id, weakest.id])];
      expect(Math.abs(two - one)).toBeLessThanOrEqual(Math.max(0.5, 0.15 * Math.abs(one)));
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
    // The roster as it stands takes no free upgrades: strength is the team as it is run today.
    const team = strengths.find(({ rosterId }) => fillRoster(model, ids(rosterId), new Set(), [], FREE_UPGRADES).adds.length > 0)!;
    expect(fillRoster(model, ids(team.rosterId)).adds.length).toBeLessThan(fillRoster(model, ids(team.rosterId), new Set(), [], FREE_UPGRADES).adds.length);
    // The roster a trade is made on is never worse than the team as it stands (a team with more
    // players out than IR slots once came out weaker, which made every trade look good to it).
    for (const { rosterId } of strengths) {
      const other = strengths.find((entry) => entry.rosterId !== rosterId)!.rosterId;
      const { a } = evaluateTrade(model, snapshot, { teamA: rosterId, teamB: other, aGives: [ids(rosterId)[0]!], bGives: [ids(other)[0]!] });
      expect(projectedWeekly(model, a.beforeIds)).toBeGreaterThanOrEqual(a.projectedBefore - 1e-9);
    }
  }, 60_000);

  it("searches packages of up to two players a side, and keeps every rule for them", () => {
    let packages = 0;
    for (const { rosterId } of strengths.slice(0, 3)) {
      const { ideas } = findTrades(model, snapshot, rosterId, situations);
      for (const idea of ideas) {
        if (idea.offer.aGives.length + idea.offer.bGives.length > 2) packages++;
        expect(idea.offer.aGives.length).toBeLessThanOrEqual(3);
        expect(idea.offer.bGives.length).toBeLessThanOrEqual(2);
        expect(droppedOnArrival(idea.result.a) || droppedOnArrival(idea.result.b)).toBe(false);
        expect(idea.result.b.grade).toBeGreaterThanOrEqual(20);
        expect(idea.result.a.projectedAfter - idea.result.a.projectedBefore).toBeGreaterThanOrEqual(0.3);
      }
      // No near-copies: one version of an idea.
      const keys = ideas.map((idea) => similarityKey(idea.offer, idea.result));
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(packages).toBeGreaterThan(0);
  }, 60_000);
});

describe("chance words", () => {
  it("names a chance in seven steps, so even odds are a toss-up, not likely", () => {
    expect(chanceWord(0.03)).toEqual({ word: "Never", step: 0 });
    expect(chanceWord(0.15).word).toBe("Unlikely");
    expect(chanceWord(0.3).word).toBe("Probably not");
    expect(chanceWord(0.51).word).toBe("Toss-up");
    expect(chanceWord(0.62).word).toBe("Maybe");
    expect(chanceWord(0.75).word).toBe("Likely");
    expect(chanceWord(0.95)).toEqual({ word: "For sure", step: 6 });
    // Steps never go down as the chance rises.
    const steps = Array.from({ length: 101 }, (_, i) => chanceWord(i / 100).step);
    expect(steps.every((step, i) => i === 0 || step >= steps[i - 1]!)).toBe(true);
  });

});
