import { existsSync } from "node:fs";
import path from "node:path";
import compression from "compression";
import express from "express";
import type { AppConfig, LeagueSnapshot, LivePlanData, Matchup, ScheduleAhead, ScoreHistory, WeekData, WeekMatchups } from "../shared/types.ts";
import { buildModel, modelCalendar } from "../shared/strength.ts";
import type { ProjectionLedger } from "../shared/realisation.ts";
import { projectedThisWeek } from "../shared/teamProfile.ts";
import { checkRecorded, noteStandings, type RecordedWeek, type StandingsLedger, weekScores } from "../shared/weekScores.ts";
import { RECORDED_WEEKS } from "./recordedWeeks.ts";
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
import { gamePhase, type GamePhase, liveDates, PLAN_POLL_MS } from "../shared/freshness.ts";
import type { InjuryNews } from "../shared/injury.ts";
import { inAwakeHours, localHour } from "./keepAwake.ts";
import { createLogoSource } from "./logos.ts";
import { fetchFromMock, MOCK_LEAGUE_ID, MOCK_PLAN_NOW } from "./mock.ts";
import { fetchFromSleeper, SleeperError } from "./sleeper.ts";
import { buildMatchups, buildSnapshot, loadDraftBoard, loadPlayers, loadUserLeagues } from "./snapshot.ts";
import { createBalldontlie } from "./stats/balldontlie.ts";
import { createMockStats } from "./stats/mock.ts";
import type { StatsProvider } from "./stats/provider.ts";
import { StatsService } from "./stats/service.ts";
import { weekRange } from "../shared/weeks.ts";

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
// from saved data; anything older than these is updated in the background
// (by the keep-fresh loop below, or by a request), so no request waits on
// Sleeper or balldontlie once something is saved. "Live" means NBA games are
// being played (from the cached schedule). Every figure stays far inside the
// sources' limits: see README "Keeping data fresh".
const minutes = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * MINUTE;
const seconds = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * 1000;
// Sleeper league data (about 8 requests a refresh): Sleeper asks to stay under 1000 a minute.
// While games are played its scores move by the minute (two refreshes a minute is about 16
// requests); in the run-up to a tip-off, lineups are being set.
const leagueTtl = minutes("LEAGUE_CACHE_MINUTES", 5);
const liveLeagueTtl = seconds("LIVE_LEAGUE_SECONDS", 30);
const pregameLeagueTtl = minutes("PREGAME_LEAGUE_MINUTES", 1);
// Sleeper asks that the full player list be fetched at most once a day.
const playersTtl = 24 * 60 * MINUTE;
// The NBA schedule (one or two balldontlie requests): scores and game states change on game nights.
const scheduleTtl = minutes("SCHEDULE_CACHE_MINUTES", 15);
const liveScheduleTtl = minutes("LIVE_SCHEDULE_MINUTES", 1);
const pregameScheduleTtl = minutes("PREGAME_SCHEDULE_MINUTES", 5);
// Box scores (a sync re-downloads the last few days, about 5 to 10 requests) every 5 minutes while
// games are on, and the days being played on their own (a request or two, the source updates
// games in progress as they go) every 45 seconds: a few requests a minute of balldontlie's 60.
const liveStatsMs = minutes("LIVE_STATS_MINUTES", 5);
const liveBoxMs = seconds("LIVE_BOX_SECONDS", 45);
const statsTtl = minutes("STATS_CACHE_MINUTES", 30);
// A finished draft never changes.
const finishedDraftTtl = 7 * 24 * 60 * MINUTE;
// The injury report: one or two requests. Return dates and notes change a
// few times a day, mostly before games.
const injuriesTtl = minutes("INJURY_CACHE_MINUTES", 15);
// Late scratches come in the run-up to tip-off: every 5 minutes then and while games are on.
const pregameInjuriesTtl = minutes("PREGAME_INJURY_MINUTES", 5);
// A finished week's matchups only change with Sleeper's stat corrections in
// the days after it, so last week is checked a few times a day and older
// weeks weekly. A finished week's schedule never changes.
const lastWeekTtl = 6 * 60 * MINUTE;
const finishedWeekTtl = 7 * 24 * 60 * MINUTE;
/** How often the keep-fresh loop looks over the leagues in use (it calls out only for data past its time). */
const KEEP_FRESH_MS = MINUTE;
/** As often while games are on or about to tip, so live data is never more than its own time old. */
const KEEP_FRESH_LIVE_MS = 15_000;
/** A league opened in the app is kept fresh for this long after its last visit (the configured league always). */
const KEEP_FRESH_FOR_MS = 24 * 60 * MINUTE;

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
// Heroku's router does not compress, so this does: the stats report shrinks to a fraction on the
// way to a phone (brotli where the browser takes it, gzip otherwise).
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: "10kb" }));
// API answers are private to the signed-in browser and always checked with the server; Express's
// ETag turns an unchanged answer into a short "not modified".
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "private, no-cache");
  next();
});

