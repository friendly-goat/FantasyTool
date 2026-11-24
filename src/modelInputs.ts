import { nbaDay } from "../shared/weeks.ts";
import type { LeagueSnapshot, PlayerRef } from "../shared/types.ts";

// The league snapshot changes every time the server refreshes it (live matchup points, the time
// it was fetched, lineup order), but the projections only read part of it. This fingerprint is
// that part, so the page rebuilds its model (and everything worked out from it: strength, top
// moves, trade searches) only when something the model reads has changed.

const sortedPlayers = (players: PlayerRef[]) =>
  players
    .map((player) => JSON.stringify(player))
    .sort()
    .join("|");

/** What the strength model and the team situations read from a snapshot, as one string. */
export function modelFingerprint(snapshot: LeagueSnapshot): string {
  return JSON.stringify({
    league: snapshot.league,
    week: snapshot.week,
    // The model's calendar starts today.
    today: nbaDay(Date.parse(snapshot.fetchedAt)),
    teams: snapshot.teams.map((team) => ({
      rosterId: team.rosterId,
      ownerId: team.ownerId,
      record: [team.wins, team.losses, team.ties, team.pointsFor, team.pointsAgainst, team.rank],
      // Who is on the roster matters, not where the manager has slotted him today.
      roster: sortedPlayers([...team.starters.flatMap((slot) => (slot.player ? [slot.player] : [])), ...team.bench]),
      reserve: sortedPlayers(team.reserve),
    })),
    // This week's pairings (team situations read the opponent), not the live points.
    pairings: snapshot.matchups.map((matchup) => matchup.sides.map((side) => side.rosterId)),
  });
}
