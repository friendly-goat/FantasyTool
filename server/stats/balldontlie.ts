import type { GameLine, InjuryReport, ScheduledGame, StatsProvider } from "./provider.ts";

// balldontlie (https://docs.balldontlie.io). Game stats need the ALL-STAR
// plan, which allows 60 requests per minute. Every request goes through one
// queue that spaces them at least REQUEST_SPACING_MS apart (about 54 a
// minute), whatever asked for it. Requests someone is waiting on (the
// schedule) go ahead of background downloads (box scores).

const BASE_URL = "https://api.balldontlie.io/nba/v1";
const REQUEST_SPACING_MS = 1100;
const MAX_PAGES = 600;
const MAX_RETRIES = 4;

interface RawRow {
  id?: number;
  min?: string | number | null;
  pts?: number | null;
  reb?: number | null;
  ast?: number | null;
  stl?: number | null;
  blk?: number | null;
  turnover?: number | null;
  fg3m?: number | null;
  fg3a?: number | null;
  fgm?: number | null;
  fga?: number | null;
  ftm?: number | null;
  fta?: number | null;
  oreb?: number | null;
  dreb?: number | null;
  pf?: number | null;
  player?: { id?: number; first_name?: string; last_name?: string } | null;
  team?: RawTeam | null;
  game?: {
    id?: number;
    date?: string;
    status?: string;
    // The teams arrive either as IDs or as nested objects, depending on the endpoint.
    home_team_id?: number;
    visitor_team_id?: number;
    home_team?: RawTeam | null;
    visitor_team?: RawTeam | null;
  } | null;
}

interface RawInjury {
  player?: { id?: number; first_name?: string; last_name?: string } | null;
  return_date?: string | null;
  description?: string | null;
  status?: string | null;
}

/** One injury record, or null when it names no player. */
export function toInjuryReport(raw: RawInjury): InjuryReport | null {
  const id = raw.player?.id;
  if (id == null) return null;
  return {
    playerId: String(id),
    playerName: [raw.player?.first_name, raw.player?.last_name].filter(Boolean).join(" "),
    status: raw.status?.trim() || "Out",
    returnDate: raw.return_date?.trim() || null,
    description: raw.description?.trim() ?? "",
  };
}

interface RawTeam {
  id?: number;
  abbreviation?: string;
}

interface RawPage<T = RawRow> {
  data?: T[];
  meta?: { next_cursor?: number | null };
}

