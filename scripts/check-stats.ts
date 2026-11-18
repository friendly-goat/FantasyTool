// Stats check: downloads game stats from balldontlie, matches them to the
// players in your Sleeper league, and prints what it found.
//
//   npm run check:stats -- <league_id>
//   npm run check:stats -- <league_id> --player "James Harden"   (adds a game log)
//   npm run check:stats -- <league_id> --schedule   (only this week's NBA schedule)
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
import { weekRange } from "../shared/weeks.ts";
import { StatsService } from "../server/stats/service.ts";
import { storageFromEnv } from "../server/storage.ts";

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
const scheduleOnly = args.includes("--schedule");
const fetchJson = mock ? fetchFromMock : fetchFromSleeper;
const leagueId = mock
  ? MOCK_LEAGUE_ID
  : args.find((arg, index) => !arg.startsWith("--") && index !== playerFlag + 1) ||
    process.env.SLEEPER_LEAGUE_ID;
const apiKey = process.env.BALLDONTLIE_API_KEY?.trim();
// The same storage the app uses (Postgres if DATABASE_URL is set), so this
// check fills the app's saved stats too.
const storage = mock ? null : storageFromEnv();

async function main() {
  if (!apiKey && !mock) throw new Error("BALLDONTLIE_API_KEY is not set. Add it to .env.");
  if (!leagueId) throw new Error("Pass your league ID: npm run check:stats -- <league_id>");

  const players = await loadPlayers(fetchJson);
  const snapshot = await buildSnapshot(leagueId, fetchJson, players);
  console.log(`League: ${snapshot.league.name}, season ${snapshot.league.season}`);

  const provider = mock
    ? createMockStats((await fetchFromMock("/players/nba")) as Record<string, unknown>)
    : createBalldontlie(apiKey!);
  if (scheduleOnly) {
    if (!snapshot.league.seasonStartDate) throw new Error("Sleeper did not report the season start date.");
    const { start, end } = weekRange(snapshot.league.seasonStartDate, snapshot.week);
    if (!provider.fetchSchedule) throw new Error(`${provider.name} cannot supply a schedule.`);
    const games = await provider.fetchSchedule(start, end);
    console.log(`\nWeek ${snapshot.week} (${start} to ${end}): ${games.length} games`);
    console.table(
      games.map((game) => ({
        date: game.date,
        tipoff: game.startTime ? new Date(game.startTime).toLocaleString() : "?",
        game: `${game.away ?? "?"} @ ${game.home ?? "?"}`,
        state: game.state,
        score: game.homeScore !== null ? `${game.awayScore}-${game.homeScore}` : "",
      })),
    );
    const upcoming = games.filter((game) => game.state === "scheduled").length;
    console.log(
      upcoming > 0
        ? `${upcoming} games still to be played: the schedule includes future games.`
        : "No future games listed. If games remain this week, the source may not list unplayed games.",
    );
    return;
  }

  const service = new StatsService(
    {
      name: provider.name,
      fetchGameLines: (season, fromDate, onPage) =>
        provider.fetchGameLines(season, fromDate, (pages) => {
          process.stdout.write(`\rDownloading game stats: page ${pages}`);
          onPage(pages);
        }),
    },
    { storage },
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
    fantasyAvg: Number(player.fantasyAvg.toFixed(2)),
    shownInSleeper: Number(player.sleeperAvg.toFixed(2)),
    last5: player.recentAvg == null ? null : Number(player.recentAvg.toFixed(2)),
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
  for (const player of report.unmatchedRostered) {
    // Shows whether the stats source has this player under another first name.
    const similar = await service.similarPlayers(snapshot.league.season, player.name);
    console.log(
      `  ${player.name} (${player.team ?? "no NBA team"}): stats source has`,
      similar.length > 0 ? similar : "nobody with that last name, so no games played",
    );
  }
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
  const technical = snapshot.league.scoringSettings.tf ?? 0;
  const flagrant = snapshot.league.scoringSettings.ff ?? 0;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.011;
  const tally = { exact: 0, technicalFoul: 0, flagrantFoul: 0, other: 0, noGameThatWeek: 0 };
  const misses: Record<string, unknown>[] = [];
  for (let week = 1; week <= snapshot.week; week++) {
    const range = seasonStart ? weekRange(seasonStart, week) : null;
    const raw = (await fetchJson(`/league/${leagueId}/matchups/${week}`)) as RawMatchup[] | null;
    for (const entry of raw ?? []) {
      const starters = entry.starters ?? [];
      for (const [index, id] of starters.entries()) {
        const credited = entry.players_points?.[id] ?? entry.starters_points?.[index] ?? 0;
        if (!credited) continue;
        const detail = await detailFor(id);
        // Only games played in that fantasy week can be the locked game.
        const games = (detail?.games ?? []).filter(
          (game) => !range || (game.date >= range.start && game.date <= range.end),
        );
        if (!detail || games.length === 0) {
          tally.noGameThatWeek++;
          continue;
        }
        const closest = games.reduce((a, b) =>
          Math.abs(b.fantasyPoints - credited) < Math.abs(a.fantasyPoints - credited) ? b : a,
        );
        const difference = credited - closest.fantasyPoints;
        if (near(difference, 0)) tally.exact++;
        else if (technical && near(difference, technical)) tally.technicalFoul++;
        else if (flagrant && near(difference, flagrant)) tally.flagrantFoul++;
        else {
          tally.other++;
          if (misses.length < 20) {
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
  }
  console.log(
    "\nScoring check. Each score Sleeper credited to a starter, compared with our score for that player's games in the same week:",
  );
  console.log(tally);
  console.log(
    "exact: same to the cent. technicalFoul / flagrantFoul: off by exactly that penalty, which box scores do not include.",
  );
  if (misses.length > 0) {
    console.log("Other differences (usually one stat recorded differently by the two data sources):");
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
        `\n${player.name} (${player.team ?? "no team"}): ${detail.stats!.games} games, ` +
          `fantasy average ${detail.stats!.fantasyAvg.toFixed(2)}, ` +
          `Sleeper's app should show ${detail.stats!.sleeperAvg.toFixed(2)}`,
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

main()
  .catch((error) => {
    console.error("\nCheck failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => storage?.close());
