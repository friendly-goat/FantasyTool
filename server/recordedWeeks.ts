// Finished weeks' final scores recorded by hand from Sleeper's app, for weeks the
// standings ledger cannot split (it began after they were played; see
// shared/weekScores.ts). Keyed by league ID. Each entry is checked against the
// standings' points for and against when the history is served, and a mismatch
// is logged.
import type { RecordedWeek } from "../shared/weekScores.ts";

export const RECORDED_WEEKS: Record<string, RecordedWeek[]> = {
  // The owner's league, weeks 1 to 4, from Sleeper's app (Nov 19, 2026). Every team's four
  // weeks add up to its points for, and its opponents' to its points against, in the standings
  // the API reported that day. Roster IDs: 1 Mazulla Balls with PP, 2 St. Curry, 3 Langley
  // Bazooka Sharks, 4 Evan Mobley, 5 23 and Me, 6 Dwayne Wade's Former Son, 7 Friendly Goat,
  // 8 Fly God, 9 Shanghai miso, 10 Team BigandGreedy2, 11 Munchkins, 12 Team HorseLock.
  "1416212537531211776": [
    {
      week: 1,
      points: { 7: 357.4, 2: 312.0, 1: 394.3, 3: 380.4, 4: 400.3, 12: 344.3, 5: 359.7, 10: 355.8, 6: 347.1, 11: 285.6, 8: 288.2, 9: 343.1 },
      opponent: { 7: 2, 2: 7, 1: 3, 3: 1, 4: 12, 12: 4, 5: 10, 10: 5, 6: 11, 11: 6, 8: 9, 9: 8 },
    },
    {
      week: 2,
      points: { 7: 380.6, 11: 403.2, 1: 379.5, 9: 318.5, 2: 326.4, 10: 309.3, 3: 333.2, 6: 365.7, 4: 350.2, 5: 373.5, 8: 397.9, 12: 279.6 },
      opponent: { 7: 11, 11: 7, 1: 9, 9: 1, 2: 10, 10: 2, 3: 6, 6: 3, 4: 5, 5: 4, 8: 12, 12: 8 },
    },
    {
      week: 3,
      points: { 7: 354.8, 6: 304.4, 1: 394.9, 12: 314.8, 2: 327.9, 4: 432.6, 3: 358.8, 9: 346.3, 5: 384.5, 8: 311.1, 10: 341.3, 11: 366.2 },
      opponent: { 7: 6, 6: 7, 1: 12, 12: 1, 2: 4, 4: 2, 3: 9, 9: 3, 5: 8, 8: 5, 10: 11, 11: 10 },
    },
    {
      week: 4,
      points: { 7: 447.9, 10: 325.9, 1: 329.9, 5: 404.3, 2: 337.9, 8: 322.9, 3: 277.5, 12: 372.9, 4: 322.3, 11: 375.1, 6: 299.6, 9: 332.5 },
      opponent: { 7: 10, 10: 7, 1: 5, 5: 1, 2: 8, 8: 2, 3: 12, 12: 3, 4: 11, 11: 4, 6: 9, 9: 6 },
    },
  ],
};
