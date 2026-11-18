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
   │  /api/...   (checks in every 2 minutes while open)
   ▼
Backend (server/)  ──►  storage (Postgres on Heroku, .cache/ locally)
   │                                │
   │ league data: every 10 min,     │ box scores: new games only;
   │ 2 min while games are on       │ schedule: 30 min, 3 min live
   ▼                                ▼
Sleeper API                     balldontlie API
```

- The browser never calls Sleeper or balldontlie. It asks the backend, which
  answers from saved data and updates it in the background (see "Keeping data
  fresh").
- Sleeper's full player list is fetched once a day, as their docs ask.
- One league update is about eight requests. Sleeper's limit is 1,000 per
  minute.
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
| Long absence (4+ games in a row) | availability | a current one with no return date is expected to last as long again; finished ones are not held against him |
| Return date buffer (`shared/injury.ts`) | when an injured player is back | none within 7 days; beyond that, 10% of the time away later (4 weeks: about 2 days; 8 weeks: about 5) |
| Re-evaluation date | when an injured player is back | read as the earliest return; the expected return is 10 days later |
| Return window spread | when an injured player is back | at least 25% of the time away, centred on the expected day |
| Injured reserve and waiver pickups | strength, trades | one player per IR slot; open spots filled from the 6 best free agents; the same rule before and after a trade |
| What they see of an injured player | what they see on averages | his average less the share of weeks he will miss, plus 10% of that; at most 80% off |
| Reluctance to trade at all | chance they accept | fixed: with the premium below, an even trade comes out at about a third |
| Own-player premium (managers overvalue their own players) | what they see on averages | fixed: their players count 8% higher (`OWN_PLAYER_PREMIUM`) |
| What they see on averages (players they would drop subtracted) | chance they accept | +0.8 to -2.0 on the log-odds scale |
| What the trade does to their team (a gain counts 0.75, a loss 1.5) | chance they accept | +1.25 to -2.0 on the log-odds scale |
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
are accepted, in three bands: likely (50% or more), possible (35 to 50%) and
long shots. The chance's parts are combined on the log-odds scale, so one bad
part (say, the trade clearly hurts their team) pulls it down however fair the
trade looks; the builder shows how many points each part adds or takes away,
and its one-line verdict uses the same chance. Likely ideas come first; possible ones fill out a short list or
are shown when nothing is likely; long shots appear only when there is
nothing better, at most three, with a plain note saying so. Versions of one offer
(the same team, the same players back and the same main piece sent, with
only the filler changed) count as one idea: only the best version is shown.
When you named a player to trade away, he is the main piece.

The search runs in layers, like a tree, and goes deeper only when it has to:

1. Swaps: every one-for-one (two of yours for a named or injured target),
   plus packages that fill another team's need.
2. If nothing from layer 1 is likely to be accepted, the 12 most promising
   near-misses (ranked like ideas: your gain times their chance) each grow by
   one player: one of your 5 least valuable players added as a sweetener (you
   refill from waivers), or, for a player you named to trade away, two of
   theirs for him.
3. Still nothing likely: the best of layer 2 grow again (a second sweetener,
   or one of their least valuable players coming back as well).

A package is kept only if it raises the chance of the offer it grew from by
at least 3 points; growing an offer is meant to make it easier to accept. No
idea that grades as a big loss for the other team (an F) is ever suggested,
and when only long shots exist, the fairest come first. The page says when
packages were built. Naming a player
allows offers that cost you up to a point a week. You can search for the best trades overall, a player at a
position, offers for one of your players, or offers for a named player on
another team (two-for-one packages are tried for a named target). Each idea
lists why it came up: a thin position it fills, depth it draws on, a sell-high
or buy-low gap, and the other team's situation. The chance of acceptance is a
reasoned estimate, not a measured probability.

The Trades tab reads top to bottom: the search ("I want to") and its ideas,
then the builder, then your best nine and position needs. Both builder rosters
start closed; "Open in builder" loads an idea and opens both. When one team
has fewer players (an empty bench or IR spot), its list is padded with empty
slots so the two rosters line up row for row.

### Injuries, IR and waiver pickups

`shared/injury.ts` and `fillRoster` in `shared/strength.ts`. The injury
report comes from the stats source (balldontlie's player injuries, on the
ALL-STAR plan). A return date is read as a window, not a day: a few days away
is taken almost as given; further out, the expected day moves a little later
and the window widens. A "re-evaluated" date is the earliest he could be
back, with the expected return 10 days after. "Out for the season" keeps him
out. A player marked out with no date is expected to miss as long again as
he has (half a week if just ruled out). A player who has not played this
season but is on the report with a date is projected at last season's level.

The model's imaginary weeks stand for the real weeks left in the regular
season, in turn, so an injured player plays none of the weeks he is out and
his usual share after: his weekly value is the average over the weeks left.

Every roster is run as its manager would: a player marked out goes on IR
(most out first, one per IR slot) and takes no active spot; open spots are
filled with the free agent who helps most; too many active players means
dropping the least valuable. When a player on IR is back, the least valuable
active player (a pickup or not) plays only until then; nobody goes for a
player out for the season. Rosters are filled the same way before and after
a trade, so a trade is credited only with the spots it opens, and a pickup
the team makes either way is not counted as the trade's. Trade cards and Top
moves list these follow-up moves (IR, pickups, drops) under "Team
management", apart from the players in the offer.

Trades with an injured player show two numbers under the team effect: the
weekly change while he is out and after he is back (`tradePhases`). The grade
and ranking use the whole rest of the season. Managers weighing a trade see
an injured player's average scaled down by the share of weeks he will miss
(`seenAverage`, capped), so they part with him more readily. The finder's
"trade for an injured player" looks only at players out at least about two
weeks who are due back this season, one for one or two of yours for one of
theirs (packages are matched to his level once he is back).

An injured player's player value counts only the weeks he plays (his value
above a free agent once back, times the share of weeks he plays): while he is
out, an IR slot and a pickup cover his spot. The team effect still counts the
zeros. If your IR slots are full, a received injured player uses a bench spot
while out, and the trade card says who holds the IR slot.

### Top moves (My team)

`topMoves` in `shared/moves.ts`. The My team tab lists the five moves that
would raise your team's strength most over the rest of the season: the trades
from "see the best trades for my team" (only those with at least a fair chance
of being accepted; long shots are left out) and the best waiver pickups, each
measured the same way, as the change in strength from the full projection. A
pickup drops the player your roster would miss least. Pickups compete on
merit; when none makes the five, the best one takes the last place so the
waiver wire stays in view. A trade opens in the builder on the Trades tab. The
search takes a second or two, so it runs after the page has painted and is
kept until the projections change.

### Lock-in scoring

This is a lock-in league: each starter counts one game per week. After a
player's game, the manager can lock that score in before the player's next
game; if nothing is locked, the last game of the week counts. Fantasy weeks
run Monday to Sunday (`shared/weeks.ts`).

## Keeping data fresh

There is no Refresh button. The server keeps every source up to date on its
own, within each service's rules, and pages are always answered from saved
data: anything older than the times below is fetched again in the background
while the saved copy is shown, and the page picks up the new copy a few
seconds later. "Games on" means an NBA game is in progress (from the saved
schedule); the header shows it.

| Data | Source | Fetched again after | Why |
| --- | --- | --- | --- |
| League (rosters, matchups, transactions; about 8 requests) | Sleeper | 10 min, 2 min while games are on (`LEAGUE_CACHE_MINUTES`, `LIVE_LEAGUE_MINUTES`) | Sleeper asks to stay under 1,000 requests a minute; this is at most about 4 |
| Player list | Sleeper | 24 hours | Sleeper asks for it at most once a day |
| Draft | Sleeper | 7 days once finished, else as the league | A finished draft never changes |
| A finished week's matchups (one request a week) | Sleeper | 6 hours for last week, 7 days for older weeks | Only Sleeper's stat corrections change them, in the days after a week |
| A finished week's NBA schedule (one request a week) | balldontlie | 7 days | Every game is final; saved apart from the current week's copy so a game-night copy is never shown as final |
| NBA schedule (one request) | balldontlie | 30 min, 3 min while games are on (`SCHEDULE_CACHE_MINUTES`, `LIVE_SCHEDULE_MINUTES`) | Scores and game states change on game nights |
| Box scores, while a matchup is open | balldontlie | 30 min, 10 min while games are on (`WEEK_STATS_MINUTES`, `LIVE_WEEK_STATS_MINUTES`) | balldontlie updates live stats about every 10 minutes |
| Box scores otherwise | balldontlie | 6 hours (`STATS_CACHE_HOURS`) | Season numbers barely move within a day |
| Last season's box scores | balldontlie | Never again | It is over |
| Team logos | NBA | 30 days | They do not change |
| Injury report (one or two requests) | balldontlie | 30 min (`INJURY_CACHE_MINUTES`) | Return dates and notes change a few times a day |

Every balldontlie request goes through one queue, at least 1.1 seconds apart
(at most about 54 a minute; the ALL-STAR plan allows 60). Requests someone is
waiting on (the schedule) go before background downloads (box scores). Each
sync re-downloads only the last two days, to pick up stat corrections. The
page itself checks in with the server every 2 minutes while it is visible, and
when it comes back into view; the server decides whether anything outside is
asked. No page request waits on an outside service once data is saved, which
keeps every answer well inside Heroku's 30-second limit, including the first
visit after an Eco dyno wakes.

## Storage

Everything the server downloads (league snapshots, the player list, box
scores, schedules, logos) is kept between restarts through one storage
interface (`server/storage.ts`):

- **Postgres** when `DATABASE_URL` is set. Heroku sets it, and its disk is
  wiped on every restart, so this is how the hosted app keeps its data. Tables
  are created automatically: `cache_entries` (key, saved time, JSON value),
  `game_lines` (one row per player per game), `stat_datasets` (when each
  season was last synced) and `lock_marks` (your lock corrections, below). A
  sync writes only the games it downloaded.
- **Files in `.cache/`** otherwise, as before.
- **Memory only** in mock mode and tests.

`npm run db:import` copies an existing `.cache/` into the database at
`DATABASE_URL`, so a new database starts full instead of downloading the
season again. Storage tests also run against Postgres when
`TEST_DATABASE_URL` is set.

## Sign-in and roles

The hosted app asks for a password. There are two:

- `ADMIN_PASSWORD`: everything, including marking locks.
- `VIEWER_PASSWORD`: for league mates. Everything except marking locks; the
  lock buttons are not shown.

A sign-in sets a signed cookie (`SESSION_SECRET`) that lasts 30 days. Ten
wrong tries from one address within 15 minutes are refused. With sign-in on
and `SLEEPER_LEAGUE_ID` set, the app serves only that league. Locally, with
no `ADMIN_PASSWORD`, there is no sign-in and you are admin. In production
(`NODE_ENV=production`, which Heroku sets) the server will not start without
`ADMIN_PASSWORD`.

## Deploying to Heroku

The app runs on one Eco dyno ($5 a month for the account's pool of dyno
hours; it sleeps after 30 minutes without visits and wakes on the next one)
with a Heroku Postgres Essential-0 database ($5 a month). Heroku builds with
`npm run build` and starts the `Procfile` (`npm start`). Run these from the
project folder, signed in with `heroku login`:

```bash
# 1. Create the app (the name must be unique on Heroku; it becomes the web address).
heroku create fantasytool-yourname

