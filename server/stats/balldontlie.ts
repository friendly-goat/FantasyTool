import type { GameLine, StatsProvider } from "./provider.ts";

// balldontlie (https://docs.balldontlie.io). Game stats need the ALL-STAR
// plan, which allows 60 requests per minute. Requests here are spaced to
// stay under that.

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
  team?: { abbreviation?: string } | null;
  game?: { id?: number; date?: string; status?: string } | null;
}

interface RawPage {
  data?: RawRow[];
  meta?: { next_cursor?: number | null };
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
  return {
    key: `${gameId}:${playerId}`,
    playerId: String(playerId),
    playerName: [row.player?.first_name, row.player?.last_name].filter(Boolean).join(" "),
    team: row.team?.abbreviation ?? null,
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

export function createBalldontlie(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  spacingMs: number = REQUEST_SPACING_MS,
): StatsProvider {
  async function getPage(url: string): Promise<RawPage> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error("balldontlie could not be reached. Check your internet connection.");
      }
      if (response.ok) return (await response.json()) as RawPage;
      if (response.status === 429 && attempt < MAX_RETRIES) {
        await sleep(Math.max(spacingMs, 1) * 15); // Rate limited: back off, then retry.
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
        await sleep(spacingMs);
      }
      return lines;
    },
  };
}
