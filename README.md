# FantasyTool

An analysis tool for a Sleeper NBA fantasy league. It reads your league
from Sleeper's public read-only API, shows it in a dashboard, and will grow
into a trade idea and analysis tool.

**Status:** milestone 4 of 5 under way. Working: the league dashboard, player
stats scored with your league's settings, rest-of-season projections with a
chart, a My team tab, a Rankings tab (standings, or team strength from 1 to
1000), and a Trades tab that grades
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
| Game-to-game spread | strength | his own (fitted to his real two-game lock-in value), blended with the typical spread for his level until he has 6 games (spread falls as level rises: about 0.28 for 40+ a game, 0.75 under 15); kept between 10% and 60% of his level |
| Upper outliers (skewed games) | strength, every lock-in value | games drawn half lognormal, half normal, with the same average and spread (`UPPER_TAIL_SHARE` 0.5); about +1% on a typical weekly value, up to +2% for a boom-or-bust player in a four-game week |
| Scattered missed games | availability | a rate, blended with a typical 90% early on |
| Long absence (4+ games in a row) | availability | a current one with no return date is expected to last as long again; finished ones are not held against him |
| Return date buffer (`shared/injury.ts`) | when an injured player is back | none within 7 days; beyond that, 10% of the time away later (4 weeks: about 2 days; 8 weeks: about 5) |
| Re-evaluation date | when an injured player is back | read as the earliest return; the expected return is 40% of the time from the report to the re-evaluation later, at least 7 days (2 weeks off: back in about 3; 8 weeks: about 11) |
| Return window spread | when an injured player is back | at least 25% of the time away, centred on the expected day |
| Injured reserve and waiver pickups | strength, trades | one player per IR slot; open spots filled from the 6 best free agents; the same rule before and after a trade |
| Free upgrades (a trade's what-if only) | trades | for a team the trade opens a roster spot for, every swap of its weakest player for a better free agent worth making (up to 5); none for a team that gets as many players as it sends; made once, on the roster before the trade, and the trade is made on that roster; never below the team as it stands |
| What they see of an injured player | what they see on averages | his average less the share of weeks he will miss, plus 10% of that; at most 80% off |
| Reluctance to trade at all | chance they accept | fixed: with the premium below, an even trade comes out at about a third |
| Own-player premium (managers overvalue their own players) | what they see on averages | fixed: their players count 8% higher (`OWN_PLAYER_PREMIUM`) |
| What they see on averages (players they would drop subtracted) | chance they accept | +0.8 to -2.0 on the log-odds scale |
| What the trade does to their team (a gain counts 0.75, a loss 1.5) | chance they accept | +1.25 to -2.0 on the log-odds scale |
| Pressure on the other team (absences, record, this week's matchup) | chance they accept | 0 to +0.6 on the log-odds scale |
| How much of its projection a team really scores (`shared/realisation.ts`) | team charts only: each team's projected weeks by its own rate; ceiling, floor and depth by the league's rate alike, so their placings stay a comparison of rosters; never strength, grades or trade ideas | between 70% and 110%; a team's own record counts like its weeks (weeks compared with today's projection at half weight) against 2 weeks of the league's rate |

### Projections

`shared/projection.ts`. A player's rest-of-season level starts from this
season's average and applies the three projection steps above. The player
panel charts his games, then the projected level over the games he is
expected to play, and lists what each step added or removed. A player whose
projection sits well below his average is a sell-high candidate; well above, a
buy-low one.

Last season's stats download once, in the background, after this season's
(several minutes). Until they arrive, projections work without them.

### Team strength (worked out 1 to 1000, shown out of 5)

`shared/strength.ts`. The number behind it is a team's projected weekly score:
the points it is expected to lock in an average week for the rest of the
season. The app plays out 200 imaginary weeks, day by day, the way a lock-in
week is managed:

1. each NBA team plays its real games: imaginary week w is real week w mod
   the weeks left, on the days that team really plays that week (the
   schedule from the stats source, from this Monday to the end of the
   regular season; up to five games, none in a week it does not play, such
   as the All-Star break). A team missing from the schedule, or every team
   when it cannot be loaded, plays made-up weeks of 2, 3 or 4 games
   (`teamSchedule`; `model.schedule` says which). The page waits up to six
   seconds for the schedule before building the model, and builds it again
   if the schedule arrives later. A player plays each game as
   often as he is expected to (see the availability rows above);
2. each game's score is drawn around his projected level, with his own
   game-to-game spread and the skew of real games: a big night runs further
   above his average than a bad night falls below it ("Upper outliers" in the
   balance table). Checked against real games (Nov 2026, 213 players with 10+
   games), the model's three- and four-game lock-in values match each player's
   own within half a percent at every level; before, a symmetric shape and one
   league-wide spread had stars about 2-3% too high and everyone's upper tail
   about 1% too short;
3. each day, the players with a game go into the open starting slots, best
   first, tightest slots first. The lineup set in Sleeper is ignored: the app
   assumes the best lineup every day;
4. after the games, a slot is locked when its score beats what that slot can
   still expect from the rest of the week, from everyone left on the roster.
   A locked slot and its player are done for the week;
5. at the end of the week an open slot keeps the last game played in it.

Because an open slot can take a different player each day, bench players are
extra chances at a big game, not just injury cover. Rankings (Team strength)
shows
how much the bench adds over the best nine alone.

The average is put on a 1 to 1000 scale between two reference rosters from
the same league: the best free agents (1) and the league's best players on one
roster (1000). The app shows it out of 5 stars, one star for every 120 points
(`STRENGTH_PER_STAR`, `formatStrength` in `src/format.ts`, `StrengthStars`):
five stars is 600, three fifths of the way to the all-star roster, and a
change of 12 reads +0.10. It is a fixed scale, chosen once so that in the
owner's league teams rate about 2.7 to 4.6 and above 5 (five gold stars with
a soft glow) is rare; the best players on one roster would rate 8.3. It was a
hundredth of the score until the model moved to the real NBA schedule, when
every team rose about one star and three passed five (most likely because the
all-star roster's games clash on the same nights, so it lost more of its edge
than real teams did).
Only the display changed: grades, chances and the trade search use the 1 to
1000 score as before. Each player sees the same imaginary weeks on any roster, so
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
are accepted, with any chance of 70% or more counting as 70% (`CHANCE_ENOUGH`:
a fair offer is a toss-up to a manager, so a bigger gain at 60% beats a
smaller one at 85%), in three bands: likely (50% or more), possible (40 to
50%) and long shots (under 40%, in practice a no). The chance's parts are combined on the log-odds scale, so one bad
part (say, the trade clearly hurts their team) pulls it down however fair the
trade looks; the builder shows how many points each part adds or takes away,
and its one-line verdict uses the same chance. On screen the chance carries a
word in seven steps, colored red through yellow to green: Never (under 8%),
Unlikely (under 22%), Probably not (under 40%), Toss-up (under 55%), Maybe
(under 70%), Likely (under 88%) and For sure (`chanceWord`; display only, the
three bands above still sort the ideas). Likely ideas come first; possible ones fill out a short list or
are shown when nothing is likely. For variety, "see the best trades for my
team" always includes at least one plain one-for-one when one has a
realistic chance (40% or better) and is worth it for you, never a package
already shown with a player taken out; it takes the last place if the list
is full (display only: it changes which ideas are shown, not how any is
measured or ranked); long shots appear only when there is
nothing better, at most three, with a plain note saying so. Versions of one offer
(the same team, the same players back and the same main piece sent, with
only the filler changed) count as one idea: only the best version is shown.
When you named a player to trade away, he is the main piece. A player you would
get appears in one idea at most, and one of yours in two at most (a named
player excepted, `limitRepeats`): two versions of a trade for the same star
read as one idea, and the best stays. When you trade away one named player,
at least half the ideas send him alone (one for one or one for two), as long
as enough such offers clear the same bars (worth it to you, not a big loss
for them, nobody dropped on arrival, a realistic chance when the list has
realistic ideas); they take the places of the lowest-ranked packages
(display only).

