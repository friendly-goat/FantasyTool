import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AppConfig, LeagueSnapshot, WeekData } from "../shared/types.ts";
import { nbaTeam } from "../shared/nbaTeams.ts";
import { Cache } from "./cache.ts";
import { MemoryStorage, storageFromEnv } from "./storage.ts";
import { createLogoSource } from "./logos.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "./mock.ts";
import { fetchFromSleeper, SleeperError } from "./sleeper.ts";
import { buildSnapshot, loadDraftBoard, loadPlayers, loadUserLeagues } from "./snapshot.ts";
import { createBalldontlie } from "./stats/balldontlie.ts";
import { createMockStats } from "./stats/mock.ts";
import type { StatsProvider } from "./stats/provider.ts";
import { StatsService } from "./stats/service.ts";
import { weekRange } from "./weeks.ts";

// Local backend. It is the only part of the app that talks to Sleeper:
// the React app calls /api/* here, and this process decides whether to
// answer from its cache or go to the network.

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: every setting has a default.
}

const MINUTE = 60_000;
const mock = process.argv.includes("--mock") || process.env.SLEEPER_MOCK === "1";
const port = Number(process.env.PORT) || 8787;
const leagueTtl = (Number(process.env.LEAGUE_CACHE_MINUTES) || 60) * MINUTE;
const minRefreshGap = (Number(process.env.MIN_REFRESH_SECONDS) || 60) * 1000;
// Sleeper asks that the full player list be fetched at most once a day.
const playersTtl = 24 * 60 * MINUTE;

const statsTtl = (Number(process.env.STATS_CACHE_HOURS) || 6) * 60 * MINUTE;

const fetchJson = mock ? fetchFromMock : fetchFromSleeper;
// Postgres when DATABASE_URL is set (Heroku), otherwise files in .cache/.
const storage = storageFromEnv();
console.log(`[server] storage: ${storage.kind === "postgres" ? "Postgres (DATABASE_URL)" : "files in .cache/"}`);
// Mock data is never stored, so it cannot mix with your league's.
const cache = new Cache({ storage: mock ? null : storage });

// Player stats come from balldontlie when a key is set. Without one the
// rest of the app still works; stats are simply not shown.
const statsKey = process.env.BALLDONTLIE_API_KEY?.trim();
const statsProvider: StatsProvider | null = mock
  ? createMockStats((await fetchFromMock("/players/nba")) as Record<string, unknown>)
  : statsKey
    ? createBalldontlie(statsKey)
    : null;
const stats = new StatsService(statsProvider, { storage: mock ? null : storage, staleMs: statsTtl });

// Team logos are real images even in mock mode, so they always use the
// disk cache.
const getLogo = createLogoSource(new Cache({ storage }));

const app = express();
app.use(express.json({ limit: "10kb" }));

// Lock marks are your own corrections, so they are kept even in mock mode
// (in memory there, so sample data never mixes with your league's).
const markStorage = mock ? new MemoryStorage() : storage;

function getPlayers() {
  return cache.get("players-nba", playersTtl, () => loadPlayers(fetchJson));
}

// Bump the version when the snapshot shape changes, so that snapshots saved
// by an older version of the app are rebuilt instead of reused.
const leagueKey = (leagueId: string) => `league-v3-${leagueId}`;

function getSnapshot(leagueId: string, force: boolean) {
  return cache.get(
    leagueKey(leagueId),
    leagueTtl,
    async () => buildSnapshot(leagueId, fetchJson, (await getPlayers()).value),
    { force },
  );
}

function sendError(res: express.Response, error: unknown): void {
  const status = error instanceof SleeperError && error.status === 429 ? 429 : 502;
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("[api]", message);
  res.status(status).json({ error: message });
}

app.get("/api/config", (_req, res) => {
  const config: AppConfig = {
    defaultLeagueId: mock ? MOCK_LEAGUE_ID : process.env.SLEEPER_LEAGUE_ID || null,
    mock,
  };
  res.json(config);
});

