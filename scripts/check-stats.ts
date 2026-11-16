// Stats check: downloads game stats from balldontlie, matches them to the
// players in your Sleeper league, and prints what it found.
//
//   npm run check:stats -- <league_id>
//   npm run check:stats -- <league_id> --player "James Harden"   (adds a game log)
//
// Needs BALLDONTLIE_API_KEY in .env. The first run downloads the season so
// far (about a minute); the result is saved in .cache/ and reused by the app.

import type { PlayerDetail } from "../shared/types.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { fetchFromSleeper, type RawMatchup } from "../server/sleeper.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import { normalizeName } from "../server/stats/match.ts";
import { createBalldontlie } from "../server/stats/balldontlie.ts";
import { createMockStats } from "../server/stats/mock.ts";
import { StatsService } from "../server/stats/service.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // Handled below when the key is missing.
}

const args = process.argv.slice(2);
const playerFlag = args.indexOf("--player");
const playerName = playerFlag >= 0 ? args[playerFlag + 1] : undefined;
// --mock runs the whole check against the built-in sample league, offline.
const mock = args.includes("--mock");
const fetchJson = mock ? fetchFromMock : fetchFromSleeper;
const leagueId = mock
  ? MOCK_LEAGUE_ID
  : args.find((arg, index) => !arg.startsWith("--") && index !== playerFlag + 1) ||
    process.env.SLEEPER_LEAGUE_ID;
const apiKey = process.env.BALLDONTLIE_API_KEY?.trim();

async function main() {
  if (!apiKey && !mock) throw new Error("BALLDONTLIE_API_KEY is not set. Add it to .env.");
  if (!leagueId) throw new Error("Pass your league ID: npm run check:stats -- <league_id>");

  const players = await loadPlayers(fetchJson);
  const snapshot = await buildSnapshot(leagueId, fetchJson, players);
  console.log(`League: ${snapshot.league.name}, season ${snapshot.league.season}`);

  const provider = mock
    ? createMockStats((await fetchFromMock("/players/nba")) as Record<string, unknown>)
    : createBalldontlie(apiKey!);
  const service = new StatsService(
    {
      name: provider.name,
      fetchGameLines: (season, fromDate, onPage) =>
        provider.fetchGameLines(season, fromDate, (pages) => {
          process.stdout.write(`\rDownloading game stats: page ${pages}`);
          onPage(pages);
        }),
    },
    { dir: mock ? null : ".cache" },
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

  // ---- What is stored, and what is left out --------------------------------
  const seasonStart = snapshot.league.seasonStartDate;
  const overview = await service.overview(snapshot.league.season, seasonStart);
  console.log("Stored game lines:", overview);
  console.log(
    `Season start per Sleeper: ${seasonStart}. Lines dated before it are treated as preseason and ignored.`,
  );

  // ---- Scoring check against Sleeper's own numbers --------------------------
  // In a lock-in league each starter's weekly score is one game, so every
  // score Sleeper credited should equal one of our computed game scores.
  const details = new Map<string, PlayerDetail | null>();
  const detailFor = async (id: string) => {
    if (!details.has(id)) details.set(id, await service.playerDetail(snapshot, players, id));
    return details.get(id) ?? null;
  };
  let compared = 0;
  let exact = 0;
  const misses: Record<string, unknown>[] = [];
  for (let week = 1; week <= snapshot.week; week++) {
    const raw = (await fetchJson(`/league/${leagueId}/matchups/${week}`)) as RawMatchup[] | null;
    for (const entry of raw ?? []) {
      const starters = entry.starters ?? [];
      for (const [index, id] of starters.entries()) {
        const credited = entry.players_points?.[id] ?? entry.starters_points?.[index] ?? 0;
        if (!credited) continue;
        const detail = await detailFor(id);
        if (!detail || detail.games.length === 0) continue;
        compared++;
        const closest = detail.games.reduce((a, b) =>
          Math.abs(b.fantasyPoints - credited) < Math.abs(a.fantasyPoints - credited) ? b : a,
        );
        const difference = credited - closest.fantasyPoints;
        if (Math.abs(difference) < 0.011) exact++;
        else if (misses.length < 20) {
          misses.push({
            week,
            player: detail.player.name,
            sleeper: credited,
            ourClosestGame: Number(closest.fantasyPoints.toFixed(2)),
            difference: Number(difference.toFixed(2)),
            date: closest.date,
            line: `${closest.stats.pts}p ${closest.stats.reb}r ${closest.stats.ast}a ${closest.stats.stl}s ${closest.stats.blk}b ${closest.stats.tov}to`,
          });
        }
      }
    }
  }
  console.log(`\nScoring check: ${exact} of ${compared} scores credited by Sleeper match one of our game scores exactly.`);
  if (misses.length > 0) {
    console.log("First mismatches (a constant difference points at a scoring rule):");
    console.table(misses);
  }

  // ---- Optional game log for one player ------------------------------------
  if (playerName) {
    const wanted = normalizeName(playerName);
    const found = Object.values(players).filter((player) => normalizeName(player.name) === wanted);
    if (found.length === 0) console.log(`\nNo Sleeper player named "${playerName}".`);
    for (const player of found) {
      const detail = await detailFor(player.id);
      if (!detail || detail.games.length === 0) continue;
      console.log(
        `\n${player.name} (${player.team ?? "no team"}): ${detail.stats!.games} games, fantasy average ${detail.stats!.fantasyAvg.toFixed(2)}`,
      );
      console.table(
        detail.games.map((game) => ({
          date: game.date,
          vs: `${game.home === false ? "@ " : ""}${game.opponent ?? "?"}`,
          min: Math.round(game.minutes),
          pts: game.stats.pts,
          reb: game.stats.reb,
          ast: game.stats.ast,
          stl: game.stats.stl,
          blk: game.stats.blk,
          to: game.stats.tov,
          fantasy: Number(game.fantasyPoints.toFixed(2)),
        })),
      );
    }
  }
}

main().catch((error) => {
  console.error("\nCheck failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