// Sign-in. Off locally (no ADMIN_PASSWORD); required in production, so the
// hosted app is never open to anyone with the link.
const auth = authFromEnv(process.env);
const production = process.env.NODE_ENV === "production";
if (production && !auth) {
  console.error("[auth] ADMIN_PASSWORD must be set in production. Set it with: heroku config:set ADMIN_PASSWORD=...");
  process.exit(1);
}
const allowAttempt = createAttemptLimiter();

// For the keep-awake visit (and uptime checks): answers without a sign-in, says nothing.
app.get("/healthz", (_req, res) => {
  res.set("Cache-Control", "no-store").status(204).end();
});

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
// Separate keys for finished weeks, so a copy saved while games were on is never served as final.
const finishedScheduleKey = (weekStart: string) => `schedule-final-v1-${weekStart}`;
const matchupsKey = (leagueId: string, week: number) => `matchups-v1-${leagueId}-${week}`;
const ledgerKey = (leagueId: string) => `standings-ledger-v1-${leagueId}`;
const projectionsKey = (leagueId: string) => `projections-v1-${leagueId}`;
const scheduleAheadKey = (start: string, end: string) => `schedule-ahead-v1-${start}-${end}`;
/** The rest of the season's NBA schedule changes little: kept for a day (one schedule download, about ten requests). */
const scheduleAheadTtl = 24 * 60 * MINUTE;

/** This fantasy week's dates, from a snapshot, or null if Sleeper did not give the season start. */
function weekOf(snapshot: LeagueSnapshot) {
  const seasonStart = snapshot.league.seasonStartDate;
  return seasonStart ? weekRange(seasonStart, snapshot.week) : null;
}

/** Games being played, about to tip, or neither, judged from the saved snapshot and schedule (no outside calls). */
async function phaseOf(leagueId: string): Promise<GamePhase> {
  const saved = await cache.peek<LeagueSnapshot>(leagueKey(leagueId));
  const week = saved ? weekOf(saved.value) : null;
  if (!week) return "quiet";
  const schedule = await cache.peek<WeekData["games"]>(scheduleKey(week.start));
  return gamePhase(schedule?.value ?? [], Date.now());
}

/** Whether NBA games are on now. */
async function isLive(leagueId: string): Promise<boolean> {
  return (await phaseOf(leagueId)) === "live";
}

async function getSnapshot(leagueId: string) {
  const phase = await phaseOf(leagueId);
  const ttl = phase === "live" ? liveLeagueTtl : phase === "pregame" ? pregameLeagueTtl : leagueTtl;
  return cache.get(
    leagueKey(leagueId),
    ttl,
    async () => buildSnapshot(leagueId, fetchJson, (await getPlayers()).value, Date.now, { followCalendar: !mock }),
    { background: true },
  );
}

