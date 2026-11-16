# FantasyTool

An analysis tool for a Sleeper NBA fantasy league. It reads your league
from Sleeper's public read-only API, shows it in a dashboard, and will grow
into a trade idea and analysis tool.

**Status:** milestone 1 of 5. The league dashboard works (standings, rosters,
matchups, recent activity). Player stats, valuation and trade analysis are
not built yet. See [Roadmap](#roadmap).

## Run it

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install

# See the app with built-in sample data (no network needed)
npm run dev:mock

# Run it against Sleeper
npm run dev
```

Then open http://localhost:5173. On first run, enter your Sleeper username
and pick your league. The choice is remembered in your browser.

To skip the picker, copy `.env.example` to `.env` and set `SLEEPER_LEAGUE_ID`.

If the dashboard does not load your league, run the connectivity check and
look at what it prints:

```bash
npm run check:sleeper -- <your_league_id>
```

## How it works

```
Browser (React app, src/)
   │  /api/league/:id
   ▼
Local backend (server/)  ──►  cache (.cache/*.json)
   │  only when the cache is older than an hour, or on Refresh
   ▼
Sleeper API (api.sleeper.app)
```

- The browser never calls Sleeper. It asks the local backend, which answers
  from its cache when it can.
- League data is reused for 60 minutes. The **Refresh** button asks Sleeper
  again, at most once per minute per league.
- Sleeper's full player list is fetched once a day, as their docs ask.
- One full refresh is about ten requests. Sleeper's limit is 1,000 per minute.
- If Sleeper is unreachable, the last saved data is shown with a notice.

The backend turns Sleeper's raw responses into the shapes in
`shared/types.ts`, so the UI does not depend on Sleeper's format.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend on :8787 and React dev server on :5173, live Sleeper data |
| `npm run dev:mock` | Same, with a made-up ten-team league and no network calls |
| `npm test` | Unit tests (cache rules, snapshot assembly) |
| `npm run typecheck` | TypeScript check for the whole repo |
| `npm run check:sleeper` | Confirms Sleeper answers for NBA from your machine |
| `npm start` | Builds the React app and serves everything from :8787 |

## Layout

```
server/   Local backend: Sleeper client, cache, snapshot assembly, mock league
shared/   Types used by both backend and frontend
src/      React app
scripts/  One-off tools
```

## Roadmap

1. **League dashboard** (this milestone).
2. **Player stats.** Add a stats source behind a `StatsProvider` interface and
   map its players to Sleeper's player IDs.
3. **Valuation engine.** Apply the league's scoring settings to player stats to
   get fantasy value per player, plus team strengths and gaps. Plain code with
   tests, no AI.
4. **Trade analyzer.** Build a trade, see the impact on both teams.
5. **AI suggestions.** An LLM proposes and explains moves using the numbers
   from the valuation engine.

## Notes on Sleeper's API

- It is read-only and needs no login. This tool cannot change your league.
- Sleeper's docs describe NFL only. This tool uses the same endpoints with `nba` as the sport.
- It is free for non-commercial use.
