import { useState } from "react";
import { nbaTeam } from "../../shared/nbaTeams.ts";

// Teams whose logo could not be loaded. Shared by every tag on the page, so
// once a logo fails, the rest show the abbreviation alone without trying again.
const failed = new Set<string>();

/**
 * An NBA team's logo. Both the light-background and dark-background versions
 * are listed; CSS shows the one for the current theme, and the browser only
 * downloads the one on screen.
 */
export function TeamLogo({ team, size = "sm" }: { team: string | null; size?: "sm" | "md" }) {
  const info = nbaTeam(team);
  const [, setFailures] = useState(0);
  if (!info || failed.has(info.abbr)) return null;

  const onError = () => {
    failed.add(info.abbr);
    setFailures((count) => count + 1);
  };

  return (
    <span className={`team-logo team-logo-${size}`} aria-hidden="true">
      {(["light", "dark"] as const).map((variant) => (
        <img
          key={variant}
          className={`team-logo-${variant}`}
          src={`/api/logos/${info.abbr}/${variant}`}
          alt=""
          loading="lazy"
          decoding="async"
          onError={onError}
        />
      ))}
    </span>
  );
}

/** Logo and abbreviation of a player's NBA team, or a note when he has none. */
export function TeamTag({
  team,
  empty = "Free agent",
  size = "sm",
}: {
  team: string | null;
  empty?: string;
  size?: "sm" | "md";
}) {
  if (!team) return <span className="quiet">{empty}</span>;
  return (
    <span className="team-tag" title={nbaTeam(team)?.name}>
      <TeamLogo team={team} size={size} />
      <span className="quiet">{team}</span>
    </span>
  );
}