/** This week's NBA schedule, kept fresher while games are on (live) and before they tip (pregame). */
async function getSchedule(start: string, end: string, live: boolean | GamePhase) {
  const phase: GamePhase = live === true ? "live" : live === false ? "quiet" : live;
  const ttl = phase === "live" ? liveScheduleTtl : phase === "pregame" ? pregameScheduleTtl : scheduleTtl;
  return cache.get(scheduleKey(start), ttl, () => stats.schedule(start, end), {
    background: true,
  });
}

/**
 * The week asked for (from ?week= or a request body): any week from 1 to the
 * current one. Missing means the current week; anything else is null.
 */
function pickWeek(value: unknown, snapshot: LeagueSnapshot): number | null {
  if (value === undefined || value === null || value === "") return snapshot.week;
  const week = Number(value);
  return Number.isInteger(week) && week >= 1 && week <= snapshot.week ? week : null;
}

const BAD_WEEK = "Pick a week from 1 to the current week.";

/** One week's matchups: the snapshot's for the current week, otherwise one saved Sleeper request per week. */
async function getWeekMatchups(leagueId: string, snapshot: LeagueSnapshot, week: number): Promise<Matchup[]> {
  if (week === snapshot.week) return snapshot.matchups;
  const result = await cache.get(
    matchupsKey(leagueId, week),
    week === snapshot.week - 1 ? lastWeekTtl : finishedWeekTtl,
    async () => {
      const [raw, players] = await Promise.all([fetchJson(`/league/${leagueId}/matchups/${week}`), getPlayers()]);
      return buildMatchups(
        Array.isArray(raw) ? raw : [],
        { roster_positions: snapshot.league.rosterPositions },
        players.value,
      );
    },
    { background: true },
  );
  return result.value;
}

/**
 * Each team's points for and against, noted under the weeks settled so far, kept in storage: the
 * change from one settled week to the next is that week's final score, locks included
 * (shared/weekScores.ts). Noted whenever the league is loaded, so a week is caught as long as
 * the app is opened at least once before the next week settles.
 */
const ledgers = new Map<string, Promise<StandingsLedger>>();

async function noteLedger(leagueId: string, snapshot: LeagueSnapshot): Promise<StandingsLedger> {
  const previous = ledgers.get(leagueId) ?? storage.readEntry(ledgerKey(leagueId)).then((entry) => (entry?.value as StandingsLedger | undefined) ?? { marks: {} });
  const next = previous.then(async (ledger) => {
    const noted = noteStandings(ledger, snapshot.teams, snapshot.fetchedAt);
    if (noted !== ledger) await storage.writeEntry(ledgerKey(leagueId), { savedAt: Date.now(), value: noted });
    return noted;
  });
  // A failed read or write is tried again next time rather than kept.
  ledgers.set(leagueId, next.catch(() => previous));
  return next;
}

/**
 * Each team's projected score for the week being played, saved once a week (the first time the
 * history is asked for in a week, with the stats ready), to set against its real score when the
 * week is over (shared/realisation.ts). Worked out on the server with the same model the page
 * builds; it takes a second or two, so it runs after the answer has gone.
 */
const projectionsPending = new Map<string, Promise<ProjectionLedger | null>>();

async function readProjections(leagueId: string): Promise<ProjectionLedger> {
  const entry = await storage.readEntry(projectionsKey(leagueId));
  return (entry?.value as ProjectionLedger | undefined) ?? { weeks: {} };
}

/** The week each league's projections are already saved for, so the check costs nothing after that. */
const projectionsNoted = new Map<string, number>();

