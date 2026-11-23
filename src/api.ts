import type {
  AppConfig,
  DraftBoard,
  LockMarks,
  WeekData,
  WeekMatchups,
  LeagueSnapshot,
  PlayerDetail,
  ScheduleAhead,
  ScoreHistory,
  StatsReport,
  UserLeagues,
} from "../shared/types.ts";

// All data comes from the local backend (server/), never from Sleeper directly.

/** Sent when the server says the sign-in is missing or has run out; App shows the sign-in screen. */
export const SIGNED_OUT_EVENT = "fantasytool:signed-out";

/** Thrown when the server cannot be reached at all (offline, or still waking up and timing out). */
export class OfflineError extends Error {
  constructor() {
    super("The server could not be reached. Check your connection.");
  }
}

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new OfflineError();
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}.`);
  }
  return body as T;
}

export type Role = "admin" | "viewer";

export interface Session {
  /** False when the server runs without passwords (local development). */
  authRequired: boolean;
  role: Role | null;
}

export function getSession(): Promise<Session> {
  return getJson("/api/session");
}

export async function signIn(password: string): Promise<Role> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = (await response.json().catch(() => null)) as { role?: Role; error?: string } | null;
  if (!response.ok || !body?.role) throw new Error(body?.error ?? "Signing in failed.");
  return body.role;
}

export async function signOut(): Promise<void> {
  await fetch("/api/session", { method: "DELETE" });
}

export function getConfig(): Promise<AppConfig> {
  return getJson("/api/config");
}

/** The league, from the server's saved copy; the server keeps it fresh on its own. */
export function getLeague(leagueId: string): Promise<LeagueSnapshot> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}`);
}

export function getStats(leagueId: string, retry = false): Promise<StatsReport> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/stats${retry ? "?retry=1" : ""}`);
}

export function getPlayerDetail(leagueId: string, playerId: string): Promise<PlayerDetail> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/players/${encodeURIComponent(playerId)}`);
}

/** The NBA side of a fantasy week (the current one when `week` is left out): schedule and box scores. */
export function getWeek(leagueId: string, week?: number): Promise<WeekData> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/week${week ? `?week=${week}` : ""}`);
}

/** A week's matchups, for weeks before the current one (the current week's come with the league). */
/** Every finished week's final score per team. */
export function getHistory(leagueId: string): Promise<ScoreHistory> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/history`);
}

/** The NBA games left in the fantasy regular season. */
export function getScheduleAhead(leagueId: string): Promise<ScheduleAhead> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/schedule-ahead`);
}

export function getMatchups(leagueId: string, week: number): Promise<WeekMatchups> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/matchups?week=${week}`);
}

export function getLockMarks(leagueId: string, week?: number): Promise<LockMarks> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/locks${week ? `?week=${week}` : ""}`);
}

/** Marks a starter's current score as locked (true) or not (false), or clears the mark (null). */
export async function setLockMark(
  leagueId: string,
  rosterId: number,
  playerId: string,
  locked: boolean | null,
  week?: number,
): Promise<LockMarks> {
  const response = await fetch(`/api/league/${encodeURIComponent(leagueId)}/locks`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rosterId, playerId, locked, week }),
  });
  const body = (await response.json().catch(() => null)) as (LockMarks & { error?: string }) | null;
  if (response.status === 401) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if (!response.ok || !body) throw new Error(body?.error ?? `Saving the mark failed (${response.status}).`);
  return body;
}

export function getDraft(leagueId: string): Promise<{ board: DraftBoard | null }> {
  return getJson(`/api/league/${encodeURIComponent(leagueId)}/draft`);
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
