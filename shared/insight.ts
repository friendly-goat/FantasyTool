import { rosterPlayers, slotAccepts } from "./analysis.ts";
import { projectRoster, type ModelPlayer, type StrengthModel, type TeamStrength } from "./strength.ts";
import type { LeagueSnapshot } from "./types.ts";

// Reading a roster and a team's situation. Nothing here is a fixed rule
// about a position or a player: every figure is measured by changing the
// roster and seeing what happens to its projected weekly score.

export const POSITIONS = ["PG", "SG", "SF", "PF", "C"];
/** Weeks used for these what-if checks. Fewer than the full set, for speed. */
const WHAT_IF_WEEKS = 80;

export interface PositionNote {
  position: string;
  /**
   * Weekly points the team would gain from a typical starter in the lineup
   * slots reserved for this position.
   */
  need: number;
  /** The team's most valuable player at this position. */
  best: ModelPlayer | null;
  /** How much of that player's weekly value the rest of the roster would make up if he left. */
  cover: number;
}

/** A typical starter at one position: the middle value among all teams' starters. */
function typicalStarter(model: StrengthModel, snapshot: LeagueSnapshot, position: string): ModelPlayer {
  const starters = snapshot.teams
    .flatMap((team) =>
      rosterPlayers(team)
        .flatMap((player) => model.players.get(player.id) ?? [])
        .sort((a, b) => b.expected - a.expected)
        .slice(0, model.slots.length),
    )
    .map((player) => player.expected)
    .sort((a, b) => a - b);
  const value = starters[Math.floor(starters.length / 2)] ?? 0;
  const weeks = model.players.values().next().value?.weeks.length ?? 0;
  return {
    id: `typical-${position}`,
    name: `Typical ${position}`,
    team: null,
    positions: [position],
    injuryStatus: null,
    games: 1,
    average: value,
    projected: value,
    longTermOut: false,
    availability: 1,
    healthy: value,
    expected: value,
    // He may fill only the slots reserved for his position, not the open
    // UTIL slots. Otherwise every position would show the same need: the
    // gap between a typical starter and the team's weakest starter.
    eligible: model.slots.map((slot) => slot !== "UTIL" && slotAccepts(slot, [position])),
    weeks: new Float64Array(weeks).fill(value),
  };
}

/** Where a roster is thin and where it has players to spare, position by position. */
export function positionProfile(model: StrengthModel, snapshot: LeagueSnapshot, playerIds: string[]): PositionNote[] {
  const roster = playerIds.flatMap((id) => model.players.get(id) ?? []);
  const base = projectRoster(model, roster, WHAT_IF_WEEKS);
  return POSITIONS.map((position) => {
    const need =
      projectRoster(model, [...roster, typicalStarter(model, snapshot, position)], WHAT_IF_WEEKS) - base;
    const atPosition = roster.filter((player) => player.positions.includes(position) && player.games > 0);
    const best = atPosition.reduce<ModelPlayer | null>((a, b) => (a && a.expected >= b.expected ? a : b), null);
    const without = best ? projectRoster(model, roster.filter((player) => player !== best), WHAT_IF_WEEKS) : base;
    return { position, need, best, cover: best ? Math.max(0, best.expected - (base - without)) : 0 };
  });
}

export interface TeamSituation {
  rosterId: number;
  winShare: number;
  /** Players in a long absence right now, most valuable first. */
  longTermOut: ModelPlayer[];
  /**
   * 0 to 1: how much pressure the team is under to make a move. Made of
   * three parts with fixed shares, so none can dominate: value lost to
   * long absences (40%), a losing record (40%), and being the weaker team
   * in this week's matchup (20%).
   */
  urgency: number;
}

export function teamSituations(
  snapshot: LeagueSnapshot,
  model: StrengthModel,
  strengths: TeamStrength[],
): Map<number, TeamSituation> {
  const strength = new Map(strengths.map((entry) => [entry.rosterId, entry]));
  const opponent = new Map<number, number>();
  for (const matchup of snapshot.matchups) {
    const [a, b] = matchup.sides;
    if (a && b) {
      opponent.set(a.rosterId, b.rosterId);
      opponent.set(b.rosterId, a.rosterId);
    }
  }

  return new Map(
    snapshot.teams.map((team) => {
      const played = team.wins + team.losses + team.ties;
      const winShare = played > 0 ? (team.wins + team.ties / 2) / played : 0.5;
      const longTermOut = rosterPlayers(team)
        .flatMap((player) => model.players.get(player.id) ?? [])
        .filter((player) => player.longTermOut)
        .sort((a, b) => b.healthy - a.healthy);
      const own = strength.get(team.rosterId);
      const lineup = own?.fullHealth ?? 0;
      // A third of the lineup's value sitting out counts as the maximum.
      const absence = lineup > 0 ? Math.min(1, (longTermOut.reduce((sum, p) => sum + p.healthy, 0) / lineup) * 3) : 0;
      const other = strength.get(opponent.get(team.rosterId) ?? -1);
      const underdog = own && other ? Math.min(1, Math.max(0, (other.score - own.score) / 300)) : 0;
      return [
        team.rosterId,
        { rosterId: team.rosterId, winShare, longTermOut, urgency: 0.4 * absence + 0.4 * (1 - winShare) + 0.2 * underdog },
      ];
    }),
  );
}

/** How far a player's projection sits above (+) or below (-) the average other managers see. */
export function marketGap(player: ModelPlayer): number {
  return player.average > 0 ? player.projected / player.average - 1 : 0;
}
/** A gap of this size earns a "buy low" or "sell high" note. */
export const MARKET_GAP_NOTE = 0.05;
