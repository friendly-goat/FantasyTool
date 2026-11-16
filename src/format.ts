const pointsFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const dateFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const relativeFormat = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

export function formatPoints(value: number): string {
  return pointsFormat.format(value);
}

export function formatSigned(value: number): string {
  const text = pointsFormat.format(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** "5 minutes ago", "2 hours ago", "yesterday". */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, "hour");
  return relativeFormat.format(Math.round(hours / 24), "day");
}

export function formatRecord(wins: number, losses: number, ties: number): string {
  return ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

const oneDecimal = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Per-game averages: one decimal place. */
export function formatAverage(value: number): string {
  return oneDecimal.format(value);
}

const gameDateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "2026-11-12" -> "Nov 12". Noon avoids the date shifting across time zones. */
export function formatGameDate(date: string): string {
  return gameDateFormat.format(new Date(`${date}T12:00:00`));
}
