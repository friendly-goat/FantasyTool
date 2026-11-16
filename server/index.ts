import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AppConfig, LeagueSnapshot } from "../shared/types.ts";
import { Cache } from "./cache.ts";
import { fetchFromMock, MOCK_LEAGUE_ID } from "./mock.ts";
import { fetchFromSleeper, SleeperError } from "./sleeper.ts";
import { buildSnapshot, loadPlayers, loadUserLeagues } from "./snapshot.ts";

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

const fetchJson = mock ? fetchFromMock : fetchFromSleeper;
const cache = new Cache({ dir: mock ? null : ".cache" });
const app = express();

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
    const key = `league-${leagueId}`;

    // "Refresh" bypasses the cache, but not more often than the minimum
    // gap, so repeated clicks cannot hammer Sleeper.
    const age = await cache.age(key);
    const force = req.query.refresh === "1" && (age === null || age >= minRefreshGap);

    const result = await cache.get(
      key,
      leagueTtl,
      async () => {
        const players = await cache.get("players-nba", playersTtl, () => loadPlayers(fetchJson));
        return buildSnapshot(leagueId, fetchJson, players.value);
      },
      { force },
    );
    const snapshot: LeagueSnapshot = { ...result.value, stale: result.stale };
    res.json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

// After `npm run build`, this server also serves the compiled React app.
const dist = path.resolve("dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.listen(port, () => {
  console.log(
    `[server] http://localhost:${port} (${mock ? "mock data" : "live Sleeper data"})`,
  );
});
