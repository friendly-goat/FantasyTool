// When the optional keep-awake visit may run (see server/index.ts, KEEP_AWAKE_URL).

/** Whether `hour` (0 to 23) falls in a window like "7-24" or "22-6"; no window means always. */
export function inAwakeHours(window: string | undefined, hour: number): boolean {
  const match = window?.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!match) return true;
  const start = Number(match[1]) % 24;
  const end = Number(match[2]) === 24 ? 24 : Number(match[2]) % 24;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function localHour(timeZone: string | undefined): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timeZone || "UTC" }).format(new Date()));
  } catch {
    return new Date().getUTCHours();
  }
}
