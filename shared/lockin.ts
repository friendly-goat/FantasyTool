// What a player is worth in a lock-in league.
//
// Each starter counts one game per week. After a game the manager either
// locks that score or waits for the next game; the last game of the week
// counts if nothing was locked. The best rule is: lock a game only if it
// beats what the remaining games are expected to give.
//
// lockInValue is the score that rule yields on average, using the player's
// own game scores this season as the picture of what a game can be.
//   one game left:   the average game
//   two games left:  lock the first if it beats the average, else take the second
//   and so on.
//
// It treats games as independent and equally likely to resemble any past
// game, so it is rough for players with only a few games.

/** NBA teams play three or four games in most weeks. */
export const TYPICAL_GAMES_PER_WEEK = 3;

export function lockInValue(scores: number[], games: number = TYPICAL_GAMES_PER_WEEK): number {
  if (scores.length === 0 || games < 1) return 0;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  let value = mean;
  for (let remaining = 2; remaining <= games; remaining++) {
    const waitingIsWorth = value;
    value = scores.reduce((sum, score) => sum + Math.max(score, waitingIsWorth), 0) / scores.length;
  }
  return value;
}