function noteProjections(leagueId: string, snapshot: LeagueSnapshot): Promise<ProjectionLedger | null> {
  if (projectionsNoted.get(leagueId) === snapshot.week) return Promise.resolve(null);
  const pending = projectionsPending.get(leagueId);
  if (pending) return pending;
  const work = (async () => {
    const ledger = await readProjections(leagueId);
    if (ledger.weeks[snapshot.week] || snapshot.week < 1) {
      projectionsNoted.set(leagueId, snapshot.week);
      return ledger;
    }
    const report = await stats.report(snapshot, (await getPlayers()).value, await getInjuries());
    if (report.status !== "ready" || Object.keys(report.players).length === 0) return ledger;
    const projected = projectedThisWeek(snapshot, buildModel(snapshot, report, undefined, await scheduleAhead(snapshot)));
    if (Object.keys(projected).length === 0) return ledger;
    const next: ProjectionLedger = { weeks: { ...ledger.weeks, [snapshot.week]: { projected, savedAt: new Date().toISOString() } } };
    await storage.writeEntry(projectionsKey(leagueId), { savedAt: Date.now(), value: next });
    projectionsNoted.set(leagueId, snapshot.week);
    console.log(`[projections] saved week ${snapshot.week} for ${leagueId}`);
    return next;
  })().finally(() => projectionsPending.delete(leagueId));
  projectionsPending.set(leagueId, work);
  return work;
}

/**
 * The NBA games of the fantasy regular season from the start of this week (Monday) to its end:
 * the schedule the strength model plays its weeks on, and the games left for the Schedule axis.
 * Saved for a day; "unavailable" when the stats source has no schedule or it cannot be loaded.
 */
async function scheduleAhead(snapshot: LeagueSnapshot): Promise<ScheduleAhead> {
  const { weeks } = modelCalendar(snapshot);
  const start = weeks[0]?.start;
  const end = weeks.at(-1)?.end;
  if (!stats.hasSchedule() || !start || !end) return { status: "unavailable", games: [] };
  try {
    const games = (await cache.get(scheduleAheadKey(start, end), scheduleAheadTtl, () => stats.schedule(start, end), { background: true })).value;
    return { status: "ready", games: games.map(({ date, home, away }) => ({ date, home, away })) };
  } catch (error) {
    console.error("[schedule-ahead]", error instanceof Error ? error.message : error);
    return { status: "unavailable", games: [] };
  }
}

/** The mock league's finished weeks, from its own matchups (it has no real standings to split). */
async function mockRecordedWeeks(leagueId: string, snapshot: LeagueSnapshot): Promise<RecordedWeek[]> {
  const weeks: RecordedWeek[] = [];
  for (let week = 1; week < snapshot.week; week++) {
    const entry: RecordedWeek = { week, points: {}, opponent: {} };
    for (const matchup of await getWeekMatchups(leagueId, snapshot, week)) {
      const [a, b] = matchup.sides;
      for (const side of matchup.sides) entry.points[side.rosterId] = side.points;
      if (a && b) [entry.opponent[a.rosterId], entry.opponent[b.rosterId]] = [b.rosterId, a.rosterId];
    }
    weeks.push(entry);
  }
  return weeks;
}

const checkedRecorded = new Set<string>();

/** The league's injury report, saved; an empty list when the source has none or it cannot be had yet. */
async function getInjuries(phase: GamePhase = "quiet") {
  if (!stats.hasInjuries()) return [];
  try {
    const ttl = phase === "quiet" ? injuriesTtl : pregameInjuriesTtl;
    return (await cache.get("injuries-v1", ttl, () => stats.injuries(), { background: true })).value;
  } catch (error) {
    console.error("[injuries]", error instanceof Error ? error.message : error);
    return [];
  }
}

/** The draft board. A finished draft never changes, so it is checked weekly; one still running as often as the league. */
async function getDraftBoard(leagueId: string) {
  const key = `draft-v1-${leagueId}`;
  const saved = await cache.peek<{ board: { status: string } | null }>(key);
  const ttl = saved?.value.board?.status === "complete" ? finishedDraftTtl : leagueTtl;
  return cache.get(key, ttl, async () => ({ board: await loadDraftBoard(leagueId, fetchJson, (await getPlayers()).value) }), {
    background: true,
  });
}

/** The stats report's version for a league (see StatsReport.version), or null without stats. */
async function statsVersion(snapshot: LeagueSnapshot): Promise<string | null> {
  if (!statsProvider) return null;
  try {
    return (await stats.report(snapshot, (await getPlayers()).value, await getInjuries())).version ?? null;
  } catch {
    return null;
  }
}

