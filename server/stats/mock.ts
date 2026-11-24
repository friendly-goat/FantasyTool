import type { GameLine, InjuryReport, ScheduledGame, StatsProvider } from "./provider.ts";

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
const ROSTERED_PLAYERS = 130;
/** Low-minute games dated before the season, to exercise the preseason filter. */
const PRESEASON_GAMES = 2;
/** Mock players whose index divides by this have no games, to show the "no stats" case. */
const NO_GAMES_EVERY = 29;
const TEAMS = ["ATL", "BOS", "CHI", "DAL", "DEN", "GSW", "LAL", "MIA", "MIL", "NYK", "OKC", "PHX"];

/** A repeatable number in [0, 1) for a player. */
function fraction(index: number, salt: number): number {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Scales every stat for a player. The mock league rosters the first 130
 * players; the rest are free agents and, as in a real league, weaker.
 */
function talentOf(index: number): number {
  return (0.35 + fraction(index, 1) * 0.9) * (index >= ROSTERED_PLAYERS ? 0.6 : 1);
}

const MOCK_SEASON = "2026";
const LONG_ABSENCE_EVERY = 17;
const LAST_SEASON_GAMES = 40;
/** Mock players whose index divides by this are rookies: no last season. */
const ROOKIE_EVERY = 7;

/**
 * An earlier season. Last season: each player near this season's level, some clearly above or
 * below, 40 games. Older seasons (the career graph): a career arc that peaks in a different year
 * for each player, form that drifts through the season, and a season length that varies by team.
 */
function lastSeasonLines(players: Record<string, unknown>, year: number): GameLine[] {
  const lastSeason = year === Number(MOCK_SEASON) - 1;
  const random = seeded(lastSeason ? 23 : 23 + year);
  const lines: GameLine[] = [];
  Object.values(players as Record<string, { player_id: string; full_name: string; team: string }>).forEach(
    (player, index) => {
      // Near this season's level: between 20% below and 25% above.
      const base = talentOf(index) * (0.8 + fraction(index, 2) * 0.45);
      if (index % ROOKIE_EVERY === 3) return;
      const ago = Number(MOCK_SEASON) - 1 - year;
      const peakAgo = fraction(index, 7) * 7;
      const arc = lastSeason ? 1 : Math.min(1.15, Math.max(0.4, 1.05 - 0.012 * (ago - peakAgo) ** 2));
      // Teammates share a schedule, so a past season's missed games line up with the team's.
      const teamIndex = Math.max(0, TEAMS.indexOf(player.team));
      const seasonGames = lastSeason ? LAST_SEASON_GAMES : 30 + Math.floor(fraction(teamIndex + 1, year) * 52);
      for (let game = 0; game < seasonGames; game++) {
        const drift = lastSeason ? 0 : 0.12 * Math.sin(game / 7 + index);
        const level = base * arc * (1 + drift);
        const roll = 0.7 + random() * 0.6;
        const pts = Math.round(18 * level * roll);
        lines.push({
          key: `y${year}g${game}:p${player.player_id}`,
          playerId: `p${player.player_id}`,
          playerName: player.full_name,
          team: player.team,
          date: new Date(Date.UTC(year, 10, 1 + game * 2)).toISOString().slice(0, 10),
          final: true,
          minutes: 30,
          stats: {
            pts, reb: Math.round(6.5 * level * roll), ast: Math.round(5 * level * roll),
            stl: Math.round(1.4 * level), blk: Math.round(0.9 * level), tov: Math.round(2.4 * level), tpm: 1, tpa: 3, fgm: Math.round(pts / 2.4), fga: Math.round(pts / 1.1),
            ftm: 2, fta: 3, oreb: 1, dreb: Math.round(5 * level * roll), pf: 2,
          },
        });
      }
    },
  );
  return lines;
}

/** Last day of mock box scores: games after it are still to be played. */
const LAST_PLAYED = "2026-11-12";

function mockDayIndex(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.UTC(2026, 9, 21)) / 86_400_000);
}

/**
 * A schedule that agrees with the mock box scores: every team plays on the
 * days that have box scores, and after the last of them, games are still to
 * come (half the teams one day, the other half the next, then everyone).
 */
export function mockSchedule(startDate: string, endDate: string): ScheduledGame[] {
  const games: ScheduledGame[] = [];
  for (let day = startDate; day <= endDate; ) {
    const index = mockDayIndex(day);
    const after = day > LAST_PLAYED ? mockDayIndex(day) - mockDayIndex(LAST_PLAYED) : 0;
    let teams: string[] = [];
    if (index >= 0 && day <= LAST_PLAYED && index % 2 === 0) teams = TEAMS;
    else if (after > 0) teams = after % 3 === 1 ? TEAMS.slice(0, 6) : after % 3 === 2 ? TEAMS.slice(6) : TEAMS;
    const half = teams.length / 2;
    for (let i = 0; i < half; i++) {
      const home = teams[(i + index) % teams.length]!;
      const away = teams[(i + index + half) % teams.length]!;
      const final = day <= LAST_PLAYED;
      games.push({
        id: `m${day}-${home}`,
        date: day,
        startTime: `${day}T${i % 2 === 0 ? "23" : "22"}:30:00Z`,
        home,
        away,
        state: final ? "final" : "scheduled",
        homeScore: final ? 100 + Math.round(fraction(index, i) * 30) : null,
        awayScore: final ? 98 + Math.round(fraction(index, i + 7) * 30) : null,
        statusText: final ? "Final" : null,
      });
    }
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    day = next.toISOString().slice(0, 10);
  }
  return games;
}

