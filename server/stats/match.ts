import type { PlayerRef } from "../../shared/types.ts";
import type { GameLine } from "./provider.ts";

// Sleeper and the stats source each have their own player IDs, so players
// are matched by name, with the NBA team as a tiebreaker.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Abbreviations that differ between data sources, mapped to one spelling.
const TEAM_ALIASES: Record<string, string> = {
  GS: "GSW",
  NO: "NOP",
  NY: "NYK",
  SA: "SAS",
  PHO: "PHX",
  UTAH: "UTA",
  WSH: "WAS",
  BRK: "BKN",
  CHO: "CHA",
};

/** "Luka Dončić", "Jaren Jackson Jr." -> "luka doncic", "jaren jackson". */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => !SUFFIXES.has(word))
    .join(" ");
}

function normalizeTeam(team: string | null): string | null {
  if (!team) return null;
  const upper = team.toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}

interface SourcePlayer {
  id: string;
  name: string;
  team: string | null;
  games: number;
}

/** Lists the players that appear in a set of game lines, with their latest team. */
export function sourcePlayers(lines: GameLine[]): SourcePlayer[] {
  const players = new Map<string, SourcePlayer & { latest: string }>();
  for (const line of lines) {
    const existing = players.get(line.playerId);
    if (!existing) {
      players.set(line.playerId, {
        id: line.playerId,
        name: line.playerName,
        team: line.team,
        games: 1,
        latest: line.date,
      });
    } else {
      existing.games++;
      if (line.date >= existing.latest) {
        existing.latest = line.date;
        existing.team = line.team;
      }
    }
  }
  return [...players.values()];
}

/**
 * Returns Sleeper player ID -> stats-source player ID.
 * `overrides` (same direction) wins over name matching.
 */
export function matchPlayers(
  sleeperPlayers: Record<string, PlayerRef>,
  lines: GameLine[],
  overrides: Record<string, string> = {},
): Map<string, string> {
  const byName = new Map<string, SourcePlayer[]>();
  for (const player of sourcePlayers(lines)) {
    const name = normalizeName(player.name);
    byName.set(name, [...(byName.get(name) ?? []), player]);
  }

  // Step 1: each Sleeper player picks its best candidate.
  const claims = new Map<string, { sleeper: PlayerRef; sameTeam: boolean }[]>();
  for (const sleeper of Object.values(sleeperPlayers)) {
    if (overrides[sleeper.id]) continue;
    const candidates = byName.get(normalizeName(sleeper.name));
    if (!candidates) continue;
    const team = normalizeTeam(sleeper.team);
    const onSameTeam = candidates.filter((c) => team && normalizeTeam(c.team) === team);
    const pool = onSameTeam.length > 0 ? onSameTeam : candidates;
    const best = pool.reduce((a, b) => (b.games > a.games ? b : a));
    claims.set(best.id, [
      ...(claims.get(best.id) ?? []),
      { sleeper, sameTeam: onSameTeam.length > 0 },
    ]);
  }

  // Step 2: if several Sleeper entries claim one source player (Sleeper
  // sometimes lists a name twice), keep the one on the same NBA team,
  // then the one that has a team at all.
  const matches = new Map<string, string>();
  for (const [sourceId, claimants] of claims) {
    const winner = claimants.reduce((a, b) => {
      const score = (c: typeof a) => (c.sameTeam ? 2 : 0) + (c.sleeper.team ? 1 : 0);
      return score(b) > score(a) ? b : a;
    });
    matches.set(winner.sleeper.id, sourceId);
  }
  for (const [sleeperId, sourceId] of Object.entries(overrides)) {
    matches.set(sleeperId, sourceId);
  }
  return matches;
}
