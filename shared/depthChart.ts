// An NBA team's depth chart, worked out from who actually plays: neither
// Sleeper nor the stats source publishes one. Players are taken in order of
// their recent minutes (the last few games he played, else his season), and
// each goes to the position he is listed at that has the fewest players so
// far, so the five who play most usually make up the starters and a player
// listed at two positions fills the thinner one. Up to three a position.
// Display only: never fed into strength, grades or trade ideas.

import type { PlayerStats } from "./types.ts";

export const DEPTH_POSITIONS = ["PG", "SG", "SF", "PF", "C"] as const;
export type DepthPosition = (typeof DEPTH_POSITIONS)[number];

/** Players shown a position: a starter and two behind him. */
export const DEPTH = 3;

export interface DepthRow {
  position: DepthPosition;
  players: PlayerStats[];
}

/** The minutes a player is placed by: his recent games when there are some, else his season. */
export function depthMinutes(player: PlayerStats): number {
  return player.recentMinutes ?? player.minutes;
}

/**
 * The depth chart of `team` from every player in the stats report: those on it now (by
 * Sleeper's team) who have played this season or are on the injury report.
 */
export function depthChart(players: PlayerStats[], team: string): DepthRow[] {
  const rows = new Map<DepthPosition, PlayerStats[]>(DEPTH_POSITIONS.map((position) => [position, []]));
  const roster = players
    .filter((player) => player.team === team && (player.games > 0 || player.injury))
    .sort((a, b) => depthMinutes(b) - depthMinutes(a) || b.minutes - a.minutes || a.name.localeCompare(b.name));
  for (const player of roster) {
    const listed = player.positions.filter((position): position is DepthPosition =>
      (DEPTH_POSITIONS as readonly string[]).includes(position),
    );
    const open = listed.filter((position) => rows.get(position)!.length < DEPTH);
    if (open.length === 0) continue;
    // The thinnest of his positions; on a tie, the one listed first.
    const position = open.reduce((best, candidate) => (rows.get(candidate)!.length < rows.get(best)!.length ? candidate : best));
    rows.get(position)!.push(player);
  }
  return DEPTH_POSITIONS.map((position) => ({ position, players: rows.get(position)! }));
}

/** Minutes a game either way that are never colored: a regular's game-to-game drift. */
export const MINUTES_STEADY = 2.5;
/** Nor is a change smaller than this share of his season's minutes. */
export const MINUTES_STEADY_SHARE = 0.1;
/** Minutes past the steady band at which the color is full. */
export const MINUTES_FULL = 6;

/**
 * Whether his recent minutes have moved from his season's, on the red-to-green scale of
 * `toneColor` (0 red, 6 green): null while he plays about his usual minutes (within 2.5 minutes
 * and 10% of his season), so a starter with steady minutes stays plain. A rise starts at light
 * green (4) and is full green 6 minutes past the band; a fall goes from orange (2) to red (0).
 */
export function minutesTone(recent: number | null | undefined, season: number): number | null {
  if (recent == null || !(season > 0)) return null;
  const change = recent - season;
  const band = Math.max(MINUTES_STEADY, MINUTES_STEADY_SHARE * season);
  if (Math.abs(change) < band) return null;
  const strength = Math.min(1, (Math.abs(change) - band) / MINUTES_FULL);
  return change > 0 ? 4 + 2 * strength : 2 - 2 * strength;
}
