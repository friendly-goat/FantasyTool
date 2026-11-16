// Stats check: downloads game stats from balldontlie, matches them to the
// players in your Sleeper league, and prints what it found.
//
//   npm run check:stats -- <league_id>
//
// Needs BALLDONTLIE_API_KEY in .env. The first run downloads the season so
// far (about a minute); the result is saved in .cache/ and reused by the app.

import { fetchFromSleeper } from "../server/sleeper.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { createBalldontlie } from "../server/stats/balldontlie.ts";
import { StatsService } from "../server/stats/service.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // Handled below when the key is missing.
}

const leagueId = process.argv[2] || process.env.SLEEPER_LEAGUE_ID;
const apiKey = process.env.BALLDONTLIE_API_KEY?.trim();

async function main() {
  if (!apiKey) throw new Error("BALLDONTLIE_API_KEY is not set. Add it to .env.");
  if (!leagueId) throw new Error("Pass your league ID: npm run check:stats -- <league_id>");

  const players = await loadPlayers(fetchFromSleeper);
  const snapshot = await buildSnapshot(leagueId, fetchFromSleeper, players);
  console.log(`League: ${snapshot.league.name}, season ${snapshot.league.season}`);

  const provider = createBalldontlie(apiKey);
  const service = new StatsService(
    {
      name: provider.name,
      fetchGameLines: (season, fromDate, onPage) =>
        provider.fetchGameLines(season, fromDate, (pages) => {
          process.stdout.write(`\rDownloading game stats: page ${pages}`);
          onPage(pages);
        }),
    },
    { dir: ".cache" },
  );
  await service.sync(snapshot.league.season);
  process.stdout.write("\n");

  const report = await service.report(snapshot, players);
  if (report.status === "error") throw new Error(report.message ?? "The download failed.");

  const all = Object.values(report.players);
  const rosteredIds = new Set(
    snapshot.teams.flatMap((team) => [
      ...team.starters.flatMap((starter) => (starter.player ? [starter.player.id] : [])),
      ...team.bench.map((player) => player.id),
      ...team.reserve.map((player) => player.id),
    ]),
  );
  const row = (player: (typeof all)[number]) => ({
    player: player.name,
    team: player.team,
    games: player.games,
    fantasyAvg: Number(player.fantasyAvg.toFixed(1)),
    last5: player.recentAvg == null ? null : Number(player.recentAvg.toFixed(1)),
    pts: Number(player.averages.pts.toFixed(1)),
    reb: Number(player.averages.reb.toFixed(1)),
    ast: Number(player.averages.ast.toFixed(1)),
  });
  const top = (list: typeof all) =>
    [...list].sort((a, b) => b.fantasyAvg - a.fantasyAvg).slice(0, 10).map(row);

  console.log(`\nPlayers with stats: ${all.length}`);
  console.log(`Rostered players with stats: ${all.filter((p) => rosteredIds.has(p.id)).length} of ${rosteredIds.size}`);
  console.log(
    "Rostered players without stats (injured all season, or a name mismatch):",
    report.unmatchedRostered.map((player) => `${player.name} [Sleeper ID ${player.id}]`),
  );
  console.log("Scoring settings not covered by the stats source:", report.ignoredScoring);

  console.log("\nTop 10 rostered players by fantasy average:");
  console.table(top(all.filter((player) => rosteredIds.has(player.id))));
  console.log("Top 10 free agents by fantasy average:");
  console.table(top(all.filter((player) => !rosteredIds.has(player.id))));
}

main().catch((error) => {
  console.error("\nCheck failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