// Keeping data fresh without waiting for a visit. Every minute the server looks over the leagues
// in use (the configured one, and any opened in the last day) and refreshes whatever has passed
// its time above: the league, the standings ledger, this week's schedule, box scores, the injury
// report, the schedule ahead, the draft and this week's saved projections. So a page that opens
// finds everything current, and nothing it shows changes a moment later. Data still fresh costs
// nothing (it is read from memory), and each source is called no more often than its time allows.
const keptFresh = new Map<string, number>();
const configuredLeague = mock ? MOCK_LEAGUE_ID : process.env.SLEEPER_LEAGUE_ID?.trim() || null;

function keepFreshLeague(leagueId: string): void {
  keptFresh.set(leagueId, Date.now());
}

async function freshen(leagueId: string): Promise<GamePhase> {
  const snapshot = (await getSnapshot(leagueId)).value;
  await noteLedger(leagueId, snapshot).catch((error) => console.error("[ledger]", error instanceof Error ? error.message : error));
  const phase = await phaseOf(leagueId);
  const live = phase === "live";
  const week = weekOf(snapshot);
  let games: WeekData["games"] = [];
  if (week && stats.hasSchedule()) games = (await getSchedule(week.start, week.end, phase).catch(() => null))?.value ?? [];
  // The days being played, on their own and often; then the usual sync of the last few days.
  if (live) await stats.keepLiveFresh(snapshot.league.season, liveDates(games, Date.now()), liveBoxMs);
  await stats.keepFresh(snapshot.league.season, live ? liveStatsMs : statsTtl);
  if (phase !== "quiet") await getInjuries(phase);
  // Works out the report now, so the first visit after new box scores does not wait for it.
  await statsVersion(snapshot);
  await scheduleAhead(snapshot);
  await getDraftBoard(leagueId).catch(() => {});
  void noteProjections(leagueId, snapshot).catch((error) => console.error("[projections]", error instanceof Error ? error.message : error));
  return phase;
}

let freshening = false;
let lastBusy = false;
/** Refreshes every league in use; says whether any has games on or about to tip. */
async function freshenAll(): Promise<boolean> {
  if (freshening) return lastBusy;
  freshening = true;
  let busy = false;
  try {
    const now = Date.now();
    const leagues = new Set<string>(configuredLeague ? [configuredLeague] : []);
    for (const [leagueId, at] of keptFresh) {
      if (now - at < KEEP_FRESH_FOR_MS) leagues.add(leagueId);
      else keptFresh.delete(leagueId);
    }
    for (const leagueId of leagues) {
      const phase = await freshen(leagueId).catch((error) => {
        console.error(`[fresh] ${leagueId}:`, error instanceof Error ? error.message : error);
        return "quiet" as const;
      });
      if (phase !== "quiet") busy = true;
    }
  } finally {
    freshening = false;
  }
  lastBusy = busy;
  return busy;
}

/** The keep-fresh loop: every minute, every 15 seconds while games are on or about to tip. */
function keepFreshLoop(): void {
  void freshenAll()
    .catch(() => false)
    .then((busy) => setTimeout(keepFreshLoop, busy ? KEEP_FRESH_LIVE_MS : KEEP_FRESH_MS).unref());
}

