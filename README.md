# FantasyTool

An analysis tool for a Sleeper NBA fantasy league. It reads your league
from Sleeper's public read-only API, shows it in a dashboard, and will grow
into a trade idea and analysis tool.

**Status:** milestone 4 of 5 under way. Working: the league dashboard, player
stats scored with your league's settings, a My team tab, a **Strength** tab
rating every team from 1 to 1000 for the rest of the season, and a **Trades**
tab that grades any trade for both managers and suggests one-for-one swaps.
See [Roadmap](#roadmap).

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

### Player stats

Player stats come from [balldontlie](https://www.balldontlie.io) and need an
API key on the ALL-STAR plan or higher. Copy `.env.example` to `.env`, set
`BALLDONTLIE_API_KEY`, and restart the server. Without a key the app still
works and simply shows no stats.

The first time stats load, the server downloads every game of the season so
far, which takes a minute or two. After that it only fetches the last few
days, at most once every six hours.

To confirm the key works and see how many of your league's players were
matched:

```bash
npm run check:stats -- <your_league_id>
npm run check:stats -- <your_league_id> --player "James Harden"   # adds a game log
```

The check also compares the scores Sleeper credited to each starter with this
app's scores for that player's games in the same week, and for each rostered
player without stats it lists similar names in the stats source.

If the dashboard does not load your league, run the connectivity check and
look at what it prints:

```bash
npm run check:sleeper -- <your_league_id>
```

## How it works

```
Browser (React app, src/)
   │  /api/league/:id          /api/league/:id/stats
   ▼
Local backend (server/)  ──►  cache (.cache/*.json)
   │                                │
   │ league data: when older        │ game stats: new games only,
   │ than an hour, or on Refresh    │ every six hours at most
   ▼                                ▼
Sleeper API                     balldontlie API
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

### How fantasy points are calculated

- Each game line from the stats source is scored with your league's Sleeper
  scoring settings (`server/scoring.ts`). Averages count only finished games
  the player actually played in.
- Games dated before the season's first day (which Sleeper reports) are
  treated as preseason and left out.
- Sleeper and balldontlie use different player IDs, so players are matched by
  name, with the NBA team as a tiebreaker (`server/stats/match.ts`). A name
  that fails to match can be fixed by hand in `server/stats/overrides.ts`.
- Box scores do not include technical or flagrant fouls, so leagues that
  score those will see slightly higher numbers than Sleeper for a few players.
  The app says so when it applies.
- Checked against the owner's league: of 416 scores Sleeper credited to
  starters, 382 equal this app's game score to the cent. Most of the rest are
  technical fouls or a stat the two data sources recorded differently.
- Still assumed, because no checked game has shown it either way: a 50-point
  game earns both the 40+ and 50+ bonus, and a triple-double also earns the
  double-double bonus.

### Why averages differ from the Sleeper app

The season average in Sleeper's app is not the mean of a player's game
scores. Sleeper scores the season totals, so every threshold bonus (40+
points, 50+ points, 20+ rebounds, 15+ assists) is added once as soon as the
season total passes it. In this league that is up to +30 points spread over
the games played: about +2.3 per game after 13 games, shrinking as the
season goes on.

This app shows the true per-game mean, because that is what a locked game is
worth. The player panel also shows the number Sleeper displays
(`sleeperDisplayedAverage` in `server/scoring.ts`), so the two can be compared.
This was worked out from the numbers, not from Sleeper documentation.

### Lock-in value

Players are valued by the score you can expect to lock from them in a week,
not by their average. With three games in a week you can pass on a poor game
and wait, so a player whose scores swing is worth more than a steady player
with the same average. `lockInValue` works this out from the player's own game
scores this season. It assumes three games in every week for now.

A team's strength is the combined lock-in value of its best legal lineup,
found by trying every way to fill the slots. The trade analyzer will compare
that number before and after a trade, for both teams.

### Team strength (1 to 1000)

`shared/strength.ts`. The number behind it is a team's projected weekly score:
the points its best lineup is expected to lock in an average week for the rest
of the season. The app plays out 200 imaginary weeks. In each one:

1. every player's NBA team has 2, 3 or 4 games;
2. he plays each game as often as he has this season (`games / teamGames`,
   blended with a typical rate early on);
3. he is worth his lock-in value for the games he plays, or nothing;
4. the team fields its best legal lineup from whoever is available.

The average is the projected weekly score. It is put on a 1 to 1000 scale
between two reference teams from the same league: a team built from the best
free agents (1) and the nine best players never missing a game (1000).
Players with few games are pulled toward a typical free agent. Each player
sees the same imaginary weeks on any roster, so before-and-after comparisons
are not blurred by luck, and results are identical on every run.

### Trade grades

`shared/trade.ts`. A trade is judged by the change in each team's projected
weekly score. Rosters keep their size: a team that receives fewer players
picks up the free agent who helps it most, and a team that receives more
drops its least valuable player. Each manager gets:

- a grade from 1 to 100 with a letter, where 50 means no real change and
  +4 points a week is about 73;
- the change in team strength.

Trade ideas are one-for-one swaps that raise your projected score without
lowering the other team's, where your player does not look clearly worse on
average than the one you ask for.

### Lock-in scoring

This is a lock-in league: each starter counts one game per week. After a
player's game, the manager can lock that score in before the player's next
game; if nothing is locked, the last game of the week counts. Fantasy weeks
run Monday to Sunday (`server/weeks.ts`).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend on :8787 and React dev server on :5173, live Sleeper data |
| `npm run dev:mock` | Same, with a made-up ten-team league and no network calls |
| `npm test` | Unit tests (cache rules, snapshot assembly) |
| `npm run typecheck` | TypeScript check for the whole repo |
| `npm run check:sleeper` | Confirms Sleeper answers for NBA from your machine |
| `npm run check:stats` | Confirms the stats key works and shows player matching |
| `npm start` | Builds the React app and serves everything from :8787 |

## Layout

```
server/   Local backend: Sleeper client, cache, snapshot assembly, mock league
server/stats/  Stats source (balldontlie), player matching, per-player summaries
shared/   Types, lock-in value and lineup analysis used by backend and frontend
src/      React app
scripts/  One-off tools
```

## Roadmap

1. **League dashboard.** Done.
2. **Player stats.** Done. A stats source behind a `StatsProvider` interface,
   matched to Sleeper's player IDs, scored with the league's settings.
3. **Team analysis.** Done: lock-in value, best-lineup search, free-agent
   upgrades, team strength.
4. **Trade analyzer.** In progress. Done: grades and strength change for any
   two-team trade, one-for-one trade ideas. To do: two-for-one and
   two-for-two ideas, each player's real schedule, and using past seasons to
   judge how early-season form holds up.
5. **Deeper analysis.** Past seasons as a guide to who is likely to rise or
   fade, and other ways to surface moves that are easy to miss. No chatbot:
   everything is computed from data.

## Notes on Sleeper's API

- It is read-only and needs no login. This tool cannot change your league.
- Sleeper's docs describe NFL only. This tool uses the same endpoints with `nba` as the sport.
- It is free for non-commercial use.
