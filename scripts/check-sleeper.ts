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
//   npm run check:sleeper -- <league_id> --weeks
//                                        -> compares every finished week's matchup
//                                           scores with the season totals in the
//                                           standings (which are right), and saves
//                                           what Sleeper sent to .cache/sleeper-weeks.json
//
// It makes at most a dozen requests (--weeks: one more per finished week, and
// two to Sleeper's own app endpoint to see what it offers).

import { mkdir, writeFile } from "node:fs/promises";
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
const weeks = args.includes("--weeks");
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

  const snapshot = await buildSnapshot(leagueId, fetchFromSleeper, players, Date.now, { followCalendar: true });
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

  if (weeks) await checkWeeks(leagueId, snapshot.week);

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

/** Sum of a list of numbers, ignoring anything that is not one. */
function total(values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0), 0);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Finished weeks against the standings: the standings' points for (fpts) are the
 * league's official totals, so every team's finished weeks should add up to them.
 */
async function checkWeeks(leagueId: string, currentWeek: number) {
  const rosters = (await fetchFromSleeper(`/league/${leagueId}/rosters`)) as Record<string, any>[];
  const users = (await fetchFromSleeper(`/league/${leagueId}/users`)) as Record<string, any>[];
  const names = new Map(
    rosters.map((roster) => {
      const user = users.find((entry) => entry?.user_id === roster?.owner_id);
      return [roster.roster_id as number, (user?.metadata?.team_name as string) || (user?.display_name as string) || `Roster ${roster.roster_id}`];
    }),
  );
  const saved: Record<string, unknown> = { leagueId, currentWeek, rosters, weeks: {} };
  const byTeam = new Map<number, Record<string, number | string>>();
  const fields = new Set<string>();
  for (let week = 1; week < currentWeek; week++) {
    const entries = ((await fetchFromSleeper(`/league/${leagueId}/matchups/${week}`)) as Record<string, any>[]) ?? [];
    (saved.weeks as Record<number, unknown>)[week] = entries;
    for (const entry of entries) {
      Object.keys(entry ?? {}).forEach((key) => fields.add(key));
      const row = byTeam.get(entry.roster_id) ?? { team: names.get(entry.roster_id) ?? String(entry.roster_id) };
      row[`w${week}`] = round2(entry.custom_points ?? entry.points ?? 0);
      // The same week added up from the players, as a cross-check of Sleeper's own total.
      row[`w${week} starters`] = round2(total(entry.starters_points ?? []));
      if (entry.custom_points != null) row[`w${week} custom`] = entry.custom_points;
      byTeam.set(entry.roster_id, row);
    }
  }
  console.log(`\nMatchup fields Sleeper sent for finished weeks:`, [...fields].sort().join(", "));
  const table = rosters.map((roster) => {
    const row = byTeam.get(roster.roster_id) ?? { team: names.get(roster.roster_id) ?? "" };
    const official = round2((roster.settings?.fpts ?? 0) + (roster.settings?.fpts_decimal ?? 0) / 100);
    const sum = round2(total(Array.from({ length: currentWeek - 1 }, (_, index) => row[`w${index + 1}`])));
    return {
      ...row,
      "weeks added": sum,
      "standings": official,
      "gap": round2(official - sum),
      "record": `${roster.settings?.wins ?? 0}-${roster.settings?.losses ?? 0}`,
      "record by week": roster.metadata?.record ?? "",
    };
  });
  console.log("Each finished week from the matchups, against the standings' season total:");
  console.table(table);

  // Sleeper's own app reads its data from another endpoint; see whether it answers without a sign-in.
  const probes: Record<string, unknown> = {};
  for (const [label, query] of [
    ["fields", `{ __type(name: "MatchupLeg") { fields { name } } }`],
    ["week 1", `{ matchup_legs(league_id: "${leagueId}", round: 1) { roster_id points } }`],
  ]) {
    try {
      const response = await fetch("https://sleeper.com/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await response.text();
      probes[label!] = { status: response.status, body };
      console.log(`\nSleeper app endpoint (${label}): ${response.status}`);
      console.log(body.slice(0, 1200));
    } catch (error) {
      probes[label!] = { error: error instanceof Error ? error.message : String(error) };
      console.log(`\nSleeper app endpoint (${label}) failed:`, error instanceof Error ? error.message : error);
    }
  }
  saved.app = probes;
  await mkdir(".cache", { recursive: true });
  await writeFile(".cache/sleeper-weeks.json", JSON.stringify(saved, null, 2));
  console.log("\nSaved everything Sleeper sent to .cache/sleeper-weeks.json (league data only, no keys).");
}

main().catch((error) => {
  console.error("\nCheck failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