// Optional: keep an Eco dyno from sleeping. Heroku puts an Eco web dyno to sleep after 30 minutes
// without a visit, and waking it takes several seconds; with KEEP_AWAKE_URL set (the app's own
// address) the server visits itself every 20 minutes, within KEEP_AWAKE_HOURS if set ("7-24",
// in KEEP_AWAKE_TZ, UTC by default). Awake hours count against the account's Eco hours: about
// 744 a month around the clock, of 1000. See README "Deploying to Heroku".
const keepAwakeUrl = process.env.KEEP_AWAKE_URL?.trim() || null;
const KEEP_AWAKE_EVERY_MS = 20 * MINUTE;


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
    void noteLedger(leagueId, result.value).catch((error) => console.error("[ledger]", error instanceof Error ? error.message : error));
    const live = await isLive(leagueId);
    // Keep the schedule loaded too: it is how the server knows when games are on.
    const week = weekOf(result.value);
    if (week && stats.hasSchedule()) void getSchedule(week.start, week.end, live).catch(() => {});
    keepFreshLeague(leagueId);
    const snapshot: LeagueSnapshot = {
      ...result.value,
      stale: result.stale,
      refreshing: result.refreshing ?? false,
      live,
      statsVersion: await statsVersion(result.value),
    };
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
    res.json(await stats.report(snapshot.value, players.value, await getInjuries()));
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
    // "previous", a season's starting year ("2015"), or nothing for this season.
    const season = typeof req.query.season === "string" && /^(previous|\d{4})$/.test(req.query.season) ? req.query.season : "current";
    const detail = await stats.playerDetail(snapshot.value, players.value, req.params.playerId, season);
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
    const week = pickWeek(req.query.week, snapshot.value);
    if (week === null) {
      res.status(400).json({ error: BAD_WEEK });
      return;
    }
    const seasonStart = snapshot.value.league.seasonStartDate;
    if (!seasonStart) {
      res.status(502).json({ error: "Sleeper did not report when the season started, so this week's dates are unknown." });
      return;
    }
    const { start, end } = weekRange(seasonStart, week);
    const current = week === snapshot.value.week;
    const live = current && (await isLive(leagueId));

    let games: WeekData["games"] = [];
    let scheduleMessage: string | null = null;
    if (!stats.hasSchedule()) {
      scheduleMessage = "No stats source is set up, so the NBA schedule is not available.";
    } else {
      try {
        games = current
          ? (await getSchedule(start, end, live)).value
          : (await cache.get(finishedScheduleKey(start), finishedWeekTtl, () => stats.schedule(start, end))).value;
      } catch (error) {
        scheduleMessage = error instanceof Error ? error.message : "The NBA schedule could not be loaded.";
      }
    }
    // A past week's starters may have been dropped since, so ask for that week's players too.
    const pastPlayers = current
      ? []
      : (await getWeekMatchups(leagueId, snapshot.value, week)).flatMap((matchup) =>
          matchup.sides.flatMap((side) =>
            [...side.starters.map((entry) => entry.player), ...side.bench.map((entry) => entry.player)].flatMap(
              (player) => (player ? [player.id] : []),
            ),
          ),
        );
    const { lines, syncedAt } = await stats.weekLines(
      snapshot.value,
      players.value,
      start,
      end,
      live ? liveStatsMs : statsTtl,
      pastPlayers,
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

// Everything the Lineup plan reads, as fresh as the server has it: the matchup with Sleeper's
// latest scores, this week's schedule and box scores, lock marks and the injury report, each
// with the time it was brought up to date, and how soon to ask again. Answers from saved data
// at once; anything past its time (shorter while games are on or about to tip) is refreshed in
// the background, so the next ask has it. Admin only while the plan is experimental.
app.get("/api/league/:leagueId/plan", requireRole(auth, "admin"), async (req, res) => {
  try {
    const leagueId = String(req.params.leagueId ?? "").trim();
    const rosterId = Number(req.query.roster);
    if (!Number.isInteger(rosterId)) {
      res.status(400).json({ error: "Say which team: ?roster=<roster ID>." });
      return;
    }
    keepFreshLeague(leagueId);
    const [snapshotResult, players] = await Promise.all([getSnapshot(leagueId), getPlayers()]);
    const snapshot = snapshotResult.value;
    const seasonStart = snapshot.league.seasonStartDate;
    if (!seasonStart) {
      res.status(502).json({ error: "Sleeper did not report when the season started, so this week's dates are unknown." });
      return;
    }
    const { start, end } = weekRange(seasonStart, snapshot.week);
    // The sample league's week is in the past, so its plan is shown as of a moment inside that week.
    const nowMs = mock ? Date.parse(MOCK_PLAN_NOW) : Date.now();
    let phase = await phaseOf(leagueId);
    let games: WeekData["games"] = [];
    let scheduleMessage: string | null = null;
    let scheduleAt: number | null = null;
    if (!stats.hasSchedule()) {
      scheduleMessage = "No stats source is set up, so the NBA schedule is not available.";
    } else {
      try {
        const schedule = await getSchedule(start, end, phase);
        games = schedule.value;
        scheduleAt = schedule.savedAt;
        if (mock) phase = gamePhase(games, nowMs);
      } catch (error) {
        scheduleMessage = error instanceof Error ? error.message : "The NBA schedule could not be loaded.";
      }
    }
    // The days being played, without waiting for them (the next ask has them).
    if (phase === "live") void stats.keepLiveFresh(snapshot.league.season, liveDates(games, Date.now()), liveBoxMs);
    const { lines, syncedAt } = await stats.weekLines(snapshot, players.value, start, end, phase === "live" ? liveStatsMs : statsTtl);
    const matchup = snapshot.matchups.find((entry) => entry.sides.some((side) => side.rosterId === rosterId)) ?? null;
    const team = snapshot.teams.find((entry) => entry.rosterId === rosterId);
    const injuryReport = await getInjuries(phase);
    const report = await stats.report(snapshot, players.value, injuryReport);
    const injuries: Record<string, InjuryNews | null> = {};
    for (const side of matchup?.sides ?? []) {
      for (const entry of [...side.starters, ...side.bench]) {
        if (entry.player) injuries[entry.player.id] = report.players[entry.player.id]?.injury ?? null;
      }
    }
    const injuriesAt = (await cache.peek("injuries-v1"))?.savedAt ?? null;
    const body: LivePlanData = {
      phase,
      now: new Date(nowMs).toISOString(),
      pollMs: PLAN_POLL_MS[phase],
      week: {
        week: snapshot.week,
        start,
        end,
        schedule: scheduleMessage === null ? "ready" : "unavailable",
        scheduleMessage,
        games,
        lines,
        linesSyncedAt: syncedAt,
      },
      matchup,
      reserve: team?.reserve.map((player) => player.id) ?? [],
      marks: await markStorage.readLockMarks(leagueId, snapshot.week),
      injuries,
      asOf: {
        league: snapshot.fetchedAt,
        schedule: scheduleAt ? new Date(scheduleAt).toISOString() : null,
        boxScores: syncedAt,
        injuries: injuriesAt ? new Date(injuriesAt).toISOString() : null,
      },
    };
    res.json(body);
  } catch (error) {
    sendError(res, error);
  }
});

// Every finished week's final score per team, for the week-by-week chart on My team. Not from
// Sleeper's weekly matchups, which leave out locks in this league: from the change in the
// standings each week, and weeks recorded from Sleeper's app (shared/weekScores.ts).
app.get("/api/league/:leagueId/history", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const snapshot = (await getSnapshot(leagueId)).value;
    const ledger = await noteLedger(leagueId, snapshot);
    const recorded = mock ? await mockRecordedWeeks(leagueId, snapshot) : (RECORDED_WEEKS[leagueId] ?? []);
    if (!mock && !checkedRecorded.has(leagueId) && recorded.length > 0) {
      const problems = checkRecorded(ledger, recorded);
      if (problems.length > 0) console.warn("[history] recorded weeks disagree with the standings:", problems);
      checkedRecorded.add(leagueId);
    }
    const saved = await readProjections(leagueId);
    void noteProjections(leagueId, snapshot).catch((error) => console.error("[projections]", error instanceof Error ? error.message : error));
    const body: ScoreHistory = { ...weekScores(ledger, recorded, snapshot.week - 1), projections: saved.weeks };
    res.json(body);
  } catch (error) {
    sendError(res, error);
  }
});

