# FantasyTool: notes for Claude

Analysis tool for one Sleeper NBA fantasy league. React + TypeScript frontend
(`src/`), small Express backend (`server/`), shared types (`shared/`).

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
- Player stats come through the `StatsProvider` interface
  (`server/stats/provider.ts`). Nothing outside `server/stats/` may know
  which vendor is in use. API keys live in `.env` only, never in the repo.
- Scoring rules live in `server/scoring.ts` only.
- Sandboxed sessions usually cannot reach api.sleeper.app or api.balldontlie.io. Develop and test
  against `server/mock.ts` (`npm run dev:mock`), and ask the owner to run
  `npm run check:sleeper` or `npm run check:stats` when live behavior needs
  confirming.
- UI copy: sentence case, plain language. Visual tokens live at the top of
  `src/styles.css`.

## Before opening a pull request

```bash
npm run typecheck && npm test && npm run build
```
