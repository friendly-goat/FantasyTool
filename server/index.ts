import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AppConfig, LeagueSnapshot, WeekData } from "../shared/types.ts";
import { nbaTeam } from "../shared/nbaTeams.ts";
import {
  authFromEnv,
  clearedCookie,
  createAttemptLimiter,
  createSessionToken,
  requireRole,
  roleForPassword,
  roleOf,
  sessionCookie,
} from "./auth.ts";
import { Cache } from "./cache.ts";
import { MemoryStorage, storageFromEnv } from "./storage.ts";
import { gamesLive } from "../shared/matchup.ts";
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
// How often each kind of data is fetched again. Pages are always answered
// from saved data; anything older than these is updated in the background,
// so no request waits on Sleeper or balldontlie once something is saved.
// "Live" means NBA games are being played (from the cached schedule).
const minutes = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * MINUTE;
// Sleeper league data (about 8 requests): Sleeper asks to stay under 1000 a minute.
const leagueTtl = minutes("LEAGUE_CACHE_MINUTES", 10);
const liveLeagueTtl = minutes("LIVE_LEAGUE_MINUTES", 2);
// Sleeper asks that the full player list be fetched at most once a day.
const playersTtl = 24 * 60 * MINUTE;
// The NBA schedule (one balldontlie request): scores and game states change on game nights.
const scheduleTtl = minutes("SCHEDULE_CACHE_MINUTES", 30);
const liveScheduleTtl = minutes("LIVE_SCHEDULE_MINUTES", 3);
// Box scores while a matchup is open; balldontlie updates live stats about every 10 minutes.
const weekStatsMs = minutes("WEEK_STATS_MINUTES", 30);
const liveWeekStatsMs = minutes("LIVE_WEEK_STATS_MINUTES", 10);
// Box scores otherwise.
const statsTtl = (Number(process.env.STATS_CACHE_HOURS) || 6) * 60 * MINUTE;
// A finished draft never changes.
const finishedDraftTtl = 7 * 24 * 60 * MINUTE;

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
// On Heroku requests arrive through a proxy; this makes req.ip and secure
// cookies work.
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));

// Sign-in. Off locally (no ADMIN_PASSWORD); required in production, so the
// hosted app is never open to anyone with the link.
const auth = authFromEnv(process.env);
const production = process.env.NODE_ENV === "production";
if (production && !auth) {
  console.error("[auth] ADMIN_PASSWORD must be set in production. Set it with: heroku config:set ADMIN_PASSWORD=...");
  process.exit(1);
}
const allowAttempt = createAttemptLimiter();

app.get("/api/session", (req, res) => {
  res.json({ authRequired: auth !== null, role: roleOf(auth, req) });
});

app.post("/api/session", (req, res) => {
  if (!auth) {
    res.json({ role: "admin" });
    return;
  }
  if (!allowAttempt(req.ip ?? "unknown")) {
    res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    return;
  }
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const role = roleForPassword(auth, password);
  if (!role) {
    res.status(401).json({ error: "That password is not right." });
    return;
  }
  res.setHeader("Set-Cookie", sessionCookie(createSessionToken(role, auth.secret), production));
  res.json({ role });
});

app.delete("/api/session", (_req, res) => {
  res.setHeader("Set-Cookie", clearedCookie);
  res.json({ role: null });
});

// Everything else under /api needs a sign-in.
app.use("/api", requireRole(auth));

// With sign-in on and a league set, the app serves only that league, so
// nobody can use it (and its stats key) for other leagues.
const onlyLeague = auth ? process.env.SLEEPER_LEAGUE_ID?.trim() || null : null;
if (onlyLeague) {
  app.param("leagueId", (_req, res, next, id: string) => {
    if (id.trim() === onlyLeague) next();
    else res.status(404).json({ error: "This app only serves one league." });
  });
}

// Lock marks are your own corrections, so they are kept even in mock mode
// (in memory there, so sample data never mixes with your league's).
const markStorage = mock ? new MemoryStorage() : storage;

function getPlayers() {
  return cache.get("players-nba", playersTtl, () => loadPlayers(fetchJson), { background: true });
}

// Bump the version when the snapshot shape changes, so that snapshots saved
// by an older version of the app are rebuilt instead of reused.
const leagueKey = (leagueId: string) => `league-v3-${leagueId}`;
const scheduleKey = (weekStart: string) => `schedule-v1-${weekStart}`;

