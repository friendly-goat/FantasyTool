import { useEffect, useState } from "react";
import type { StrengthModel } from "../../shared/strength.ts";
import type { LeagueSnapshot, Matchup } from "../../shared/types.ts";
import { weekRange } from "../../shared/weeks.ts";
import { getMatchups } from "../api.ts";
import { formatPoints, formatRecord, formatWeekRange } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { MatchupDetail } from "./MatchupDetail.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  /** Only the admin may mark locks; viewers see the results without the buttons. */
  canMarkLocks: boolean;
  myRosterId: number | null;
  openMatchupId: number | null;
  onOpenMatchup: (matchupId: number | null) => void;
  onOpenTeam: (rosterId: number) => void;
}

// Finished weeks do not change while the page is open, so each is loaded once.
const pastWeeks = new Map<string, Matchup[]>();

/** A finished week's matchups, or null for the current week (those come with the league). */
function usePastMatchups(leagueId: string, week: number | null) {
  const key = `${leagueId}-${week}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    matchups: Matchup[];
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (week === null || pastWeeks.has(key)) return;
    let cancelled = false;
    getMatchups(leagueId, week)
      .then((data) => {
        pastWeeks.set(key, data.matchups);
        if (!cancelled) setLoaded({ key, matchups: data.matchups });
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError({
            key,
            message: reason instanceof Error ? reason.message : String(reason),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [leagueId, week, key]);
  if (week === null) return { matchups: null, error: null };
  return {
    matchups: pastWeeks.get(key) ?? (loaded?.key === key ? loaded.matchups : null),
    error: error?.key === key ? error.message : null,
  };
}

function weekLabel(snapshot: LeagueSnapshot, week: number): string {
  const start = snapshot.league.seasonStartDate;
  const range = start ? weekRange(start, week) : null;
  const dates = range ? ` · ${formatWeekRange(range.start, range.end)}` : "";
  return `Week ${week}${dates}${week === snapshot.week ? " (this week)" : ""}`;
}

export function Matchups({
  snapshot,
  model,
  canMarkLocks,
  myRosterId,
  openMatchupId,
  onOpenMatchup,
  onOpenTeam,
}: Props) {
  const [picked, setPicked] = useState(snapshot.week);
  // A new week may start while the page is open; never point past it.
  const week = Math.min(picked, snapshot.week);
  const current = week === snapshot.week;
  const past = usePastMatchups(snapshot.league.id, current ? null : week);
  const matchups = current ? snapshot.matchups : past.matchups;
  const teams = new Map(snapshot.teams.map((team) => [team.rosterId, team]));

  const open = matchups?.find((matchup) => matchup.matchupId === openMatchupId);
  if (open) {
    return (
      <MatchupDetail
        snapshot={snapshot}
        model={model}
        canMarkLocks={canMarkLocks}
        matchup={open}
        week={week}
        myRosterId={myRosterId}
        onBack={() => onOpenMatchup(null)}
        onOpenTeam={onOpenTeam}
      />
    );
  }

  const weeks = Array.from({ length: snapshot.week }, (_, index) => snapshot.week - index);

  return (
    <section aria-label={`Week ${week} matchups`}>
      {weeks.length > 0 && (
        <div className="filters">
          <label>
            Week
            <select
              value={week}
              onChange={(event) => {
                setPicked(Number(event.target.value));
                onOpenMatchup(null);
              }}
            >
              {weeks.map((option) => (
                <option key={option} value={option}>
                  {weekLabel(snapshot, option)}
                </option>
              ))}
            </select>
          </label>
          {!current && <span className="quiet">Final scores</span>}
        </div>
      )}

      {past.error && (
        <p className="notice notice-error" role="alert">
          Could not load week {week}: {past.error}
        </p>
      )}
      {!matchups && !past.error && <p className="quiet">Loading week {week}…</p>}
      {matchups && matchups.length === 0 && <p className="quiet">No matchups are scheduled for week {week}.</p>}

      {matchups && matchups.length > 0 && (
        <ul className="matchups">
          {matchups.map((matchup) => {
            const top = Math.max(...matchup.sides.map((side) => side.points));
            const decided = matchup.sides.some((side) => side.points !== top);
            return (
              <li key={matchup.matchupId} className="matchup">
                {matchup.sides.map((side) => {
                  const team = teams.get(side.rosterId);
                  const leading = decided && side.points === top;
                  return (
                    <div key={side.rosterId} className={`matchup-side${leading ? " leading" : ""}`}>
                      <div className="team-cell">
                        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} />
                        <div className="matchup-team">
                          <button
                            type="button"
                            className="team-link"
                            title={team?.teamName}
                            onClick={() => onOpenTeam(side.rosterId)}
                          >
                            {team?.teamName ?? `Roster ${side.rosterId}`}
                          </button>
                          {team && (
                            <span className="quiet manager">
                              {formatRecord(team.wins, team.losses, team.ties)}
                              {side.rosterId === myRosterId && <span className="mine">Your team</span>}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="num matchup-points">
                        {!current && leading && <span className="matchup-won">Won</span>}
                        {formatPoints(side.points)}
                      </span>
                    </div>
                  );
                })}
                <button type="button" className="matchup-open" onClick={() => onOpenMatchup(matchup.matchupId)}>
                  View matchup
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
