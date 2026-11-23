# FantasyTool: notes for Claude

Analysis tool for one Sleeper NBA fantasy league. React + TypeScript frontend
(`src/`), small Express backend (`server/`), shared types (`shared/`).

## The league

- Lineup: PG, SG, G (PG/SG), SF, PF, F (SF/PF), C, UTIL, UTIL; 5 bench, 1 IR.
- Lock-in mode: each starting slot counts ONE game per fantasy week, and a
  player must be in the lineup when his game starts to be lock-eligible. The manager
  may lock a score after a game and before that player's next game; if
  nothing is locked, the last game of the week counts. Weeks run Monday to
  Sunday (`shared/weeks.ts`). Value players accordingly: a week is a few
  chances at one good game, so games per week and game-to-game spread matter,
  not weekly totals.
- 12 teams, points scoring with threshold bonuses (see the league's
  `scoringSettings`); technical and flagrant fouls are scored by Sleeper but
  absent from box scores.
- Sleeper's app shows season averages inflated by scoring season totals
  (`sleeperDisplayedAverage` in `server/scoring.ts`). Analysis always uses the
  true per-game numbers; the Sleeper figure is shown only for comparison.
- Playoffs (owner's settings, Nov 2026): 6 teams, weeks 22 to 24, one week per
  round (round 1 week 22, round 2 week 23, final week 24), default seeding,
  toilet-bowl lower bracket. Regular season ends week 21; week 25 is not used
  for playoffs. Code reads `playoffs` (start week, team count) from the
  league's Sleeper settings (`playoffSettings` in `server/snapshot.ts`); never
  hard-code these numbers. Ask the owner before weighting playoff weeks in
  strength or trade grades. The owner has put playoff features (title odds,
  playoff weeks) on hold (Nov 2026): do not build them unless asked.

## Rules for this repo

- The browser never calls Sleeper or any stats API directly. All outside calls
  go through `server/`, behind the cache in `server/cache.ts`.
- Anything kept between restarts goes through `server/storage.ts` (Postgres
  when `DATABASE_URL` is set, as on Heroku whose disk is wiped on restart;
  files in `.cache/` otherwise; memory in mock mode and tests). Never write
  files directly for saved data.
- The hosted app (Heroku) needs a sign-in (`server/auth.ts`): admin and
  viewer passwords, a signed cookie, and admin-only routes for anything that
  changes saved data (`requireRole(auth, "admin")`). Viewers never see controls
  that change data. Secrets live in Heroku config vars or `.env`, never in the
  repo.
- Respect every source's limits (README "Keeping data fresh"): Sleeper under
  1,000 requests a minute and the player list at most once a day; balldontlie
  60 a minute on ALL-STAR, so every request goes through the shared queue in
  `server/stats/balldontlie.ts`. There is no Refresh button: the server keeps
  data fresh by itself, with a keep-fresh loop every minute over the leagues
  in use (shorter times while games are on, `gamesLive`), and outside data is
  fetched with `cache.get(..., { background: true })` so no page request
  waits on Sleeper or balldontlie once something is saved (Heroku cuts
  requests off at 30 seconds). Production runs the bundled server
  (`dist-server/index.js`, built by `npm run build`).
- The app opens on saved data: a service worker (`sw/sw.js`, built by the
  plugin in `vite.config.ts`) keeps the app on the device, and the last
  answers are kept in IndexedDB (`src/saved.ts`, cleared on sign-out). New
  data a component fetches is shown saved-first, then replaced. The page's
  model is built from `modelSnapshot`, replaced only when `modelFingerprint`
  (`src/modelInputs.ts`) changes; add any snapshot field the model starts
  reading to the fingerprint. The stats report carries a `version` (changes
  only when its numbers do); the league answer's `statsVersion` tells the
  page when to fetch it. A trade search waits for this visit's data
  (`settled` in `src/App.tsx`). The top moves and "see the best trades for my
  team" are one search (`findTrades` with no options), kept per model and team
  in the worker and shared in flight (`src/search.ts`).
- Sleeper's NBA responses are not formally documented. Treat every raw field as
  optional (`server/sleeper.ts`) and convert to the strict shapes in
  `shared/types.ts` inside `server/snapshot.ts`.
- Fantasy numbers (values, projections, trade impact) are computed in code with
  tests. An LLM may explain or propose, never do the arithmetic.
- A player's value for any lineup, waiver or trade question is his lock-in
  value at his projected level (`shared/lockin.ts`, `shared/projection.ts`),
  never his plain average. Build new analysis as pure tested functions in
  `shared/`.
- Balance is a hard requirement from the owner: no signal may overpower the
  rest. Every new signal gets its own named step, a fixed limit on its effect,
  a line in the README table "How the analysis is kept in balance", and its
  size shown wherever the result is explained. Never hard-code a rule about a
  specific player, team or position; measure it by changing a roster and
  re-running the projection (see `shared/insight.ts`).
- A missed game is not an injury. Rest days are a rate; only a run of 4+
  missed team games is a long absence (`availabilityOutlook`).
- Injuries come from the stats source's injury report (`fetchInjuries`),
  read in `shared/injury.ts` as a return window (buffer, re-evaluation,
  spread). The model's imaginary weeks stand for the real weeks left (week
  w is real week w mod the weeks left), so a return date counts week by
  week, and each team plays its real games that week (`buildModel`'s
  schedule, `/schedule-ahead` from this Monday; made-up weeks only without
  it). The page, the search worker and the server's saved projections must
  all build the model with the same schedule. Rosters are always run through `fillRoster` (IR, waiver pickups,
  who leaves when a player is back, judged on the weeks from his return, `expectedOnceBack`) before and after a trade alike; never
  credit a trade with a pickup the team would make anyway.