Injured stars come up often, and for sound reasons: moving an injured player
creates more value than moving a healthy one (Nov 2026, on the owner's
league: a player out a real share of the weeks left was worth a median 36%
more to other teams than he cost his own, against 9% for healthy players),
mostly because a team with an open IR slot carries him for free while he is
out, and his owner, who has his stand-in already, loses only the weeks after
he is back. The search is not tilted toward them beyond that: managers'
small overreaction to injuries changed none of the ideas when tested.

The search runs in layers, like a tree, and goes deeper only when it has to:

1. Swaps and packages. Every one-for-one in a value window (two of yours for
   a named or injured target), packages that fill another team's need, and an
   estimate of every two-team trade of up to two players a side: one-for-two,
   two-for-one and two-for-two with every team. Each estimate pairs the
   players up by what each swap does to both rosters (a short run of 17
   imaginary weeks), so it is cheap enough to cover all of them. The best
   3,000 get a closer look (the whole trade on the same few weeks, both
   sides, since pairing cannot see how two players fit together), and every
   one that holds up there (up to 1,000) is screened properly. Only packages
   that pass the rules there (no received player dropped on arrival) go on.
2. If nothing from layer 1 is likely to be accepted, the 12 most promising
   near-misses (ranked like ideas: your gain times their chance) each grow by
   one player: one of your 5 least valuable players added as a sweetener (you
   refill from waivers), or, for a player you named to trade away, two of
   theirs for him.
