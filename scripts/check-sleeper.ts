// Connectivity check: confirms Sleeper's API answers for NBA from this
// machine, and optionally that a specific league loads.
//
//   npm run check:sleeper                -> checks the NBA endpoints
//   npm run check:sleeper -- <league_id> -> also loads that league
//
// It makes at most a dozen requests.

import { fetchFromSleeper, type RawState } from "../server/sleeper.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file is fine.
}

const leagueId = process.argv[2] || process.env.SLEEPER_LEAGUE_ID;

async function main() {
  const state = (await fetchFromSleeper("/state/nba")) as RawState;
  console.log("NBA state:", state);

  const players = await loadPlayers(fetchFromSleeper);
  console.log(`Player list: ${Object.keys(players).length} players`);

  if (!leagueId) {
    console.log("\nNo league ID given. Pass one to check a league as well.");
    return;
  }

  const snapshot = await buildSnapshot(leagueId, fetchFromSleeper, players);
  console.log(`\nLeague: ${snapshot.league.name} (${snapshot.league.season}), week ${snapshot.week}`);
  console.log("Lineup slots:", snapshot.league.rosterPositions.join(", "));
  console.log("Scoring settings:", snapshot.league.scoringSettings);
  console.table(
    snapshot.teams.map((team) => ({
      rank: team.rank,
      team: team.teamName,
      record: `${team.wins}-${team.losses}`,
      pointsFor: team.pointsFor,
      players: team.starters.length + team.bench.length + team.reserve.length,
    })),
  );
  console.log(`Matchups this week: ${snapshot.matchups.length}`);
  console.log(`Recent transactions: ${snapshot.transactions.length}`);
}

main().catch((error) => {
  console.error("\nCheck failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