interface RawGame {
  id?: number;
  date?: string;
  datetime?: string | null;
  status?: string | null;
  status_state?: string | null;
  period?: number | null;
  /** Game clock during play, such as "1:27". */
  time?: string | null;
  home_team?: RawTeam | null;
  visitor_team?: RawTeam | null;
  home_team_score?: number | null;
  visitor_team_score?: number | null;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** "3rd Qtr 4:12" during play, "Final" after, nothing before. */
function statusText(state: ScheduledGame["state"], status: string, clock: string | null | undefined): string | null {
  if (!status || /^\d{4}-\d{2}-\d{2}T/.test(status)) return null;
  const time = clock?.trim();
  if (state === "in_progress" && time && !status.includes(time)) return `${status} ${time}`;
  return status;
}

export function toScheduledGame(game: RawGame): ScheduledGame | null {
  const date = game.date?.slice(0, 10);
  if (game.id == null || !date) return null;
  const status = game.status ?? "";
  // status_state is the normalized field; older answers only have status,
  // which holds the tip-off time before a game, a quarter during it, and
  // "Final" after.
  const state: ScheduledGame["state"] =
    game.status_state === "final" || /^final/i.test(status)
      ? "final"
      : game.status_state === "in_progress" || (game.period ?? 0) > 0
        ? "in_progress"
        : "scheduled";
  const startTime = game.datetime ?? (/^\d{4}-\d{2}-\d{2}T/.test(status) ? status : null);
  const played = state !== "scheduled";
  return {
    id: String(game.id),
    date,
    startTime,
    home: game.home_team?.abbreviation ?? null,
    away: game.visitor_team?.abbreviation ?? null,
    state,
    homeScore: played ? (game.home_team_score ?? null) : null,
    awayScore: played ? (game.visitor_team_score ?? null) : null,
    statusText: statusText(state, status, game.time),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "34", "34:12" or 34 -> minutes as a number. */
export function parseMinutes(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const [minutes, seconds] = value.split(":");
  return (Number(minutes) || 0) + (Number(seconds) || 0) / 60;
}

export function toGameLine(row: RawRow): GameLine | null {
  const playerId = row.player?.id;
  const gameId = row.game?.id;
  const date = row.game?.date?.slice(0, 10);
  if (playerId == null || gameId == null || !date) return null;
  const status = row.game?.status;

  // Work out the opponent from whichever side of the game is not the player's team.
  const teamId = row.team?.id;
  const homeId = row.game?.home_team?.id ?? row.game?.home_team_id;
  const visitorId = row.game?.visitor_team?.id ?? row.game?.visitor_team_id;
  const home = teamId != null && homeId != null && visitorId != null ? teamId === homeId : null;
  const opponentId = home === null ? null : home ? visitorId : homeId;
  const opponentTeam = home === null ? null : home ? row.game?.visitor_team : row.game?.home_team;

  return {
    key: `${gameId}:${playerId}`,
    playerId: String(playerId),
    playerName: [row.player?.first_name, row.player?.last_name].filter(Boolean).join(" "),
    team: row.team?.abbreviation ?? null,
    teamId: teamId != null ? String(teamId) : null,
    opponentId: opponentId != null ? String(opponentId) : null,
    opponent: opponentTeam?.abbreviation ?? null,
    home,
    date,
    final: status ? /^final/i.test(status) : true,
    minutes: parseMinutes(row.min),
    stats: {
      pts: row.pts ?? 0,
      reb: row.reb ?? 0,
      ast: row.ast ?? 0,
      stl: row.stl ?? 0,
      blk: row.blk ?? 0,
      tov: row.turnover ?? 0,
      tpm: row.fg3m ?? 0,
      tpa: row.fg3a ?? 0,
      fgm: row.fgm ?? 0,
      fga: row.fga ?? 0,
      ftm: row.ftm ?? 0,
      fta: row.fta ?? 0,
      oreb: row.oreb ?? 0,
      dreb: row.dreb ?? 0,
      pf: row.pf ?? 0,
    },
  };
}

/** One request at a time, spaced apart, with a fast lane for requests someone is waiting on. */
export function createRequestQueue(spacingMs: number, now = () => Date.now()) {
  const lanes = { urgent: [] as (() => void)[], background: [] as (() => void)[] };
  let lastAt = -Infinity;
  let running = false;

  async function pump() {
    if (running) return;
    running = true;
    while (lanes.urgent.length || lanes.background.length) {
      const wait = lastAt + spacingMs - now();
      if (wait > 0) await sleep(wait);
      const next = lanes.urgent.shift() ?? lanes.background.shift();
      lastAt = now();
      next?.();
    }
    running = false;
  }

  /** Resolves when this request may be sent. */
  return function turn(urgent: boolean): Promise<void> {
    return new Promise((resolve) => {
      (urgent ? lanes.urgent : lanes.background).push(resolve);
      void pump();
    });
  };
}

export function createBalldontlie(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  spacingMs: number = REQUEST_SPACING_MS,
): StatsProvider {
  const turn = createRequestQueue(spacingMs);

  async function getPage<T = RawRow>(url: string, urgent = false): Promise<RawPage<T>> {
    for (let attempt = 0; ; attempt++) {
      await turn(urgent);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error("balldontlie could not be reached. Check your internet connection.");
      }
      if (response.ok) return (await response.json()) as RawPage<T>;
      if (response.status === 429 && attempt < MAX_RETRIES) {
        await sleep(Math.max(spacingMs, 1) * 15); // Rate limited: back off, then retry (through the queue).
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "balldontlie rejected the API key. Check BALLDONTLIE_API_KEY in .env, and that the plan includes game stats (ALL-STAR or higher).",
        );
      }
      throw new Error(`balldontlie returned ${response.status}.`);
    }
  }

  return {
    name: "balldontlie",
    async fetchGameLines(season, fromDate, onPage) {
      const lines: GameLine[] = [];
      let cursor: number | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = new URLSearchParams({ per_page: "100" });
        params.append("seasons[]", season);
        if (fromDate) params.set("start_date", fromDate);
        if (cursor != null) params.set("cursor", String(cursor));

        const body = await getPage(`${BASE_URL}/stats?${params}`);
        for (const row of body.data ?? []) {
          const line = toGameLine(row);
          if (line) lines.push(line);
        }
        onPage(page);

        cursor = body.meta?.next_cursor ?? null;
        if (cursor == null || (body.data ?? []).length === 0) break;
      }
      return lines;
    },
    async fetchSchedule(startDate, endDate) {
      // The date filters' edges are not documented as inclusive, so ask for a
      // day either side and keep only the dates wanted.
      const games: ScheduledGame[] = [];
      let cursor: number | null = null;
      for (let page = 1; page <= 10; page++) {
        const params = new URLSearchParams({
          per_page: "100",
          start_date: addDays(startDate, -1),
          end_date: addDays(endDate, 1),
        });
        if (cursor != null) params.set("cursor", String(cursor));
        const body = await getPage<RawGame>(`${BASE_URL}/games?${params}`, true);
        for (const raw of body.data ?? []) {
          const game = toScheduledGame(raw);
          if (game && game.date >= startDate && game.date <= endDate) games.push(game);
        }
        cursor = body.meta?.next_cursor ?? null;
        if (cursor == null || (body.data ?? []).length === 0) break;
      }
      return games;
    },
    async fetchPlayerSeason(playerId, season) {
      const lines: GameLine[] = [];
      let cursor: number | null = null;
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({ per_page: "100", season_type: "regular" });
        params.append("player_ids[]", playerId);
        params.append("seasons[]", season);
        if (cursor != null) params.set("cursor", String(cursor));
        const body = await getPage(`${BASE_URL}/stats?${params}`, true);
        for (const row of body.data ?? []) {
          const line = toGameLine(row);
          if (line) lines.push(line);
        }
        cursor = body.meta?.next_cursor ?? null;
        if (cursor == null || (body.data ?? []).length === 0) break;
      }
      return lines;
    },
    async fetchPlayerSeasons(playerId, seasons) {
      // Every season asked for in one paged query: a long career is about a dozen pages.
      const lines: GameLine[] = [];
      let cursor: number | null = null;
      for (let page = 1; page <= 30; page++) {
        const params = new URLSearchParams({ per_page: "100", season_type: "regular" });
        params.append("player_ids[]", playerId);
        for (const season of seasons) params.append("seasons[]", season);
        if (cursor != null) params.set("cursor", String(cursor));
        const body = await getPage(`${BASE_URL}/stats?${params}`, true);
        for (const row of body.data ?? []) {
          const line = toGameLine(row);
          if (line) lines.push(line);
        }
        cursor = body.meta?.next_cursor ?? null;
        if (cursor == null || (body.data ?? []).length === 0) break;
      }
      return lines;
    },
    async fetchTeamSeason(team, season) {
      if (!team.id) return [];
      const games: ScheduledGame[] = [];
      let cursor: number | null = null;
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({ per_page: "100", season_type: "regular" });
        params.append("team_ids[]", team.id);
        params.append("seasons[]", season);
        if (cursor != null) params.set("cursor", String(cursor));
        const body = await getPage<RawGame>(`${BASE_URL}/games?${params}`, true);
        for (const raw of body.data ?? []) {
          const game = toScheduledGame(raw);
          if (game) games.push(game);
        }
        cursor = body.meta?.next_cursor ?? null;
        if (cursor == null || (body.data ?? []).length === 0) break;
      }
      return games;
    },
    async fetchInjuries() {
      // The whole league's report is a page or two. The NBA path is tried
      // first; the docs also list it without "/nba".
      const injuries: InjuryReport[] = [];
      for (const base of [BASE_URL, BASE_URL.replace("/nba/v1", "/v1")]) {
        let cursor: number | null = null;
        try {
          for (let page = 1; page <= 10; page++) {
            const params = new URLSearchParams({ per_page: "100" });
            if (cursor != null) params.set("cursor", String(cursor));
            const body = await getPage<RawInjury>(`${base}/player_injuries?${params}`);
            for (const raw of body.data ?? []) {
              const report = toInjuryReport(raw);
              if (report) injuries.push(report);
            }
            cursor = body.meta?.next_cursor ?? null;
            if (cursor == null || (body.data ?? []).length === 0) break;
          }
          return injuries;
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("returned 404")) || base !== BASE_URL) throw error;
        }
      }
      return injuries;
    },
  };
}