# 2. Add the database. It takes a minute; `heroku pg:info` shows "Available" when ready.
heroku addons:create heroku-postgresql:essential-0
heroku pg:info

# 3. Set the secrets. Pick your own passwords; the stats key is read from .env.
heroku config:set \
  ADMIN_PASSWORD='your-admin-password' \
  VIEWER_PASSWORD='password-for-league-mates' \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  SLEEPER_LEAGUE_ID=1416212537531211776 \
  BALLDONTLIE_API_KEY="$(grep '^BALLDONTLIE_API_KEY=' .env | cut -d= -f2-)"

# 4. Copy your saved data into Heroku's database, so the app starts full.
DATABASE_URL="$(heroku config:get DATABASE_URL)" npm run db:import

# 5. Deploy. From a branch other than main, push it to Heroku's main.
git push heroku main
#   or, from the database-and-heroku branch:
git push heroku database-and-heroku:main

# 6. Run it on an Eco dyno and open it.
heroku ps:type web=eco
heroku ps
heroku open
```

Later deploys are step 5 again. `heroku logs --tail` shows the server's log,
`heroku config` lists the settings, and `heroku config:set NAME=value`
changes one (the app restarts).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Backend on :8787 and React dev server on :5173, live Sleeper data |
| `npm run dev:mock` | Same, with a made-up ten-team league and no network calls |
| `npm test` | Unit tests (cache rules, snapshot assembly) |
| `npm run typecheck` | TypeScript check for the whole repo |
| `npm run check:sleeper` | Confirms Sleeper answers for NBA from your machine |
| `npm run check:stats` | Confirms the stats key works and shows player matching |
| `npm run check:sleeper -- <league_id> --raw-matchup` | Also prints one team's raw matchup entry, to see every field Sleeper sends |
| `npm run check:sleeper -- <league_id> --raw-rosters` | Also lists every roster, league and transaction field, to look for anything that records a lock |
| `npm run check:stats -- <league_id> --schedule` | Prints this week's NBA schedule from the stats source |
| `npm run check:stats -- <league_id> --injuries` | Prints the injury report and how the app reads each return date (add `--player "Name"` for one player's full note) |
| `npm run db:import` | Copies `.cache/` into the database at `DATABASE_URL` |
| `npm run check:logos` | Downloads every team logo and writes a preview page |
| `npm run serve` | Builds the React app and serves everything from :8787 |
| `npm start` | Serves the built app (what Heroku runs after building) |

## Live matchup

Opening a matchup shows both lineups slot by slot, modelled on Sleeper's
matchup screen: each starter's counted score, his status, his next game, and
a strip of his NBA team's games this week (opponent logo, then his points or
the day). Your team is on the left.

Sleeper's matchup data has each starter's counted score but no word on
whether it is locked, and the total includes stand-in scores (an unlocked
starter shows his latest game). The status is worked out from the box scores
and the NBA schedule (`shared/matchup.ts`):

| Status | Meaning |
| --- | --- |
| Locked | The score is an earlier game this week; if it were not locked, it would have moved to his newer game. |
| Final | His last game of the week is over. |
| Can lock | The score is his latest game and he has games left. It can still be locked before his next game, or already is (you know; the data does not say). |
| Live | His game is being played. |
| Yet to play | No games yet this week. |
| Checking | The score matches none of his box scores yet (they may still be loading). |
| Probably locked | Other team only: a "can lock" score that beats what waiting is expected to bring, so a manager would usually have locked it. It becomes certain when his next game starts. |

**Marking locks.** Sleeper never says which scores are locked, so any
starter whose score is his latest game can be marked from his card: "Mark
locked" (or "It is locked" / "Not locked" on a probable lock). Marks are
saved through the storage layer for the league and week, so anyone using the
app sees them, and they feed the statuses, totals, lock advice and win chance.
A mark is tied to the score it was made on: if the player's Sleeper score
changes, he played again, so that score was not locked and the mark stops
applying. Scores the data settles by itself (an earlier game, a final game)
ignore marks.

Box scores lack technical and flagrant fouls, so a score a few foul
deductions (from the league's `tf` and `ff` settings) below a game still
matches it. A game his team played without him counts as zero.

The header labels each team's numbers:

- **Expected final**: where the team should end the week (below).
- **Locked or final**: scores we can tell are settled. A latest-game score
  with games still to come may also be locked, but Sleeper does not say, so
  Sleeper's own app can show a higher locked total for the other team.
- **Sleeper's live total**: what Sleeper's API reports, each starter's latest
  game whether locked or not. Mid-week it is not a real score.

"Yet to play" counts starters whose score is not settled and who still have
a game, as Sleeper does. A latest game a player sat out leaves nothing to
lock, so he shows as yet to play.

Injury tags count this week only, by fixed amounts: **out** means he misses
his next game and is half as likely to play later this week; **day-to-day**
makes his next game 40% less likely (`INJURY_EFFECT`). Each card shows his
projected score per game and the slot's expected final.

Sleeper's projected totals are its per-game projections; ours also count the
lock-in choice (keeping the best of several games), so they run higher.

For your starters who can lock, the view says **Lock now** or **Wait**: lock
when the score in hand beats what waiting is expected to bring, which is his
expected locked score from his remaining games, weighted by his chance of
playing each one. The **win chance** and projected finals play out the rest of
the week 4,000 times: settled scores stay, everyone else plays his remaining
games, and each manager locks by the same rule. Starters stay in their slots;
bench swaps are not modelled. These are display only and feed nothing else.

Each game in a card's strip can be selected (his live game, else his next
game, is open to start). A played or live game shows the score, the clock,
his box score line and his fantasy points; a game to come shows his projected
points and, if he might miss it, his chance of playing.

The NBA schedule comes from the stats source (`fetchSchedule` on the
`StatsProvider`). How often it and the box scores update is in "Keeping data
fresh" below. The matchup view reloads every 3 minutes while open.

### Past weeks

The week menu above the matchups lists every week so far. A finished week
shows the final scores and who won, and its matchup page reads the same way
as the current week's, from that week's box scores:

| Status | Meaning in a finished week |
| --- | --- |
| Locked | The score is an earlier game of the week. Without a lock his last game would have counted, so it was locked for certain. |
| Final | The score is his last game of the week, locked or simply left to count; the result is the same. |
| No games left | He did not play that week; nothing counted. |
| Unclear | The score matches none of his box scores, usually a Sleeper stat correction or a foul the box score leaves out. The admin can mark it locked. |

The header shows the final score, the scores locked early (with how many),
and how many are unclear. There is no forecast or lock advice once a week is
over. Marks are saved per week, so marking a past week leaves this week alone.
A player who has changed NBA teams since is matched to the team in his box
scores that week, and a starter dropped since still gets his games.

Each finished week costs one Sleeper request and one balldontlie request,
saved: last week is checked again every 6 hours (for Sleeper's stat
corrections), older weeks weekly. The browser never asks for a week after the
current one.

## Draft board

The Draft tab shows the league's draft the way Sleeper's board does: one
column per draft slot, one row per round, each card labeled with Sleeper's
pick number ("2.12"). Cards are neutral; the bottom third shows the player's
positions in their colors, split evenly when he has two or three. The backend
loads the draft with three requests (`/league/:id/drafts`, `/draft/:id`,
`/draft/:id/picks`), cached like the league.

A green rising mark means a player is worth at least a round earlier than he
went; a red falling mark, at least a round later. Every drafted player is
ranked by his weekly value now (what he locks in an average week at his
projected level, allowing for missed games), and that rank is compared with
the order he was picked in (`shared/draft.ts`). Anything within a round shows
no mark. It is a display label only and feeds nothing else.

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
