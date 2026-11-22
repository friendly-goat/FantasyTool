import { readFileSync } from "node:fs";
import { teamSituations } from "../shared/insight.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import { findTrades } from "../shared/trade.ts";
const snapshot = JSON.parse(readFileSync("/tmp/real/league.json", "utf8"));
const report = JSON.parse(readFileSync("/tmp/real/stats.json", "utf8"));
const model = buildModel(snapshot, report);
const situations = teamSituations(snapshot, model, leagueStrength(snapshot, model));
const team = Number(process.argv[2] ?? 7);
const res = findTrades(model, snapshot, team, situations, {}, 8);
const name = (id: number) => snapshot.teams.find((t: any) => t.rosterId === id)?.teamName.slice(0, 10);
const tag = (p: any) => `${p.name.split(" ").pop()}${p.outShare > 0.05 ? `(out ${Math.round(p.outShare * 100)}%)` : ""}`;
for (const idea of res.ideas) {
  const r = idea.result;
  console.log(`${idea.offer.aGives.length}-for-${idea.offer.bGives.length} with ${name(idea.offer.teamB)}: give ${r.a.gives.map(tag).join("+")} get ${r.a.gets.map(tag).join("+")} | gain ${r.a.teamChange.toFixed(2)} chance ${(idea.chance * 100).toFixed(0)}% them ${r.b.teamChange.toFixed(2)}`);
}
if (process.argv[3]) {
  const target = [...model.players.values()].find((p) => p.name.includes(process.argv[3]!))!;
  console.log("\n== trade away", target.name);
  const named = findTrades(model, snapshot, team, situations, { givePlayerId: target.id }, 8);
  for (const idea of named.ideas) {
    const r = idea.result;
    console.log(`${idea.offer.aGives.length}-for-${idea.offer.bGives.length} with ${name(idea.offer.teamB)}: give ${r.a.gives.map(tag).join("+")} get ${r.a.gets.map(tag).join("+")} | gain ${r.a.teamChange.toFixed(2)} chance ${(idea.chance * 100).toFixed(0)}%`);
  }
}
