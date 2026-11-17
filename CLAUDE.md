# FantasyTool: notes for Claude

Analysis tool for one Sleeper NBA fantasy league. React + TypeScript frontend
(`src/`), small Express backend (`server/`), shared types (`shared/`).

## The league

- Lock-in mode: each starter counts ONE game per fantasy week. The manager
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

## Rules for this repo

- The browser never calls Sleeper or any stats API directly. All outside calls
  go through `server/`, behind the cache in `server/cache.ts`.
- Respect Sleeper's limits: full player list at most once a day, and keep a
  league refresh to a handful of requests.
- Sleeper's NBA responses are not formally documented. Treat every raw field as
  optional (`server/sleeper.ts`) and convert to the strict shapes in
  `shared/types.ts` inside `server/snapshot.ts`.
- Fantasy numbers (values, projections, trade impact) are computed in code with
  tests. An LLM may explain or propose, never do the arithmetic.
- A player's value for any lineup, waiver or trade question is his
  `lockInValue` (`shared/lockin.ts`), never his plain average. Team strength
  is the best legal lineup's combined value (`bestLineup` in
  `shared/analysis.ts`). Build new analysis on these, as pure tested functions
  in `shared/`.
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
- Fantasy points display with two decimals (`formatPoints`), box-score
  averages with one (`formatAverage`). Keep full precision until display.
- UI copy: sentence case, plain language. Visual tokens live at the top of
  `src/styles.css`.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run build
```
