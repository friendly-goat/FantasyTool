import type { Team } from "../../shared/types.ts";
import { formatRecord, ordinal } from "../format.ts";

/** A team's record and place in the standings, as a small tag beside its name. */
export function RecordTag({ team }: { team: Team }) {
  return (
    <span className="record-tag" title={`${ordinal(team.rank)} in the standings`}>
      {formatRecord(team.wins, team.losses, team.ties)}
      <span className="record-tag-rank">{ordinal(team.rank)}</span>
    </span>
  );
}

/** A bar from the middle: right and green for a gain, left and red for a loss. */
export function EffectBar({ change, scale, label }: { change: number; scale: number; label: string }) {
  const width = Math.min(50, (Math.abs(change) / Math.max(1, scale)) * 50);
  return (
    <div className="effect" role="img" aria-label={label}>
      <span className="effect-center" />
      <span
        className={`effect-fill ${change >= 0 ? "effect-up" : "effect-down"}`}
        style={change >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
      />
    </div>
  );
}