- Team strength is worked out 1 to 1000 but always shown out of 5 stars, one
  star per `STRENGTH_PER_STAR` (120) points (`strengthRating`,
  `formatStrength`, `formatStrengthChange`, `StrengthStars`; never show the
  raw score). A fixed scale, never rescaled to the league: if a model change
  makes 5+ common again, ask the owner before changing the constant. Grades,
  chances and searches use the raw score.
- Game scores in the model are skewed (`skewedDraw`, `UPPER_TAIL_SHARE`, half
  lognormal) and a player's spread is fitted to his real two-game lock-in
  value, leaning on the typical spread for his level (`typicalSpreads`), not
  one league-wide figure. Check any change to either against players' real
  three- and four-game lock-in values (`lockInByGames`).
- Team strength (1 to 1000) and trade grades come from the projected weekly
  score in `shared/strength.ts` and `shared/trade.ts`. It is a day-by-day
  lock-in simulation (`simulateWeek`): open slots rotate players daily, so the
  bench counts. Never judge a team by the lineup currently set in Sleeper;
  managers bench good players on purpose to rotate others in. The owner judges
  everything over the rest of the season, not the coming week. Keep the model
  deterministic (same imaginary weeks for a player on any roster).
- Trades are shown three ways (`shared/trade.ts`): player value (value above
  a typical free agent, no team context), team effect (strength change), and
  fit (the gap). `tradeStory` explains a trade from those; its labels must never
  feed back into grades, chances or the ranking of ideas. The acceptance
  chance (`chanceParts`) does use the other team's team effect and what they
  see on averages, each capped, combined on the log-odds scale. A manager sees
  his own players at their full average (`sumOwn`; only players he receives
  get the injury discount), and when he would send a long-injured player due
  back, his team effect is judged from that return on (`TradeSide.held`). Ideas are
  ranked by your weekly gain times that chance. `findTrades` searches in
  layers: swaps plus an estimate of every two-team trade of up to two
  players a side (screened, then the best measured in full), then
  near-misses grown into packages (up to 3), deeper only when nothing is
  likely. Check search changes with `scripts/audit-trades.ts` (brute force on
  the sample league). The search runs in a web worker (`src/search.ts`);
  a trade is made on the roster after its free upgrades (every worthwhile
  one for a team the trade opens a spot for, none otherwise, `freeUpgrades`;
  decided once before the trade, never below the team as it stands); findTrades leaves long injuries (`isLongInjury`, 10+ days, not a few
  games) out of trade pieces by default (named players exempt); the finder's
  "Injured players" switch is off by default and sets `includeInjured` only
  when on (locked on for "trade for an injured player"), so the default stays
  the shared best search. The top moves rest on that search plus the
  `getInjured` one (one place for the best injured trade, one for a pickup
  when none earns it); every search's answer is kept per team and options
  (`src/searchAnswer.ts`); never suggest an offer that is a big
  loss (F) for the other team, or one where either side drops a player it
  receives (`droppedOnArrival`). IR slots come from Sleeper's
  `settings.reserve_slots`, not `roster_positions`.
