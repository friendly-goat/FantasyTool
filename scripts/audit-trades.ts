// Audits the trade finder against a much more exhaustive reference search,
// on the sample league (server/mock.ts). For each team it runs findTrades,
// then enumerates every trade of one or two of your players for one or two
// of another team's (no value window), screens them all the same quick way,
// measures far more of them in full, and applies the finder's own final
// rules (pickIdeas, near-copies, variety). It prints where the reference
// finds better or more ideas than the finder.
//
//   npx tsx scripts/audit-trades.ts [--teams 3] [--goal best|C|send|get|injured] [--shortlist 400]
//   npx tsx scripts/audit-trades.ts --snapshot league.json --stats stats.json --team "Bazooka"
//
// A development tool: slow on purpose (minutes), never part of the app.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";
import { rosterPlayers } from "../shared/analysis.ts";
import type { LeagueSnapshot, StatsReport } from "../shared/types.ts";
import { teamSituations } from "../shared/insight.ts";
import { buildModel, leagueStrength, type ModelPlayer, projectedWeekly } from "../shared/strength.ts";
import {
  acceptanceChance,
  BIG_LOSS,
  chanceFrom,
  droppedOnArrival,
  evaluateTrade,
  type FinderOptions,
  findTrades,
  ideaRank,
  isInjuredTarget,
  type Likelihood,
  likelihood,
  limitRepeats,
  MAX_PRICE,
  MIN_GAIN,
  OPEN_SCREEN_WEEKS,
  pickIdeas,
  players,
  quickRosterAfter,
  quickRosterBefore,
  freeUpgrades,
  rosterIds,
  SCREEN_WEEKS,
  similarityKey,
  sumAverage,
  type TradeOffer,
  type TradeResult,
} from "../shared/trade.ts";

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};
const TEAMS = Number(arg("teams", "10"));
const SKIP = Number(arg("skip", "0"));
const GOAL = arg("goal", "best");
const SHORTLIST = Number(arg("shortlist", "400"));
// Save the reference results, or load saved ones, so the finder can be re-audited quickly while it changes.
const SAVE = arg("save", "");
const LOAD = arg("load", "");

// A real league instead of the sample: the JSON the app itself loads (signed in, open
// /api/league/<id> and /api/league/<id>/stats and save each page).
const SNAPSHOT = arg("snapshot", "");
const STATS = arg("stats", "");
const TEAM = arg("team", "");
async function sampleLeague(): Promise<{ snapshot: LeagueSnapshot; report: StatsReport }> {
  const raw = (await fetchFromMock("/players/nba")) as Record<string, unknown>;
  const allPlayers = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, allPlayers);
  const service = new StatsService(createMockStats(raw), { storage: null });
  await service.sync("2026");
  return { snapshot, report: await service.report(snapshot, allPlayers) };
}
const league =
  SNAPSHOT && STATS
    ? { snapshot: JSON.parse(readFileSync(SNAPSHOT, "utf8")) as LeagueSnapshot, report: JSON.parse(readFileSync(STATS, "utf8")) as StatsReport }
    : await sampleLeague();
const { snapshot } = league;
const model = buildModel(snapshot, league.report);
const situations = teamSituations(snapshot, model, leagueStrength(snapshot, model));
const urgency = (id: number) => situations.get(id)?.urgency ?? 0;
const order: Likelihood[] = ["likely", "possible", "long shot"];

interface Idea {
  offer: TradeOffer;
  result: TradeResult;
  chance: number;
  likelihood: Likelihood;
}
const gain = (idea: Idea) => idea.result.a.teamChange;
const score = (idea: Idea) => ideaRank(gain(idea), idea.chance);
const label = (idea: Idea) =>
  `${idea.result.a.gives.map((p) => p.name).join("+")} -> ${idea.result.a.gets.map((p) => p.name).join("+")} (team ${idea.offer.teamB})`;
const describe = (idea: Idea) =>
  `${label(idea)}  gain ${gain(idea).toFixed(2)}  chance ${(idea.chance * 100).toFixed(0)}%  ${idea.likelihood}  them ${idea.result.b.letter}`;

function pairs<T>(list: T[]): T[][] {
  const out: T[][] = list.map((item) => [item]);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i]!, list[j]!]);
  return out;
}