3. Still nothing likely: the best of layer 2 grow again (a second sweetener,
   or one of their least valuable players coming back as well).

Every quick read (estimates, closer look, screening) runs a roster through
the same steps as the full measure (`fillRoster`: free upgrades, IR, who
leaves when a player is back, open spots from waivers), only with fewer
weeks and open spots going to the best free agent on his own.

The best of all that, in the order the list uses (likely first by the quick
read, then gain times chance), get a first look: measured in full on 68
weeks, the best 800, plus 6 per idea shown and 12 places for packages. The
best first looks by the same rules (at most two versions of one idea) are
measured on all 200 weeks, 8 per idea shown. Every short run covers whole
rounds of the real weeks left (17 left: estimates on 17 weeks, first looks on
68), since imaginary week w stands for real week w mod the weeks left: a run
that stopped part-way would count a player out now for more than his share. When fewer than 6
of those hold up as realistic (40% or better), the next best first looks are
measured too, up to 24 per idea shown. A dev script,
`npx tsx scripts/audit-trades.ts`, checks the finder against a brute-force
search of every trade of up to two players a side (`--save` and `--load`
keep the slow reference between runs). It runs on the sample league or on a
real one: signed in, save `/api/league/<id>` and `/api/league/<id>/stats` as
JSON and pass them with `--snapshot league.json --stats stats.json --team
"<name>"`. On the real league (Nov 2026) the finder got about 83% of the
brute-force value over four teams (from 66% before the last tuning), in
about 13 seconds a search.

While it runs, a progress bar (`SearchProgress.tsx`) fills from the search's
own reports (`onProgress` in `findTrades`, sent back from the worker a few
times a second), eased between them so it never sits still, with the step it
is on above it; stand-in cards hold the place of the ideas. Display only: the reports never feed back into the search.

The search runs in a web worker (`src/search.ts`, `src/searchWorker.ts`),
which builds the same model from the same league and stats, so the page
stays usable for the few seconds it takes; Top moves on My team run there
too.

A grown package is kept only if it raises the chance of the offer it grew from by
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
then the builder, then your best nine and position needs. Each idea card
names the other team at the top right (avatar, team, manager, record; a
header line on a phone) and lists what you send in red and what you get in
green, joined with "+". Both builder rosters
start closed; "Open in builder" loads an idea and opens both. When one team
has fewer players (an empty bench or IR spot), its list is padded with empty
slots so the two rosters line up row for row.

### Injuries, IR and waiver pickups

`shared/injury.ts` and `fillRoster` in `shared/strength.ts`. The injury
report comes from the stats source (balldontlie's player injuries, on the
ALL-STAR plan). A return date is read as a window, not a day: a few days away
is taken almost as given; further out, the expected day moves a little later
and the window widens. A "re-evaluated" date is the earliest he could be
back; the expected return is later by 40% of the time from the news to the
check-up (at least a week), since far-off check-ups slip more. The news date
is the earliest dated update in the report's note. "Out for the season" keeps him
out. A player marked out with no date is expected to miss as long again as
he has (half a week if just ruled out). A player who has not played this
season but is on the report with a date is projected at last season's level.

