import type {
  AppConfig,
  LeagueSnapshot,
  PlayerDetail,
  StatsReport,
  UserLeagues,
} from "../shared/types.ts";

// All data comes from the local backend (server/), never from Sleeper directly.

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}.`);
  }
  return body as T;
}

export function getConfig(): Promise<AppConfig> {
  return getJson("/api/config");
}

export function getLeague(leagueId: string, refresh = false): Promise<LeagueSnapshot> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}${refresh ? "?refresh=1" : ""}`);
}

export function getStats(leagueId: string, retry = false): Promise<StatsReport> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/stats${retry ? "?retry=1" : ""}`);
}

export function getPlayerDetail(leagueId: string, playerId: string): Promise<PlayerDetail> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/players/${encodeURIComponent(playerId)}`);
}

export function getUserLeagues(username: string): Promise<UserLeagues> {
  return getJson(`/api/user/${encodeURIComponent(username)}/leagues`);
}

// The chosen league is remembered in this browser. Storage can be
// unavailable (private mode), in which case the picker shows again.
const STORAGE_KEY = "fantasytool.leagueId";

export function loadSavedLeagueId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveLeagueId(leagueId: string | null): void {
  try {
    if (leagueId) localStorage.setItem(STORAGE_KEY, leagueId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Not remembered; nothing else to do.
  }
}

// Which team in a league is the user's own. Remembered per league.
const myTeamKey = (leagueId: string) => `fantasytool.myTeam.${leagueId}`;

export function loadMyRosterId(leagueId: string): number | null {
  try {
    const saved = localStorage.getItem(myTeamKey(leagueId));
    return saved === null ? null : Number(saved);
  } catch {
    return null;
  }
}

export function saveMyRosterId(leagueId: string, rosterId: number | null): void {
  try {
    if (rosterId === null) localStorage.removeItem(myTeamKey(leagueId));
    else localStorage.setItem(myTeamKey(leagueId), String(rosterId));
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}
