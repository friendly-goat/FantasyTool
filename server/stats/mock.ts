import type { GameLine, StatsProvider } from "./provider.ts";

// Made-up box scores for the mock league (`npm run dev:mock` and tests).
// Player names match server/mock.ts so that name matching is exercised.

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const GAMES_PER_PLAYER = 12;
/** Mock players whose index divides by this have no games, to show the "no stats" case. */
const NO_GAMES_EVERY = 29;

export function createMockStats(players: Record<string, unknown>): StatsProvider {
  return {
    name: "mock",
    async fetchGameLines(_season, fromDate, onPage) {
      const random = seeded(11);
      const lines: GameLine[] = [];
      Object.values(players as Record<string, { player_id: string; full_name: string; team: string }>).forEach(
        (player, index) => {
          if (index % NO_GAMES_EVERY === NO_GAMES_EVERY - 1) return;
          const talent = 0.35 + random() * 0.9; // Scales every stat for this player.
          for (let game = 0; game < GAMES_PER_PLAYER; game++) {
            const date = new Date(Date.UTC(2026, 9, 21 + game * 2)).toISOString().slice(0, 10);
            const sat = random() < 0.08; // Occasional game missed.
            const roll = () => 0.6 + random() * 0.8;
            const fga = Math.round(14 * talent * roll());
            const fgm = Math.round(fga * (0.38 + random() * 0.2));
            const tpa = Math.round(fga * 0.35);
            const tpm = Math.min(fgm, Math.round(tpa * (0.25 + random() * 0.2)));
            const fta = Math.round(5 * talent * roll());
            const ftm = Math.round(fta * 0.78);
            const oreb = Math.round(1.5 * talent * roll());
            const dreb = Math.round(5 * talent * roll());
            const line: GameLine = {
              key: `g${game}:p${player.player_id}`,
              playerId: `p${player.player_id}`,
              playerName: player.full_name,
              team: player.team,
              date,
              final: true,
              minutes: sat ? 0 : Math.round(20 + 14 * Math.min(1, talent) * roll()),
              stats: {
                pts: fgm * 2 + tpm + ftm,
                reb: oreb + dreb,
                ast: Math.round(5 * talent * roll()),
                stl: Math.round(1.4 * talent * roll()),
                blk: Math.round(0.9 * talent * roll()),
                tov: Math.round(2.4 * talent * roll()),
                tpm,
                tpa,
                fgm,
                fga,
                ftm,
                fta,
                oreb,
                dreb,
                pf: Math.round(2.5 * roll()),
              },
            };
            if (!fromDate || date >= fromDate) lines.push(line);
          }
        },
      );
      onPage(1);
      return lines;
    },
  };
}