/** This fantasy week's dates, from a snapshot, or null if Sleeper did not give the season start. */
function weekOf(snapshot: LeagueSnapshot) {
  const seasonStart = snapshot.league.seasonStartDate;
  return seasonStart ? weekRange(seasonStart, snapshot.week) : null;
}

/** Whether NBA games are on now, judged from the saved snapshot and schedule (no outside calls). */
async function isLive(leagueId: string): Promise<boolean> {
  const saved = await cache.peek<LeagueSnapshot>(leagueKey(leagueId));
  const week = saved ? weekOf(saved.value) : null;
  if (!week) return false;
  const schedule = await cache.peek<WeekData["games"]>(scheduleKey(week.start));
  return gamesLive(schedule?.value ?? [], Date.now());
}

async function getSnapshot(leagueId: string) {
  const ttl = (await isLive(leagueId)) ? liveLeagueTtl : leagueTtl;
  return cache.get(
    leagueKey(leagueId),
    ttl,
    async () => buildSnapshot(leagueId, fetchJson, (await getPlayers()).value),
    { background: true },
  );
}

/** This week's NBA schedule, kept fresher while games are on. */
async function getSchedule(start: string, end: string, live: boolean) {
  return cache.get(scheduleKey(start), live ? liveScheduleTtl : scheduleTtl, () => stats.schedule(start, end), {
    background: true,
  });
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
  if (onlyLeague) {
    res.status(404).json({ error: "This app only serves one league." });
    return;
  }
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
    const result = await getSnapshot(leagueId);
    const live = await isLive(leagueId);
    // Keep the schedule loaded too: it is how the server knows when games are on.
    const week = weekOf(result.value);
    if (week && stats.hasSchedule()) void getSchedule(week.start, week.end, live).catch(() => {});
    const snapshot: LeagueSnapshot = { ...result.value, stale: result.stale, refreshing: result.refreshing ?? false, live };
    res.json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/league/:leagueId/stats", async (req, res) => {
  try {
    const [snapshot, players] = await Promise.all([
      getSnapshot(req.params.leagueId.trim()),
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
      getSnapshot(req.params.leagueId.trim()),
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

// The NBA side of this fantasy week: the schedule and each rostered player's games.

app.get("/api/league/:leagueId/week", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const [snapshot, players] = await Promise.all([getSnapshot(leagueId), getPlayers()]);
    const { week } = snapshot.value;
    const range = weekOf(snapshot.value);
    if (!range) {
      res.status(502).json({ error: "Sleeper did not report when the season started, so this week's dates are unknown." });
      return;
    }
    const { start, end } = range;
    const live = await isLive(leagueId);

    let games: WeekData["games"] = [];
    let scheduleMessage: string | null = null;
    if (!stats.hasSchedule()) {
      scheduleMessage = "No stats source is set up, so the NBA schedule is not available.";
    } else {
      try {
        games = (await getSchedule(start, end, live)).value;
      } catch (error) {
        scheduleMessage = error instanceof Error ? error.message : "The NBA schedule could not be loaded.";
      }
    }
    const { lines, syncedAt } = await stats.weekLines(
      snapshot.value,
      players.value,
      start,
      end,
      live ? liveWeekStatsMs : weekStatsMs,
    );
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
    const { week } = (await getSnapshot(leagueId)).value;
    res.json({ week, marks: await markStorage.readLockMarks(leagueId, week) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put("/api/league/:leagueId/locks", requireRole(auth, "admin"), async (req, res) => {
  try {
    const leagueId = String(req.params.leagueId ?? "").trim();
    const body = (req.body ?? {}) as { rosterId?: unknown; playerId?: unknown; locked?: unknown };
    const rosterId = Number(body.rosterId);
    const playerId = typeof body.playerId === "string" ? body.playerId : "";
    if (!Number.isInteger(rosterId) || !playerId || (body.locked !== null && typeof body.locked !== "boolean")) {
      res.status(400).json({ error: "Send rosterId, playerId and locked (true, false, or null to clear)." });
      return;
    }
    const { week, matchups } = (await getSnapshot(leagueId)).value;
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

// The draft board. A finished draft never changes, so it is checked weekly;
// one still running is checked as often as the league.
app.get("/api/league/:leagueId/draft", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const key = `draft-v1-${leagueId}`;
    const saved = await cache.peek<{ board: { status: string } | null }>(key);
    const ttl = saved?.value.board?.status === "complete" ? finishedDraftTtl : leagueTtl;
    const result = await cache.get(
      key,
      ttl,
      async () => ({ board: await loadDraftBoard(leagueId, fetchJson, (await getPlayers()).value) }),
      { background: true },
    );
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