app.get("/api/user/:username/leagues", async (req, res) => {
  try {
    const username = req.params.username.trim();
    const result = await cache.get(`user-${username.toLowerCase()}`, leagueTtl, () =>
      loadUserLeagues(username, fetchJson),
    );
    res.json(result.value);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/league/:leagueId", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const key = leagueKey(leagueId);

    // "Refresh" bypasses the cache, but not more often than the minimum
    // gap, so repeated clicks cannot hammer Sleeper.
    const age = await cache.age(key);
    const force = req.query.refresh === "1" && (age === null || age >= minRefreshGap);

    const result = await getSnapshot(leagueId, force);
    const snapshot: LeagueSnapshot = { ...result.value, stale: result.stale };
    res.json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/league/:leagueId/stats", async (req, res) => {
  try {
    const [snapshot, players] = await Promise.all([
      getSnapshot(req.params.leagueId.trim(), false),
      getPlayers(),
    ]);
    if (req.query.retry === "1") stats.retry(snapshot.value.league.season);
    res.json(await stats.report(snapshot.value, players.value));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/league/:leagueId/players/:playerId", async (req, res) => {
  try {
    const [snapshot, players] = await Promise.all([
      getSnapshot(req.params.leagueId.trim(), false),
      getPlayers(),
    ]);
    const detail = await stats.playerDetail(snapshot.value, players.value, req.params.playerId);
    if (!detail) {
      res.status(404).json({ error: "Sleeper has no player with that ID." });
      return;
    }
    res.json(detail);
  } catch (error) {
    sendError(res, error);
  }
});

// The NBA side of this fantasy week: the schedule (cached for a few minutes,
// since game states change on game nights) and each rostered player's games.
const scheduleTtl = (Number(process.env.SCHEDULE_CACHE_MINUTES) || 5) * MINUTE;
const weekFreshMs = (Number(process.env.WEEK_STATS_MINUTES) || 15) * MINUTE;

app.get("/api/league/:leagueId/week", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const [snapshot, players] = await Promise.all([getSnapshot(leagueId, false), getPlayers()]);
    const { league, week } = snapshot.value;
    const seasonStart = league.seasonStartDate;
    if (!seasonStart) {
      res.status(502).json({ error: "Sleeper did not report when the season started, so this week's dates are unknown." });
      return;
    }
    const { start, end } = weekRange(seasonStart, week);

    let games: WeekData["games"] = [];
    let scheduleMessage: string | null = null;
    if (!stats.hasSchedule()) {
      scheduleMessage = "No stats source is set up, so the NBA schedule is not available.";
    } else {
      try {
        games = (await cache.get(`schedule-v1-${start}`, scheduleTtl, () => stats.schedule(start, end))).value;
      } catch (error) {
        scheduleMessage = error instanceof Error ? error.message : "The NBA schedule could not be loaded.";
      }
    }
    const { lines, syncedAt } = await stats.weekLines(snapshot.value, players.value, start, end, weekFreshMs);
    const body: WeekData = {
      week,
      start,
      end,
      schedule: scheduleMessage === null ? "ready" : "unavailable",
      scheduleMessage,
      games,
      lines,
      linesSyncedAt: syncedAt,
    };
    res.json(body);
  } catch (error) {
    sendError(res, error);
  }
});

// Lock marks: a manager's word on whether a starter's current score is
// locked, for the current week. Sleeper does not share locks.
app.get("/api/league/:leagueId/locks", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const { week } = (await getSnapshot(leagueId, false)).value;
    res.json({ week, marks: await markStorage.readLockMarks(leagueId, week) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put("/api/league/:leagueId/locks", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const body = (req.body ?? {}) as { rosterId?: unknown; playerId?: unknown; locked?: unknown };
    const rosterId = Number(body.rosterId);
    const playerId = typeof body.playerId === "string" ? body.playerId : "";
    if (!Number.isInteger(rosterId) || !playerId || (body.locked !== null && typeof body.locked !== "boolean")) {
      res.status(400).json({ error: "Send rosterId, playerId and locked (true, false, or null to clear)." });
      return;
    }
    const { week, matchups } = (await getSnapshot(leagueId, false)).value;
    // The mark is tied to the score Sleeper shows now, taken from the server's
    // copy rather than the browser's.
    const starter = matchups
      .flatMap((matchup) => matchup.sides)
      .find((side) => side.rosterId === rosterId)
      ?.starters.find((entry) => entry.player?.id === playerId);
    if (!starter) {
      res.status(404).json({ error: "That player is not one of this team's starters this week." });
      return;
    }
    if (body.locked === null) {
      await markStorage.deleteLockMark(leagueId, week, rosterId, playerId);
    } else {
      await markStorage.writeLockMark({
        leagueId,
        week,
        rosterId,
        playerId,
        locked: body.locked as boolean,
        points: starter.points ?? 0,
        markedAt: Date.now(),
      });
    }
    res.json({ week, marks: await markStorage.readLockMarks(leagueId, week) });
  } catch (error) {
    sendError(res, error);
  }
});

// The draft board. A finished draft never changes, but one still running
// does, so it uses the same cache time as the league.
app.get("/api/league/:leagueId/draft", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const result = await cache.get(`draft-v1-${leagueId}`, leagueTtl, async () => ({
      board: await loadDraftBoard(leagueId, fetchJson, (await getPlayers()).value),
    }));
    res.json(result.value);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/logos/:abbr/:variant", async (req, res) => {
  const team = nbaTeam(req.params.abbr);
  const variant = req.params.variant === "dark" ? "dark" : req.params.variant === "light" ? "light" : null;
  if (!team || !variant) {
    res.status(404).end();
    return;
  }
  const svg = await getLogo(team.nbaId, variant);
  if (!svg) {
    // Not cached for long, so the logo shows once it can be downloaded.
    res.set("Cache-Control", "no-store").status(404).end();
    return;
  }
  res.set({
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=604800",
    // The SVG comes from outside, so it may not run scripts or load anything
    // if someone opens it directly.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(svg);
});

// After `npm run build`, this server also serves the compiled React app.
const dist = path.resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(port, () => {
  console.log(
    `[server] http://localhost:${port} (${mock ? "mock data" : "live Sleeper data"}, ` +
      `player stats: ${statsProvider ? statsProvider.name : "off, no BALLDONTLIE_API_KEY"})`,
  );
});
