// Manual player matches, for the rare case where name matching fails
// (a nickname in one source, a legal name in the other).
//
// Key: Sleeper player ID. Value: balldontlie player ID.
// `npm run check:stats` lists rostered players that found no match.
export const PLAYER_ID_OVERRIDES: Record<string, string> = {};