// The NBA games left in the fantasy regular season, from today, for the schedule on My team.
app.get("/api/league/:leagueId/schedule-ahead", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    res.json(await scheduleAhead((await getSnapshot(leagueId)).value));
  } catch (error) {
    sendError(res, error);
  }
});

// Any week's matchups, from week 1 to the current one.
app.get("/api/league/:leagueId/matchups", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const snapshot = (await getSnapshot(leagueId)).value;
    const week = pickWeek(req.query.week, snapshot);
    if (week === null) {
      res.status(400).json({ error: BAD_WEEK });
      return;
    }
    const body: WeekMatchups = { week, matchups: await getWeekMatchups(leagueId, snapshot, week) };
    res.json(body);
  } catch (error) {
    sendError(res, error);
  }
});

// Lock marks: a manager's word on whether a starter's score is locked, for
// any week so far. Sleeper does not share locks.
app.get("/api/league/:leagueId/locks", async (req, res) => {
  try {
    const leagueId = req.params.leagueId.trim();
    const week = pickWeek(req.query.week, (await getSnapshot(leagueId)).value);
    if (week === null) {
      res.status(400).json({ error: BAD_WEEK });
      return;
    }
    res.json({ week, marks: await markStorage.readLockMarks(leagueId, week) });
  } catch (error) {
    sendError(res, error);
  }
});

