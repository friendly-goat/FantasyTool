// Connectivity check: confirms Sleeper's API answers for NBA from this
// machine, and optionally that a specific league loads.
//
//   npm run check:sleeper                -> checks the NBA endpoints
//   npm run check:sleeper -- <league_id> -> also loads that league
//   npm run check:sleeper -- <league_id> --raw-matchup
//                                        -> also prints one team's raw matchup
//                                           entry for this week, field by field,
//                                           to see what Sleeper reports
//   npm run check:sleeper -- <league_id> --raw-rosters
//                                        -> also lists every field in the rosters
//                                           and this week's transactions, to look
//                                           for anything that records a lock
//
// It makes at most a dozen requests.

import { fetchFromSleeper, type RawState } from "../server/sleeper.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file is fine.
}

const args = process.argv.slice(2);
const rawMatchup = args.includes("--raw-matchup");
const rawRosters = args.includes("--raw-rosters");
const leagueId = args.find((arg) => !arg.startsWith("--")) || process.env.SLEEPER_LEAGUE_ID;

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
  console.log("IR slots:", snapshot.league.reserveSlots);
  {
    // Sleeper's own fields for IR, as sent, so the app's reading can be checked.
    const raw = (await fetchFromSleeper(`/league/${leagueId}`)) as { settings?: Record<string, unknown> } | null;
    const fields = Object.entries(raw?.settings ?? {}).filter(([key]) => key.startsWith("reserve"));
    console.log("IR settings from Sleeper:", Object.fromEntries(fields));
    console.log("IR allowed for:", snapshot.league.reserveAllows);
  }
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

  if (rawMatchup) {
    const entries = (await fetchFromSleeper(`/league/${leagueId}/matchups/${snapshot.week}`)) as Record<string, unknown>[];
    const fields = new Set(entries.flatMap((entry) => Object.keys(entry ?? {})));
    console.log(`\nRaw matchup fields Sleeper sent for week ${snapshot.week}:`, [...fields].sort().join(", "));
    console.log("First team's entry, as Sleeper sent it:");
    console.dir(entries[0], { depth: null });
  }

  if (rawRosters) {
    const rosters = (await fetchFromSleeper(`/league/${leagueId}/rosters`)) as Record<string, unknown>[];
    const keys = (key: string) =>
      [...new Set(rosters.flatMap((roster) => Object.keys((roster?.[key] as Record<string, unknown>) ?? {})))].sort();
    console.log("\nRoster fields:", [...new Set(rosters.flatMap((roster) => Object.keys(roster ?? {})))].sort().join(", "));
    console.log("Roster settings fields:", keys("settings").join(", "));
    console.log("Roster metadata fields:", keys("metadata").join(", ") || "(none)");
    const lockish = rosters.flatMap((roster) =>
      Object.entries((roster?.metadata as Record<string, unknown>) ?? {})
        .filter(([key]) => /lock/i.test(key))
        .map(([key, value]) => ({ roster: roster.roster_id, key, value })),
    );
    console.log(lockish.length ? "Metadata that mentions locks:" : "No roster metadata mentions locks.");
    if (lockish.length) console.table(lockish);

    const league = (await fetchFromSleeper(`/league/${leagueId}`)) as Record<string, unknown>;
    const leagueSettings = Object.keys((league?.settings as Record<string, unknown>) ?? {}).sort();
    console.log("\nLeague settings fields:", leagueSettings.join(", "));
    console.log("League metadata:", league?.metadata ?? "(none)");

    const transactions = (await fetchFromSleeper(`/league/${leagueId}/transactions/${snapshot.week}`)) as Record<string, unknown>[];
    const types = new Map<string, number>();
    for (const item of transactions ?? []) types.set(String(item?.type), (types.get(String(item?.type)) ?? 0) + 1);
    console.log(`\nTransactions in week ${snapshot.week}:`, Object.fromEntries(types));
    console.log("Transaction fields:", [...new Set((transactions ?? []).flatMap((item) => Object.keys(item ?? {})))].sort().join(", "));
  }
}

main().catch((error) => {
  console.error("\nCheck failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
