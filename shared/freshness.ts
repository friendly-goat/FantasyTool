// How fresh the live data needs to be right now, from the NBA schedule. The
// moments that matter for a lineup are while games are being played (scores
// move, a score to lock appears the moment a game ends) and the run-up to a
// tip-off (late scratches, setting the lineup before it locks). The server
// refreshes faster then, and the Lineup plan view asks it more often.

import { gamesLive } from "./matchup.ts";
import type { NbaGame } from "./types.ts";

export type GamePhase = "live" | "pregame" | "quiet";

/** A tip-off this close counts as the run-up to games. */
export const PREGAME_MS = 90 * 60_000;
/** A game that ended this recently still matters: its final box score and Sleeper's score settle. */
export const JUST_FINAL_MS = 30 * 60_000;
/** How long after tip-off a game is assumed to run when the schedule says no more. */
const GAME_RUNS_MS = 3.5 * 60 * 60_000;

const tipOf = (game: NbaGame) => (game.startTime ? Date.parse(game.startTime) : null);

/** Games being played, or games about to tip, or neither. */
export function gamePhase(games: NbaGame[], now: number): GamePhase {
  if (gamesLive(games, now)) return "live";
  const soon = games.some((game) => {
    const tip = tipOf(game);
    return game.state === "scheduled" && tip !== null && tip > now && tip - now <= PREGAME_MS;
  });
  return soon ? "pregame" : "quiet";
}

/**
 * The days whose box scores are moving now: games being played (or past
 * tip-off with no word yet) and games that ended within the last half hour.
 * The server refreshes these days' box scores on their own, in a request or
 * two, instead of the whole recent stretch.
 */
export function liveDates(games: NbaGame[], now: number): string[] {
  const dates = new Set<string>();
  for (const game of games) {
    const tip = tipOf(game);
    if (game.state === "in_progress") dates.add(game.date);
    else if (tip !== null && tip <= now && now - tip <= GAME_RUNS_MS + JUST_FINAL_MS) dates.add(game.date);
  }
  return [...dates].sort();
}

/** How often the Lineup plan view asks the server for new data, by phase. */
export const PLAN_POLL_MS: Record<GamePhase, number> = { live: 20_000, pregame: 60_000, quiet: 5 * 60_000 };
