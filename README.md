# FantasyTool

An analysis tool for a Sleeper NBA fantasy league. It reads your league
from Sleeper's public read-only API, shows it in a dashboard, and will grow
into a trade idea and analysis tool.

**Status:** milestone 4 of 5 under way. Working: the league dashboard, player
stats scored with your league's settings, rest-of-season projections with a
chart, a My team tab, a Strength tab (1 to 1000), and a Trades tab that grades
any trade for both managers and finds trades for your team with reasons.
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
with the same average. `lockInValue` works this out from a list of game
scores. A player's "weekly value" is this on his own, over weeks of 2 to 4
games, allowing for games he misses.

A team is more than the sum of its players' weekly values, because slots can
rotate players day to day; see Team strength below.

### How the analysis is kept in balance

Every signal is a separate step with a fixed limit on how far it can move a
number, and each reports its size, so none can take over and every result
can be explained. Nothing is a rule about a particular player or position:
needs, depth and pressure are measured by changing a roster and seeing what
happens to its projected weekly score.

| Signal | Where | Limit |
|---|---|---|
| Recent games count more | projection | a game 15 games ago counts half |
| Last season's level | projection | counts like 10 extra games, fading as this season grows |
| Minutes rising or falling | projection | at most 8% either way |
| Game-to-game spread | strength | his own, blended with the league's typical spread until he has 6 games; kept between 10% and 60% of his level |
| Scattered missed games | availability | a rate, blended with a typical 90% early on |
| Long absence (4+ games in a row) | availability | a current one is expected to last as long again; finished ones are not held against him |
| Reluctance to trade at all | chance they accept | fixed: an even trade comes out a little under 50% |
| What they see on averages (players they would drop subtracted) | chance they accept | +1.0 to -2.0 on the log-odds scale |
| What the trade does to their team | chance they accept | ±1.5 on the log-odds scale |
| Pressure on the other team (absences, record, this week's matchup) | chance they accept | 0 to +0.6 on the log-odds scale |

### Projections

`shared/projection.ts`. A player's rest-of-season level starts from this
season's average and applies the three projection steps above. The player
panel charts his games, then the projected level over the games he is
expected to play, and lists what each step added or removed. A player whose
projection sits well below his average is a sell-high candidate; well above, a
buy-low one.

Last season's stats download once, in the background, after this season's
(several minutes). Until they arrive, projections work without them.

### Team strength (1 to 1000)

`shared/strength.ts`. The number behind it is a team's projected weekly score:
the points it is expected to lock in an average week for the rest of the
season. The app plays out 200 imaginary weeks, day by day, the way a lock-in
week is managed:

1. each NBA team has 2, 3 or 4 games on set days, and a player plays each as
   often as he is expected to (see the availability rows above);
2. each game's score is drawn around his projected level, with his own
   game-to-game spread;
3. each day, the players with a game go into the open starting slots, best
   first, tightest slots first. The lineup set in Sleeper is ignored: the app
   assumes the best lineup every day;
4. after the games, a slot is locked when its score beats what that slot can
   still expect from the rest of the week, from everyone left on the roster.
   A locked slot and its player are done for the week;
5. at the end of the week an open slot keeps the last game played in it.

Because an open slot can take a different player each day, bench players are
extra chances at a big game, not just injury cover. The Strength tab shows
how much the bench adds over the best nine alone.

The average is put on a 1 to 1000 scale between two reference rosters from
the same league: the best free agents (1) and the league's best players on one
roster (1000). Each player sees the same imaginary weeks on any roster, so
before-and-after comparisons are not blurred by luck, and results are
identical on every run. Trade searches rank swaps on a short run of weeks and
re-check the shortlist on all 200.

### Trade grades

`shared/trade.ts`. A trade is judged by the change in each team's projected
weekly score. Rosters keep their size: a team that receives fewer players
picks up the free agent who helps it most, and a team that receives more
drops its least valuable player. Each manager gets:

- a letter grade (from a 1 to 100 score that is not shown, where 50 means no
  real change and +4 points a week is about 73);
- the change in team strength.

### Grades

Each manager gets a letter for how good the trade is for their own team: A a
big win, B a win, C about even, D a loss, F a big loss. Both teams can get an
A. The 1 to 100 number behind the letter is not shown, because a 52 reads like
a failing mark when it means "about even".

### Player value, team effect and fit

Every trade is shown three ways:

- **Player value** (the slider at the top): each player's own weekly value
  above a typical free agent, added up per side, with no team context. Value
  above a free agent, rather than raw value, keeps two-for-ones honest: two
  bench players do not add up to one star, since a roster spot can always be
  filled from waivers.
- **Team effect** (the bar on each team's card): the change in that team's
  strength, the trade in context.
- **Fit**: team effect minus player-value change. Positive fit means the trade
  is worth more to that team than its players' value says, usually because it
  fills a thin position, adds depth, or covers for an injury.

The search also looks for one move on purpose: when another team is thin at
a position where you have a player, it tries him plus one of your spare
players for one of their better players at a position where they have depth.

From these, each trade gets a plain label from the user's side: you get more
player value because your side is worth more to them; win-win; even on paper
but better for your roster; ahead on player value; worth more to your roster
than on paper; costs you; or about even. The label and the points under it
are an explanation only. Grades, chances and the ranking of ideas do not use
the labels. "A real change" in a label means the same as a B- or better.

### Finding trades

`findTrades` in `shared/trade.ts`, with `shared/insight.ts`. Trades are ranked
by the weekly points they add for you multiplied by the estimated chance they
are accepted, in three bands: likely (55% or more), possible (40 to 55%) and
long shots. The chance's parts are combined on the log-odds scale, so one bad
part (say, the trade clearly hurts their team) pulls it down however fair the
trade looks; the builder shows how many points each part adds or takes away,
and its one-line verdict uses the same chance. Likely ideas come first; possible ones fill out a short list or
are shown when nothing is likely; long shots appear only when there is
nothing better, at most three, with a plain note saying so. Naming a player
allows offers that cost you up to a point a week. You can search for the best trades overall, a player at a
position, offers for one of your players, or offers for a named player on
another team (two-for-one packages are tried for a named target). Each idea
lists why it came up: a thin position it fills, depth it draws on, a sell-high
or buy-low gap, and the other team's situation. The chance of acceptance is a
reasoned estimate, not a measured probability.

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
| `npm run check:logos` | Downloads every team logo and writes a preview page |
| `npm start` | Builds the React app and serves everything from :8787 |

## Look

Positions always appear as colored chips (PG pink, SG orange, G coral, SF
green, PF blue, F teal, C purple, UTIL periwinkle), with the colors set once at
the top of `src/styles.css`. On a phone, secondary table columns are hidden,
wide tables keep player names in view while they scroll, notes fold away under
"About these numbers", and the trade rosters start folded so the trade finder
is close at hand.

Next to each player's NBA team abbreviation is the team's logo. Logos come
from the NBA's own image server as SVG files, so every team's logo is equally
sharp and sits in the same square box at the same size. Each team has a version
drawn for light backgrounds and one for dark backgrounds, and the app shows the
one that matches the theme. The browser asks the backend
(`/api/logos/:team/:light|dark`), which downloads each logo once and caches it
for 30 days; logo files are never stored in the repo. If a logo can't be
downloaded, the abbreviation shows alone. `npm run check:logos` downloads all
60 and writes `.cache/logo-preview.html` so you can see them side by side.

In the trade builder, each team's card lists the players who would join
(green +) and leave (red −), with each one's player value. The trade finder
opens with your best nine starters in Sleeper's slots beside need and cover by
position, with the thinnest spot and the position with the most depth tagged.
These tags use the same rules as the trade explanations, so they always agree.

Standings draw a dashed line under the last playoff spot, using the playoff
start week and team count from the league's Sleeper settings.

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
   two-team trade; a trade finder with reasons; projections using last
   season. To do: each player's real schedule (also for the matchup view),
   playoff weeks, two-for-two ideas.
5. **Deeper analysis.** Past seasons as a guide to who is likely to rise or
   fade, and other ways to surface moves that are easy to miss. No chatbot:
   everything is computed from data.

## Notes on Sleeper's API

- It is read-only and needs no login. This tool cannot change your league.
- Sleeper's docs describe NFL only. This tool uses the same endpoints with `nba` as the sport.
- It is free for non-commercial use.