function reference(rosterId: number, options: FinderOptions) {
  const targeted = Boolean(options.givePlayerId || options.getPlayerId);
  const minGain = targeted ? -MAX_PRICE : MIN_GAIN;
  const weeks = targeted ? SCREEN_WEEKS : OPEN_SCREEN_WEEKS;
  const mine = rosterIds(snapshot, rosterId);
  const before = (roster: string[], sent: number, received: number) =>
    projectedWeekly(model, quickRosterBefore(model, roster, freeUpgrades(sent, received)), weeks);
  const at = (position?: string) => (player: ModelPlayer) => !position || player.positions.includes(position);
  const givers = players(model, mine).filter(
    (p) => p.games > 0 && at(options.givePosition)(p) && (!options.givePlayerId || p.id === options.givePlayerId),
  );
  const giveSets = pairs(players(model, mine).filter((p) => p.games > 0)).filter((set) =>
    options.givePlayerId ? set.some((p) => p.id === options.givePlayerId) : set.some((p) => givers.includes(p)),
  );
  const quick: { offer: TradeOffer; quick: number; chance: number }[] = [];
  let considered = 0;
  for (const team of snapshot.teams) {
    if (team.rosterId === rosterId) continue;
    const theirs = rosterIds(snapshot, team.rosterId);
    const byValue = players(model, theirs).sort((a, b) => a.expected - b.expected);
    const targets = players(model, theirs).filter((p) => p.games > 0 || isInjuredTarget(p));
    const getSets = pairs(targets).filter((set) =>
      set.some(
        (p) =>
          at(options.getPosition)(p) &&
          (!options.getPlayerId || p.id === options.getPlayerId) &&
          (!options.getInjured || isInjuredTarget(p)),
      ),
    );
    for (const gives of giveSets) {
      for (const gets of getSets) {
        considered++;
        const g = projectedWeekly(model, quickRosterAfter(model, mine, gives.map((p) => p.id), gets), weeks) - before(mine, gives.length, gets.length);
        if (g < minGain) continue;
        const theirGain =
          projectedWeekly(model, quickRosterAfter(model, theirs, gets.map((p) => p.id), gives), weeks) - before(theirs, gets.length, gives.length);
        const dropped = gives.length > gets.length ? byValue.filter((p) => !gets.includes(p)).slice(0, gives.length - gets.length) : [];
        const chance = chanceFrom(theirGain, sumAverage(gives) - sumAverage(dropped), sumAverage(gets), urgency(team.rosterId));
        if (chance < 0.1) continue;
        quick.push({
          offer: { teamA: rosterId, teamB: team.rosterId, aGives: gives.map((p) => p.id), bGives: gets.map((p) => p.id) },
          quick: ideaRank(g, chance),
          chance,
        });
      }
    }
  }
  // Measure many in full: the best by quick rank overall, plus the best few for every player you could get.
  quick.sort((a, b) => b.quick - a.quick);
  const chosenOffers = new Set(quick.slice(0, SHORTLIST));
  const perGet = new Map<string, number>();
  for (const candidate of quick) {
    const key = candidate.offer.bGives.join("+");
    if ((perGet.get(key) ?? 0) >= 3) continue;
    perGet.set(key, (perGet.get(key) ?? 0) + 1);
    chosenOffers.add(candidate);
  }
  const measured: Idea[] = [...chosenOffers].map(({ offer }) => {
    const result = evaluateTrade(model, snapshot, offer);
    const chance = acceptanceChance(result.b, urgency(offer.teamB));
    return { offer, result, chance, likelihood: likelihood(chance) };
  });
  const kept = measured
    .filter((idea) => gain(idea) >= minGain && idea.result.b.grade >= BIG_LOSS)
    .filter((idea) => !droppedOnArrival(idea.result.a) && !droppedOnArrival(idea.result.b))
    .sort((a, b) => order.indexOf(a.likelihood) - order.indexOf(b.likelihood) || score(b) - score(a))
    .filter(
      (() => {
        const seen = new Set<string>();
        return (idea: Idea) => {
          const key = similarityKey(idea.offer, idea.result, options.givePlayerId);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        };
      })(),
    )
    .filter(limitRepeats((idea: Idea) => [...idea.offer.aGives, ...idea.offer.bGives], options));
  const picked = pickIdeas(kept, 8, { targeted, yourChange: gain, theirWorstGrade: (idea) => idea.result.b.grade });
  return { ...picked, considered, screened: quick.length, measured: measured.length };
}