The model's imaginary weeks stand for the real weeks left in the regular
season, in turn, so an injured player plays none of the weeks he is out and
his usual share after: his weekly value is the average over the weeks left.

IR slots come from the league settings (Sleeper's `reserve_slots`; Sleeper
does not list IR among the roster positions), and so do the statuses allowed
on IR (`reserve_allow_out`, `_doubtful`, `_sus`, `_dtd`; out only unless the
league turns the others on). `npm run check:sleeper` prints both. Team
management on a trade card lists IR moves against what Sleeper shows now:
moving a player marked out onto a free IR slot, or a player off IR (no longer
out, or making room for one out longer).

A player's panel keeps its Close button at the top right while it scrolls.
His game log puts fantasy points (Fpts) first, after the date and opponent,
colored red to green against his own season average (`fantasyTone` in
`src/format.ts`). Matching his average is a good game, so the scale leans
left: 85% of his average is yellow, his average itself is mostly green, 130%
or more is full green and 40% or less full red. Display only.

A player's panel shows his injury report entry: the predicted return date as
the report gives it, when the app plans on him being back (later for far-off
dates and re-evaluations), and the report's note behind the info button. His
chart shades the games he is expected to miss and starts the projection when
he is back.

Every roster is run as its manager would: a player marked out goes on IR
(most out first, one per IR slot) and takes no active spot; open spots are
filled with the free agent who helps most; too many active players means
dropping the least valuable. When a player on IR is back, the least valuable
active player (a pickup or not) plays only until then, valued on the weeks
from that return on: a player who is out now but back by then (moved off IR
to make room for someone out longer) waits on the bench and is not the one
to go. Nobody goes for a player out for the season. Rosters are filled the same way before and after
a trade, so a trade is credited only with the spots it opens, and a pickup
the team makes either way is not counted as the trade's. For the same reason
a trade that opens a roster spot for a team is made on its roster after
its free upgrades: every swap of its weakest player for a better free agent
that is worth making (up to five), so the open spot gets only the free agent
left after them. (One swap per spot was not enough: a two-for-one then got
credit for the second swap, about 2 points a week in Nov 2026.) A team that gets as many players
as it sends gets none: every team in the league reaching for the same few
free agents at once is no truer than none of them doing it, and it would
make every bench look as good as the best free agent. A team could make those moves anyway, so a two-for-one that
sends away a player worth less than a free agent is not credited with the
free agent who replaces him. The swaps are made once, before the trade, not
again after it, so a trade never gets credit for a swap that only just
becomes worth making. If the swaps would leave the team weaker once players
come back from IR, the team keeps the roster it has. Team strength itself is
the roster as it stands, without upgrades. Trade cards and Top
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

### My team

The roster opens with the team's strength: its rating out of 5 with stars and
its rank, what the team locks in an average week, what its best nine alone
would lock, and what the bench adds by rotating in. Beside them, highlighted,
Expect a week: what the team can expect a week at the share of its projections
it has really scored, the same figure as Week by week's average (see
"Projected points as the league really scores them"); on a phone it sits top
right beside the rating, on wider screens at the right end of the facts. The
Rankings tab's Team strength table shows the same figure as Projected weekly,
with locks a week beside it on wider screens.

