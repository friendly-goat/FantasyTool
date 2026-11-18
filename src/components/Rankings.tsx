import type { TeamStrength } from "../../shared/strength.ts";
import type { LeagueSnapshot } from "../../shared/types.ts";
import { Standings } from "./Standings.tsx";
import { Strength } from "./Strength.tsx";

export type RankingMode = "standings" | "strength";

const MODES: { mode: RankingMode; label: string }[] = [
  { mode: "standings", label: "Standings" },
  { mode: "strength", label: "Team strength" },
];

interface Props {
  mode: RankingMode;
  onModeChange: (mode: RankingMode) => void;
  snapshot: LeagueSnapshot;
  strengths: TeamStrength[] | null;
  myRosterId: number | null;
  onOpenTeam: (rosterId: number) => void;
}

/** The league's teams ranked two ways: the standings as they are, and strength over the rest of the season. */
export function Rankings({ mode, onModeChange, snapshot, strengths, myRosterId, onOpenTeam }: Props) {
  return (
    <section aria-label="Rankings">
      <div className="segmented" role="group" aria-label="Rank teams by">
        {MODES.map((option) => (
          <button
            key={option.mode}
            type="button"
            className="segment"
            aria-pressed={mode === option.mode}
            onClick={() => onModeChange(option.mode)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {mode === "standings" ? (
        <Standings snapshot={snapshot} myRosterId={myRosterId} onOpenTeam={onOpenTeam} />
      ) : (
        <Strength snapshot={snapshot} strengths={strengths} myRosterId={myRosterId} onOpenTeam={onOpenTeam} />
      )}
    </section>
  );
}