/** A single number for a list of ideas: likely ideas' scores count fully, possible half, long shots a quarter. */
function value(ideas: Idea[], top = 5): number {
  const weight: Record<Likelihood, number> = { likely: 1, possible: 0.5, "long shot": 0.25 };
  return ideas.slice(0, top).reduce((sum, idea) => sum + Math.max(0, score(idea)) * weight[idea.likelihood], 0);
}

let totalFinder = 0;
let totalReference = 0;
let totalMs = 0;
const saved: Record<string, TradeOffer[]> = LOAD && existsSync(LOAD) ? JSON.parse(readFileSync(LOAD, "utf8")) : {};
const toSave: Record<string, TradeOffer[]> = {};
/** Re-measures saved reference offers (cheap: a few full evaluations). */
const remeasure = (offers: TradeOffer[]): Idea[] =>
  offers.map((offer) => {
    const result = evaluateTrade(model, snapshot, offer);
    const chance = acceptanceChance(result.b, urgency(offer.teamB));
    return { offer, result, chance, likelihood: likelihood(chance) };
  });
const audited = TEAM
  ? snapshot.teams.filter((team) => String(team.rosterId) === TEAM || team.teamName.toLowerCase().includes(TEAM.toLowerCase()))
  : snapshot.teams.slice(SKIP, SKIP + TEAMS);
for (const team of audited) {
  const mine = rosterPlayers(team).map((p) => p.id);
  const ranked = players(model, mine).filter((p) => p.games > 0).sort((a, b) => b.expected - a.expected);
  const target = snapshot.teams.find((t) => t.rosterId !== team.rosterId)!;
  const theirBest = players(model, rosterIds(snapshot, target.rosterId)).sort((a, b) => b.expected - a.expected)[1];
  const options: FinderOptions =
    GOAL === "C"
      ? { getPosition: "C" }
      : GOAL === "send"
        ? { givePlayerId: ranked[2]?.id }
        : GOAL === "get"
          ? { getPlayerId: theirBest?.id }
          : GOAL === "injured"
            ? { getInjured: true }
            : {};
  let start = performance.now();
  const found = findTrades(model, snapshot, team.rosterId, situations, options);
  const finderMs = performance.now() - start;
  totalMs += finderMs;
  start = performance.now();
  const key = `${GOAL}:${team.rosterId}`;
  const ref = saved[key]
    ? { chosen: remeasure(saved[key]!), outlook: "saved", considered: 0, screened: 0, measured: 0 }
    : reference(team.rosterId, options);
  toSave[key] = ref.chosen.map((idea) => idea.offer);
  const refMs = performance.now() - start;
  const f = value(found.ideas);
  const r = value(ref.chosen);
  totalFinder += f;
  totalReference += r;
  console.log(
    `\n== ${team.teamName} (${team.rosterId}) finder ${found.outlook} ${found.ideas.length} ideas, ${finderMs.toFixed(0)} ms, value ${f.toFixed(2)} | reference ${ref.outlook} ${ref.chosen.length}, ${(refMs / 1000).toFixed(1)} s, value ${r.toFixed(2)} (considered ${ref.considered}, screened ${ref.screened}, measured ${ref.measured})`,
  );
  const finderKeys = new Set(found.ideas.map((idea) => similarityKey(idea.offer, idea.result, options.givePlayerId)));
  for (const idea of ref.chosen.slice(0, 5)) {
    const has = finderKeys.has(similarityKey(idea.offer, idea.result, options.givePlayerId));
    console.log(`  ${has ? "  both" : "  MISS"} ${describe(idea)}`);
  }
  for (const idea of found.ideas.slice(0, 5)) console.log(`  finder ${describe(idea)}`);
}
console.log(`\nTotal value: finder ${totalFinder.toFixed(2)}, reference ${totalReference.toFixed(2)}; finder time ${(totalMs / 1000).toFixed(1)} s`);
if (SAVE) writeFileSync(SAVE, JSON.stringify({ ...saved, ...toSave }, null, 1));