- The owner wants analysis that finds what he would not notice himself, done
  with data in code. No chatbot or LLM inside the app.
- My team's roster table shows the best lineup for the rest of the season
  (`bestNineLineup`, picked by weekly value, the nine "best nine alone"
  counts), never the lineup set in Sleeper; full health (used by the
  acceptance chance) still picks its nine by value when fit.
- A fantasy team's name in the trade area renders with `TeamName`
  (`OpenTeamContext`), opening `TeamPanel` (charts and roster, no team
  switching).
- The user's own team is chosen once per league (`myRosterId` in `src/App.tsx`).
  Features that give advice take that team's point of view.
- Player stats come through the `StatsProvider` interface
  (`server/stats/provider.ts`). Nothing outside `server/stats/` may know
  which vendor is in use. API keys live in `.env` only, never in the repo.
- Scoring rules live in `server/scoring.ts` only.
- Sandboxed sessions usually cannot reach api.sleeper.app or api.balldontlie.io. Develop and test
  against `server/mock.ts` (`npm run dev:mock`), and ask the owner to run
  `npm run check:sleeper` or `npm run check:stats` when live behavior needs
  confirming.
- Wherever the UI names a player, render it with `PlayerName`
  (`src/components/PlayerName.tsx`) so the name opens the player's details.
  In a list, use `PlayerCell` (name, injury tag, position chips, team). When a
  whole card should open the player (draft board), use `PlayerButton` instead.
- The Matchups view is hidden from the navigation (`HIDDEN_VIEWS` in
  `src/App.tsx`) but kept in the project; the owner may bring it back.
- Sleeper's matchup data never says which scores are locked; an unlocked
  starter shows his latest game. Lock state, lock advice and win chances are
  worked out in `shared/matchup.ts` from box scores and the NBA schedule
  (`StatsProvider.fetchSchedule`), plus lock marks the managers save
  (`applyLockMark`; a mark holds only while the score it was made on stands).
  They are display only: never feed them into strength, grades or trade ideas.
- Every week from 1 to the current one can be viewed: routes take `?week=`
  (`pickWeek` in `server/index.ts`); finished weeks' matchups and schedule
  are saved under their own keys with long lifetimes, and lock marks are
  stored per week.
- The player card's depth chart (`shared/depthChart.ts`, `DepthChart.tsx`) is
  worked out from recent minutes (no source publishes one), minutes colored
  only when well off his season's (`minutesTone`); how long a player is out
  is worded by `outText`/`newsOutText` (`shared/injury.ts`) everywhere. Display
  only, never fed into strength, grades or trade ideas.
- The Activity tab's team effect (`moveEffect` in `shared/activity.ts`)
  measures each move on today's roster, with and without it; display only,
  never fed into strength, grades or trade ideas.