app.put("/api/league/:leagueId/locks", requireRole(auth, "admin"), async (req, res) => {
  try {
    const leagueId = String(req.params.leagueId ?? "").trim();
    const body = (req.body ?? {}) as { rosterId?: unknown; playerId?: unknown; locked?: unknown; week?: unknown };
    const rosterId = Number(body.rosterId);
    const playerId = typeof body.playerId === "string" ? body.playerId : "";
    if (!Number.isInteger(rosterId) || !playerId || (body.locked !== null && typeof body.locked !== "boolean")) {
      res.status(400).json({ error: "Send rosterId, playerId and locked (true, false, or null to clear)." });
      return;
    }
    const snapshot = (await getSnapshot(leagueId)).value;
    const week = pickWeek(body.week, snapshot);
    if (week === null) {
      res.status(400).json({ error: BAD_WEEK });
      return;
    }
    // The mark is tied to the score Sleeper shows for that week, taken from
    // the server's copy rather than the browser's.
    const starter = (await getWeekMatchups(leagueId, snapshot, week))
      .flatMap((matchup) => matchup.sides)
      .find((side) => side.rosterId === rosterId)
      ?.starters.find((entry) => entry.player?.id === playerId);
    if (!starter) {
      res.status(404).json({ error: "That player is not one of this team's starters that week." });
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
    res.json((await getDraftBoard(req.params.leagueId.trim())).value);
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
  // Built files under /assets carry a hash of their contents in the name, so a browser may keep
  // them for good; the page itself and the service worker are always checked for a newer copy.
  app.use(
    express.static(dist, {
      setHeaders(res, file) {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.set("Cache-Control", "public, max-age=31536000, immutable");
        else res.set("Cache-Control", "no-cache");
      },
    }),
  );
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(port, () => {
  console.log(
    `[server] http://localhost:${port} (${mock ? "mock data" : "live Sleeper data"}, ` +
      `player stats: ${statsProvider ? statsProvider.name : "off, no BALLDONTLIE_API_KEY"})`,
  );
  // Right away (saved data loads into memory, so the first page is quick), then every minute.
  keepFreshLoop();
  if (keepAwakeUrl) {
    console.log(`[server] keeping awake: ${process.env.KEEP_AWAKE_HOURS?.trim() || "all day"}`);
    setInterval(() => {
      if (!inAwakeHours(process.env.KEEP_AWAKE_HOURS, localHour(process.env.KEEP_AWAKE_TZ))) return;
      void fetch(new URL("/healthz", keepAwakeUrl), { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    }, KEEP_AWAKE_EVERY_MS).unref();
  }
});
