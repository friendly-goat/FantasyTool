import type { ScheduleAhead } from "../shared/types.ts";
import { getScheduleAhead } from "./api.ts";

// The NBA schedule for the rest of the fantasy regular season, loaded once per league and week
// and shared by everything that needs it: the strength model (App) and the Schedule axis (team
// charts). A failed load gives null and is tried again next time.

const loaded = new Map<string, ScheduleAhead>();
const pending = new Map<string, Promise<ScheduleAhead | null>>();

export function loadScheduleAhead(leagueId: string, week: number): Promise<ScheduleAhead | null> {
  const key = `${leagueId}:${week}`;
  const ready = loaded.get(key);
  if (ready) return Promise.resolve(ready);
  let request = pending.get(key);
  if (!request) {
    request = getScheduleAhead(leagueId)
      .then((schedule) => {
        loaded.set(key, schedule);
        return schedule;
      })
      .catch(() => null)
      .finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

/** The schedule if it is already loaded, without waiting. */
export function loadedScheduleAhead(leagueId: string, week: number): ScheduleAhead | undefined {
  return loaded.get(`${leagueId}:${week}`);
}