- The team charts on My team and above each team's roster on Teams
  (`shared/teamProfile.ts`, `TeamCharts.tsx`, `own` false for other teams)
  place a team around the league's average (the middle ring, `place`: two
  rings per standard deviation across the league, never min to max), with
  ceiling and floor leaning on the team's real finished weeks (the same
  weight as a team's own rate, `PRIOR_WEEKS` 8, capped at `MAX_REAL_SHARE`;
  the model's part at the league's rate, so real weeks count once) and the
  mix in points a week; display
  only, never fed into strength, grades or trade ideas. Their Schedule axis
  uses the real games left and opponents' `allowed` ratios; Week by week shows
  finished weeks' final scores (`/history`) apart from projected weeks.
  Finished weeks' scores never come from Sleeper's weekly matchup feed (it
  leaves out locks and drifts after the week): they are the change in the
  standings' points for (`shared/weekScores.ts`, ledger in storage), or weeks
  recorded from Sleeper's app (`server/recordedWeeks.ts`, checked against
  points for and against). Projected weeks on the charts take off each
  team's shortfall from a perfectly run week (average times one less its
  rate of real scores to projections; taken off, not scaled, so weekly swings
  keep their size), the shape's points the league's shortfall only, and the
  weeks-ahead range is the likely high and low score, not the spread of team
  averages (`shared/realisation.ts`, projections saved weekly by
  the server); display only, never strength (the 1-1000 scale is relative,
  so a league-wide rate changes nothing there). Cards
  keep their full size while loading (no layout shift).
- The Draft tab's letter grades (`shared/draft.ts`, F to S with +/- on D to A,
  S in the stars' gold) are a display label only: weekly value now against the
  median of the nearest round of picks, in the draft's typical gap. A card shows
  one mark, the grade or the injury cross. Only a long injury (`longInjury`,
  about a month or more) shows the cross, gets no grade and is left out of
  others' comparisons; a shorter one is graded on his value once back. Never feed them into strength, trade grades
  or trade ideas.
- An NBA team is shown with `TeamTag` (logo and abbreviation). Logos come
  through `/api/logos/:team/:variant` (`server/logos.ts`, cached), reframed on
  download to the same visual size (`server/logoShape.ts`; bump the cache key
  and `LOGO_VERSION` in `TeamTag.tsx` if that changes); the NBA team table is
  `shared/nbaTeams.ts`. Never commit logo files to the repo.
- Positions are always colored chips (`PositionChip`, `PositionChips`), never
  plain text like "PF/C". Colors are the `--pos-*` tokens in `src/styles.css`,
  matching Sleeper's: PG pink, SG orange, SF green, PF blue, C purple.
- Check every UI change at phone width (390px and 440px, the owner's iPhone
  Pro Max) as well as desktop. Use the `hide-narrow` class for columns that
  can go on a phone; a table meant to fit a phone gets `min-width: 0` in the
  720px query, others scroll inside `.table-scroll`. On a phone (720px and
  narrower) navigation is the bottom tab bar in `MobileNav.tsx` (`PHONE_TABS`
  in `src/App.tsx`, the rest and the settings in its More sheet); header
  settings (theme, change team, switch league, sign out) are one list,
  `settingsItems` in `src/App.tsx`, shown in the desktop app bar's menu behind
  the team avatar (`AccountMenu.tsx`) and in the phone's More sheet. On wider
  screens navigation is the sticky app bar (`.app-bar`, height
  `--app-bar-height`; anything sticky below it uses that offset). Hover
  effects that would linger on touch go inside `@media (hover: hover)`. Dialogs open as bottom sheets on phones.
  Respect `env(safe-area-inset-*)` for anything fixed to an edge.
- Fantasy points display with two decimals (`formatPoints`), box-score
  averages with one (`formatAverage`). Keep full precision until display.
- UI copy: sentence case, plain language. Visual tokens live at the top of
  `src/styles.css`.

## Workflow

The owner works alone and wants changes committed straight to `main`: no
feature branches, no pull requests. Before every push:

```bash
npm run typecheck && npm test && npm run build
```

Then push to `main` and tell the owner to run `git pull` to get the change,
and `git push heroku main` to deploy it to the hosted app
(https://fantasytool-alex-e9d67f6a7a25.herokuapp.com/, Heroku app
`fantasytool-alex`, Eco dyno, Postgres Essential-0). Deploy instructions
are in the README ("Deploying to Heroku").