The table below is the roster as it is best set for the rest of the season,
not the lineup set in Sleeper (managers shuffle players in on purpose so they
are eligible to lock a big game): the best nine by weekly value in their slots
(`bestNineLineup`, the same nine as "best nine alone"), then the rest of the
active roster by weekly value, then injured reserve. Weekly value is a
player's expected locked score in an average week, missed games and injury
return dates included, so a player out for a long time drops to the bench on
his own. (Full health, which the acceptance chance uses for how much of a
team is out, still picks its nine by what each is worth when fit.) The week's
matchup is no longer shown here (see [Live matchup](#live-matchup)).

### Team charts (My team)

Above the roster, three cards place your team against the league
(`shared/teamProfile.ts`, `src/components/TeamCharts.tsx`); on a phone they
slide sideways. Each says in one line what stands out, and hovering or
tapping part of a chart gives that figure and its rank. Until the figures
are ready (the finished weeks and the schedule load, then the profiles are
worked out after the page has painted) each card shows its empty frame at
full size with placeholder lines for the note, so nothing moves when the
charts fade in; while newer data is measured the last charts stay on screen.

- **Team shape** (radar): from the same lock-in simulation as team strength,
  run for every team: ceiling and floor (a week better than 9 in 10, and
  worse than 9 in 10), top three (your three best players' expected locked
  scores), depth (what the bench adds over the best nine), schedule (the real NBA
  games left in the regular season for your ten main players' teams, a week,
  each game weighted by how many fantasy points that opponent gives up
  against the league average, `allowed` in the stats report from
  `pointsAllowed` in `server/stats/summary.ts`, shrunk toward average by
  three average games; averaged by each player's value, so a star's schedule
  counts more; when the schedule cannot be loaded the model's games a week
  stand in), health (share of the
  value of your ten best players when fit that is on hand over the next four
  weeks, injuries only, so a star out for three weeks counts now) and trend
  (projection against their averages). A range narrower than the axis's
  minimum (health: 25 points, ceiling and floor: 10 points a week) is widened
  to it, so a tiny gap between teams does not fill the whole scale.
- **Scoring mix** (radar): where your ten main players' fantasy points come
  from (scoring, threes, boards, playmaking, defense, bonuses), each counted
  as often as he is expected to play, plus what turnovers and fouls cost. The
  split by source is worked out on the server (`fantasySources` in
  `server/scoring.ts`, saved on each player's stats as `sources`); a source
  the league does not score, such as threes in the owner's league, is left
  out.
- **Week by week** (line): your final score in each finished week
  (`/api/league/:id/history`, from `shared/weekScores.ts`; see "Finished
  weeks' scores" below), in a shaded band with solid dots,
  then your projected score in each real week left (lighter line, open dots,
  after a dotted line), against the league's average and range. The range
  reads the same both sides of the line: for a finished week the real high
  and low score, for a week ahead the likely high and low (the best and worst
  of the teams' scores in each imaginary week standing for it, averaged; the
  spread of the teams' averages alone was far narrower than any real week).
  Over weeks 1 to 4 the real high averaged 421 and the low 287; the likely
  high and low ahead come to about 408 and 289. The note gives your average
  and rank so far, and your projected average from here and its rank, as a
  share of your locks a week (the team strength figure under it). The
  projections play each team's real games, so a week's ups and downs are
  real: how many games your players have that week, and who is back from
  injury.

On the radars 0 is the league's lowest team and 10 its highest, and the
dashed shape is the league average. Display only: nothing here feeds
strength, grades or trade ideas.

### Projected points as the league really scores them

The lock-in simulation plays every team as a manager who rotates the bench
into each open slot every day and locks well. That is what a team can score,
not what most do: over weeks 1 to 4 the owner's league scored about 87% of it
(the owner's team about 97%). So the team charts take off what a team falls
short of a perfectly run week (`shared/realisation.ts`): its average times
one less the share of its projections it really scores, measured from each
finished week's real score against the projection for that week. It is taken
off, not scaled: a team's good and bad weeks swing as widely as the model's
(real weeks 1 to 4 swung by 36 points within a team, the model's by 33), so
scaling would have squeezed the range. The weeks ahead take the team's own
rate (a forecast of its scores; their average is the team's locks a week less
its shortfall, so it ties to the figure on the roster card). The shape's
ceiling and floor take the league's shortfall and depth the league's rate,
the same for everyone: the shape compares rosters, and a team's own rate
would move it past teams with better rosters (a 5% rate is as wide as the
league's whole spread of ceilings). The server saves every team's
projection once a week (`projections-v1-<league>`, with the same model the
page builds); weeks before it began use today's projection at half weight. A
team's rate starts from the league's as if it had 2 weeks of its own and
leans on its own record as weeks pass, kept between 70% and 110%. The notes
under the charts give the rate. Strength, grades and trade ideas keep the
model's numbers: the same rate for every team would change no ranking there.

### Finished weeks' scores

Sleeper's weekly matchup feed cannot be trusted for past weeks in a lock-in
league: it adds up each starter's latest game rather than the game that was
locked, and the figures for a finished week keep changing as rosters change
(check with `npm run check:sleeper -- <league_id> --weeks`). The standings'
points for and against do count locks: they are the sum of each team's final
weekly scores. So the server notes every team's points for and against under
the number of weeks settled (wins + losses + ties, the same for every team)
each time the league loads, in storage (`standings-ledger-v1-<league>`), and a
week's score is the change in points for from the week before
(`shared/weekScores.ts`). A later look at a settled week replaces it when the
change is a stat correction (up to 15 points), never a bigger jump. A week is
caught as long as the app is opened at least once before the next one settles.

Weeks played before the ledger began cannot be split from the season total,
so they are recorded by hand from Sleeper's app in `server/recordedWeeks.ts`
(every team's score and opponent) and checked against the standings: each
team's weeks must add up to its points for, and its opponents' to its points
against; a mismatch is logged. Weeks known neither way are left off the chart.
The season rank on the chart comes straight from points for. The hidden
Matchups view still reads Sleeper's weekly feed.

### Top moves (My team)

`topMoves` in `shared/moves.ts`. The My team tab lists the five moves that
would raise your team's strength most over the rest of the season: the trades
from "see the best trades for my team" (only those with at least a fair chance
of being accepted; long shots are left out) and the best waiver pickups, each
measured the same way, as the change in strength from the full projection. A
pickup drops the player your roster would miss least. Pickups compete on
merit; when none makes the five, the best one takes the last place so the
waiver wire stays in view. A trade opens in the builder on the Trades tab. The
search takes a few seconds, so it runs after the page has painted, with the
same progress bar as the trade search, and is kept until the projections
change (only when the data they read changes, so it runs once).

### Activity

The league's trades, waiver claims and free agent moves from the last three
weeks, filterable by kind. Each team in a move shows its manager, record and
standings place, the players in and out, and the move's team effect: its
strength with the move made against the same roster with it undone, both
built from today's roster and run through `fillRoster` like a trade
(`moveEffect` in `shared/activity.ts`). Measuring from today's roster keeps it
fair whatever happened since; a player who has since left, or come back, is
marked. It is display only and feeds nothing else. The tab measures a slice
at a time, newest first, so it opens at once.

### Lock-in scoring

This is a lock-in league: each starter counts one game per week. After a
player's game, the manager can lock that score in before the player's next
game; if nothing is locked, the last game of the week counts. Fantasy weeks
run Monday to Sunday (`shared/weeks.ts`).

## Keeping data fresh

There is no Refresh button. The server keeps every source up to date on its
own, within each service's rules: every minute it looks over the leagues in
use (the configured one, and any opened in the last day) and refreshes
whatever has passed its time below, whether or not anyone is looking (the
keep-fresh loop in `server/index.ts`). So the app opens on current data, and
nothing it shows changes a moment later. Pages are always answered from saved
data in memory; no page request waits on an outside service. "Games on" means
an NBA game is in progress (from the saved schedule); the header shows it.

| Data | Source | Fetched again after | Why |
| --- | --- | --- | --- |
| League (rosters, matchups, transactions; about 8 requests) | Sleeper | 5 min, 1 min while games are on (`LEAGUE_CACHE_MINUTES`, `LIVE_LEAGUE_MINUTES`) | Sleeper asks to stay under 1,000 requests a minute; this is at most about 8 |
| Player list | Sleeper | 24 hours | Sleeper asks for it at most once a day |
| Draft | Sleeper | 7 days once finished, else as the league | A finished draft never changes |
| A finished week's matchups (one request a week) | Sleeper | 6 hours for last week, 7 days for older weeks | Only Sleeper's stat corrections change them, in the days after a week |
| The rest of the season's NBA schedule, from this Monday, for the strength model and the team charts (about ten requests) | balldontlie | 24 hours | Games are rarely moved |
| A finished week's NBA schedule (one request a week) | balldontlie | 7 days | Every game is final; saved apart from the current week's copy so a game-night copy is never shown as final |
| This week's NBA schedule (one or two requests) | balldontlie | 15 min, 2 min while games are on (`SCHEDULE_CACHE_MINUTES`, `LIVE_SCHEDULE_MINUTES`) | Scores and game states change on game nights |
| Box scores (the last few days again, about 5 to 10 requests) | balldontlie | 30 min, 5 min while games are on (`STATS_CACHE_MINUTES`, `LIVE_STATS_MINUTES`) | balldontlie updates live stats about every 10 minutes |
| Last season's box scores | balldontlie | Never again | It is over |
| Team logos | NBA | 30 days | They do not change |
| Injury report (one or two requests) | balldontlie | 15 min (`INJURY_CACHE_MINUTES`) | Return dates and notes change a few times a day |

At its busiest (games on) that is about 8 Sleeper requests a minute, against
Sleeper's 1,000, and about 5 balldontlie requests a minute on average, against
the ALL-STAR plan's 60. Every balldontlie request still goes through one
queue, at least 1.1 seconds apart (at most about 54 a minute), with requests
someone is waiting on (the schedule) ahead of background downloads. Each sync
re-downloads only the last two days, to pick up stat corrections, and a
routine sync runs behind the numbers already shown (the stats stay "ready").

The stats report (every player's numbers, the biggest answer) is worked out
once per set of inputs and carries a version that changes only when the
numbers do (`StatsReport.version`). The league answer says which version is
current, so the page downloads the report only when it changed, and rebuilds
its projections (and the top moves) only then. The page rebuilds its model
from the league only when something the model reads changes (rosters,
injuries, records, settings, the day: `src/modelInputs.ts`), not on every
refresh of live points.

### Opening the app

- **Saved on the device.** A service worker (`sw/sw.js`, built into
  `dist/sw.js` with the list of this build's files) keeps the app itself on
  the device, and the app keeps the last data it was sent (league, stats,
  schedule, finished weeks, draft) in the browser's storage (`src/saved.ts`).
  So the app opens at once onto that data, even while the server is waking up
  or the phone is offline, with "Updated ... ago" saying how old it is, and
  newer data replaces it as it arrives. Signing out, or switching league,
  clears what is saved. After a deploy, the new version is fetched in the
  background and loads the next time the app is out of sight.
- **Asked for at once.** The sign-in, the settings and the league are asked
  for together, not one after another.
- **Small answers.** The server compresses its answers (brotli or gzip; the
  stats report shrinks to about a sixth), an unchanged answer comes back as
  a short "not modified", and built files are kept by the browser for good
  (their names change with their contents).
- **A trade search waits for current data.** Right after opening, a search
  waits (a few seconds at most, shown as "Getting the latest data") until this
  visit's league, stats and schedule are in, so its ideas are not overtaken a
  moment later.
- **The page checks in** with the server every minute while it is visible, and
  when it comes back into view; the server answers from memory.

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

The app runs on one Eco dyno ($5 a month for the account's pool of 1,000
dyno hours; it sleeps after 30 minutes without visits and wakes on the next
one) with a Heroku Postgres Essential-0 database ($5 a month). Heroku builds
with `npm run build` (the page, and the server bundled into
`dist-server/index.js`) and starts the `Procfile` (`node
dist-server/index.js`, which starts faster than compiling on the fly). Run
these from the project folder, signed in with `heroku login`:

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

### Waking up

An Eco dyno sleeps after 30 minutes without a visit, and the next visit waits
several seconds while it wakes. The app opens at once anyway (it is saved on
the device, above), but while the dyno sleeps the data cannot be kept fresh.
Two ways to keep it awake:

- **Free, within the Eco hours:** `heroku config:set
  KEEP_AWAKE_URL=https://your-app.herokuapp.com`. The server then visits
  itself every 20 minutes. Around the clock that uses about 744 of the
  account's 1,000 Eco hours a month; if other Eco apps share the pool, limit
  it, for example `heroku config:set KEEP_AWAKE_HOURS=7-24
  KEEP_AWAKE_TZ=America/Denver` (awake 7 a.m. to midnight, about 530 hours).
  When the pool runs out, Eco dynos sleep until the next month, so keep an
  eye on `heroku ps -a your-app` (it shows the hours left).
- **Never sleeps:** a Basic dyno (`heroku ps:type web=basic`, about $7 a
  month instead of the Eco plan).

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
| `npm run check:sleeper -- <league_id> --weeks` | Compares every finished week's matchup scores with the standings' season totals (the official ones) and saves what Sleeper sent to `.cache/sleeper-weeks.json` |
| `npm run check:stats -- <league_id> --schedule` | Prints this week's NBA schedule from the stats source |
| `npm run check:stats -- <league_id> --injuries` | Prints the injury report and how the app reads each return date (add `--player "Name"` for one player's full note) |
| `npm run db:import` | Copies `.cache/` into the database at `DATABASE_URL` |
| `npm run check:logos` | Downloads every team logo and writes a preview page |
| `npm run build` | Builds the React app (with its service worker) into `dist/` and the server into `dist-server/` |
| `npm run serve` | Builds both and serves everything from :8787, as on Heroku |
| `npm start` | Runs the built server, serving the built app (what Heroku runs after building) |

## Live matchup

Matchups is hidden from the navigation for now (`HIDDEN_VIEWS` in
`src/App.tsx`; the code and its server routes stay): Sleeper's own matchup
screen knows which scores are locked and ours has to work it out, so this
view is parked until it can match it.

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

The board only moves sideways inside its frame; the page itself scrolls down
through the rounds. On a wide screen (1100px and up) the columns share the
width, so all twelve teams fit with no sideways movement and the team names
stay at the top while you scroll. On a phone the board runs edge to edge with
compact cards (pick, first name and team logo, last name, position band), so every
round fits down the page and a swipe moves between teams, stopping on a
column.

Each pick carries a letter grade: F, D, C, B, A, then S in gold, with a minus
or plus for the lower and upper third of D to A. A player's weekly value now
(what he locks in an average week at his projected level, allowing for missed
games) is compared with the median value of the players picked around him,
the nearest round of picks, not counting him (`shared/draft.ts`). So a first
pick is held to what the top of the draft turned into and a last pick to what
the end of it did. The gap is measured in the draft's typical gap (its median
gap, scaled to a standard deviation): C is within 0.4 of the players around
him, each letter after that 0.8 more (`GRADE_STEP`), and S and F are
open-ended. It is a display label only and feeds nothing else.

A card shows one mark: the grade, or a medical cross when the player is out
for a long stretch: about a month or more of the weeks left
(`LONG_INJURY_WEEKS`, 4), or the rest of the season. Hover over it for his
predicted return. A big injury is luck, not the manager's drafting, so that
player is not graded and is not part of anyone else's comparison. A player out
for a shorter while is graded on his value in the weeks he is back
(`gradedValue`), so a short injury never lowers a grade either.

## Look

Positions always appear as colored chips (PG pink, SG orange, G coral, SF
green, PF blue, F teal, C purple, UTIL periwinkle), with the colors set once at
the top of `src/styles.css`. On a computer a slim bar stays across the top: the app's name and week, the
views as tabs (My team and Trades first, with icons, set apart from the
rest), the update time, and a menu behind your team's avatar for
light or dark mode, changing your team, switching league and signing out.
On a phone the app works like an iPhone app: a tab bar along the bottom (My
team, Rankings, Trades set apart in the middle, Draft, and More for the rest
and the settings), bottom sheets for More and player details, and the iPhone's
safe areas respected. Added to the home screen it opens full screen as
"Fantasy Tool". Secondary table columns are hidden,
wide tables keep player names in view while they scroll, notes fold away under
"About these numbers", and the trade rosters start folded so the trade finder
is close at hand.

Next to each player's NBA team abbreviation is the team's logo. Logos come
from the NBA's own image server as SVG files, so every team's logo is equally
sharp. The NBA's files leave very different amounts of empty space around the
drawing (from about 60% to 94% of the frame filled) and range from wide
wordmarks to tall crests, so the backend reframes each one when it downloads
it (`server/logoShape.ts`): it measures what is drawn and puts it in a square
sized so every logo covers about the same area (a round logo fills 86% of its
box, `AREA_FILL`) and none runs past 90% of the box's width or height
(`EDGE_FILL`), so it never touches what sits beside it. A file it cannot
measure safely is served as it came. Each team has a version
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
   season; each team's real schedule in the model. To do: playoff weeks
   (on hold until the owner decides how they should count).
5. **Deeper analysis.** Past seasons as a guide to who is likely to rise or
   fade, and other ways to surface moves that are easy to miss. No chatbot:
   everything is computed from data.

## Notes on Sleeper's API

- It is read-only and needs no login. This tool cannot change your league.
- Sleeper's docs describe NFL only. This tool uses the same endpoints with `nba` as the sport.
- It is free for non-commercial use.
