import type { StatsReport } from "../../shared/types.ts";
import { formatAgo } from "../format.ts";

// Plain-language names for Sleeper scoring settings that a box score
// cannot supply. Anything not listed is shown by its setting name.
const SETTING_NAMES: Record<string, string> = {
  tf: "technical fouls",
  ff: "flagrant fouls",
};

function describeIgnored(settings: string[]): string {
  return settings.map((setting) => SETTING_NAMES[setting] ?? setting).join(" and ");
}

/** Explains the state of player stats: off, downloading, failed, or any gaps. */
export function StatsNotice({ stats, onRetry }: { stats: StatsReport; onRetry: () => void }) {
  if (stats.status === "unconfigured") {
    return (
      <p className="notice">
        Player stats are off. Add <code>BALLDONTLIE_API_KEY</code> to your <code>.env</code> file and restart
        the server to see them.
      </p>
    );
  }

  if (stats.status === "syncing") {
    return (
      <p className="notice" role="status">
        Downloading game stats from {stats.source}
        {stats.pagesFetched > 0 ? ` (${stats.pagesFetched} pages so far)` : ""}. The first download of a
        season takes a minute or two.
      </p>
    );
  }

  if (stats.status === "error") {
    return (
      <p className="notice notice-error" role="alert">
        Player stats could not be downloaded. {stats.message}{" "}
        <button type="button" className="link-button" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }

  const playerCount = Object.keys(stats.players).length;
  if (playerCount === 0) {
    return <p className="notice notice-warn">The stats source has no finished games for this season yet.</p>;
  }

  return (
    <p className="quiet stats-footnote">
      Fantasy points use this league's scoring settings
      {stats.ignoredScoring.length > 0 &&
        `, except ${describeIgnored(stats.ignoredScoring)}, which the stats source does not track`}
      . Averages are the mean of a player's game scores, so they can read lower than the Sleeper app,
      which adds each scoring bonus once to season totals. Game stats from {stats.source}
      {stats.syncedAt ? `, updated ${formatAgo(stats.syncedAt)}` : ""}.
      {stats.unmatchedRostered.length > 0 &&
        ` No stats found for: ${stats.unmatchedRostered.map((player) => player.name).join(", ")}.`}
    </p>
  );
}
