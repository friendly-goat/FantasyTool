# FantasyTool: notes for Claude

Analysis tool for one Sleeper NBA fantasy league. React + TypeScript frontend
(`src/`), small Express backend (`server/`), shared types (`shared/`).

## The league

- Lineup: PG, SG, G (PG/SG), SF, PF, F (SF/PF), C, UTIL, UTIL; 5 bench, 1 IR.
- Lock-in mode: each starting slot counts ONE game per fantasy week, and a
  player must be in the lineup when his game starts to be lock-eligible. The manager
  may lock a score after a game and before that player's next game; if
  nothing is locked, the last game of the week counts. Weeks run Monday to
  Sunday (`server/weeks.ts`). Value players accordingly: a week is a few
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
  strength or trade grades.

## Rules for this repo

- The browser never calls Sleeper or any stats API directly. All outside calls
  go through `server/`, behind the cache in `server/cache.ts`.
- Anything kept between restarts goes through `server/storage.ts` (Postgres
  when `DATABASE_URL` is set, as on Heroku whose disk is wiped on restart;
  files in `.cache/` otherwise; memory in mock mode and tests). Never write
  files directly for saved data.
- Respect Sleeper's limits: full player list at most once a day, and keep a
  league refresh to a handful of requests.
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
  see on averages, each capped, combined on the log-odds scale. Ideas are
  ranked by your weekly gain times that chance.
- The owner wants analysis that finds what he would not notice himself, done
  with data in code. No chatbot or LLM inside the app.
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
- Sleeper's matchup data never says which scores are locked; an unlocked
  starter shows his latest game. Lock state, lock advice and win chances are
  worked out in `shared/matchup.ts` from box scores and the NBA schedule
  (`StatsProvider.fetchSchedule`). They are display only: never feed them into
  strength, grades or trade ideas.
- The Draft tab's rising and falling marks (`shared/draft.ts`) are a display
  label only: rank by weekly value now against pick order, one round either
  way. Never feed them into strength, grades or trade ideas.
- An NBA team is shown with `TeamTag` (logo and abbreviation). Logos come
  through `/api/logos/:team/:variant` (`server/logos.ts`, cached); the NBA
  team table is `shared/nbaTeams.ts`. Never commit logo files to the repo.
- Positions are always colored chips (`PositionChip`, `PositionChips`), never
  plain text like "PF/C". Colors are the `--pos-*` tokens in `src/styles.css`,
  matching Sleeper's: PG pink, SG orange, SF green, PF blue, C purple.
- Check every UI change at phone width (390px) as well as desktop. Use the
  `hide-narrow` class for columns that can go on a phone.
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

Then push to `main` and tell the owner to run `git pull` to get the change.