// The injury report for the players who sit out the latest games, one of
// each kind the app reads: a few days away, a re-evaluation, weeks away, and
// out for the season. Dates are written as balldontlie writes them, without
// a year, counted from `today`.
const MOCK_INJURIES: { days: number | null; status: string; description: string }[] = [
  { days: 2, status: "Day-To-Day", description: "Questionable with right ankle soreness." },
  { days: 25, status: "Out", description: "Diagnosed with a left knee bone bruise and will be re-evaluated in about three weeks." },
  { days: 45, status: "Out", description: "Expected to miss about six weeks with a fractured left hand." },
  { days: null, status: "Out", description: "Out for the season after surgery on his right Achilles." },
];

function monthDay(today: Date, days: number): string {
  const date = new Date(today.getTime() + days * 86_400_000);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function mockInjuries(players: Record<string, unknown>, today = new Date()): InjuryReport[] {
  return Object.values(players as Record<string, { player_id: string; full_name: string }>)
    .filter((_, index) => index % LONG_ABSENCE_EVERY === 5 && index % NO_GAMES_EVERY !== NO_GAMES_EVERY - 1)
    .map((player, order) => {
      const kind = MOCK_INJURIES[order % MOCK_INJURIES.length]!;
      return {
        playerId: `p${player.player_id}`,
        playerName: player.full_name,
        status: kind.status,
        returnDate: kind.days === null ? null : monthDay(today, kind.days),
        description: kind.description,
      };
    });
}

export function createMockStats(players: Record<string, unknown>): StatsProvider {
  // Every player sits a stretch in odd years: four games from the tenth.
  const playerSeason = (playerId: string, season: string): GameLine[] => {
    const year = Number(season);
    return lastSeasonLines(players, year)
      .filter((line) => line.playerId === playerId)
      .filter((_, game) => year % 2 === 0 || game < 10 || game >= 14);
  };
  return {
    name: "mock",
    async fetchSchedule(startDate, endDate) {
      return mockSchedule(startDate, endDate);
    },
    async fetchInjuries() {
      return mockInjuries(players);
    },
    async fetchPlayerSeason(playerId, season) {
      return playerSeason(playerId, season);
    },
    async fetchPlayerSeasons(playerId, seasons) {
      return seasons.flatMap((season) => playerSeason(playerId, season));
    },
    async fetchTeamSeason(team, season) {
      const dates = new Set(lastSeasonLines(players, Number(season)).filter((line) => line.team === team.abbreviation).map((line) => line.date));
      return [...dates].sort().map((date, index) => ({
        id: `${team.abbreviation}-${date}`,
        date,
        startTime: null,
        home: index % 2 === 0 ? team.abbreviation : TEAMS[index % TEAMS.length]!,
        away: index % 2 === 0 ? TEAMS[index % TEAMS.length]! : team.abbreviation,
        state: "final" as const,
        homeScore: 100,
        awayScore: 98,
        statusText: "Final",
      }));
    },
    async fetchGameLines(season, fromDate, onPage) {
      if (season !== MOCK_SEASON) {
        onPage(1);
        return lastSeasonLines(players, Number(season));
      }
      const random = seeded(11);
      const lines: GameLine[] = [];
      Object.values(players as Record<string, { player_id: string; full_name: string; team: string }>).forEach(
        (player, index) => {
          if (index % NO_GAMES_EVERY === NO_GAMES_EVERY - 1) return;
          const talent = talentOf(index);
          for (let game = -PRESEASON_GAMES; game < GAMES_PER_PLAYER; game++) {
            const preseason = game < 0;
            const date = new Date(Date.UTC(2026, 9, preseason ? 14 + game * 2 : 21 + game * 2))
              .toISOString()
              .slice(0, 10);
            // Occasional game missed; a few players are out for the latest five games.
            const injured = index % LONG_ABSENCE_EVERY === 5 && game >= GAMES_PER_PLAYER - 5;
            const sat = random() < 0.08 || injured;
            const effort = preseason ? 0.5 : 1;
            const roll = () => (0.6 + random() * 0.8) * effort;
            const opponent = TEAMS[(index + game + PRESEASON_GAMES + 1) % TEAMS.length]!;
            const fga = Math.round(14 * talent * roll());
            const fgm = Math.round(fga * (0.38 + random() * 0.2));
            const tpa = Math.round(fga * 0.35);
            const tpm = Math.min(fgm, Math.round(tpa * (0.25 + random() * 0.2)));
            const fta = Math.round(5 * talent * roll());
            const ftm = Math.round(fta * 0.78);
            const oreb = Math.round(1.5 * talent * roll());
            const dreb = Math.round(5 * talent * roll());
            const line: GameLine = {
              key: `g${game + PRESEASON_GAMES}:p${player.player_id}`,
              playerId: `p${player.player_id}`,
              playerName: player.full_name,
              team: player.team,
              teamId: player.team,
              opponentId: opponent,
              opponent,
              home: (index + game) % 2 === 0,
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
