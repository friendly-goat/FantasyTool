import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { draftTrends, type DraftTrend } from "../../shared/draft.ts";
import type { ModelPlayer, StrengthModel } from "../../shared/strength.ts";
import { INJURED_SHARE } from "../../shared/trade.ts";
import type { DraftBoard, DraftSelection, LeagueSnapshot } from "../../shared/types.ts";
import { getDraft } from "../api.ts";
import { formatDay, ordinal } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerButton } from "./PlayerName.tsx";
import { TeamTag } from "./TeamTag.tsx";

interface Props {
  leagueId: string;
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  myRosterId: number;
}

/** A small rising or falling chart line. */
export function TrendIcon({ trend }: { trend: "up" | "down" }) {
  const line = trend === "up" ? "3 17 9 11 13 15 21 7" : "3 7 9 13 13 9 21 17";
  const arrow = trend === "up" ? "15 7 21 7 21 13" : "15 17 21 17 21 11";
  return (
    <svg className={`trend-icon trend-${trend}`} viewBox="0 0 24 24" aria-hidden="true">
      <polyline points={line} />
      <polyline points={arrow} />
    </svg>
  );
}

/** A medical cross, for a player out long enough to matter (not a game or two). */
export function InjuryIcon() {
  return (
    <svg className="injury-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M12 7.5v9M7.5 12h9" />
    </svg>
  );
}

/** The model's injured players: out at least INJURED_SHARE of the weeks left, the same line the trade search uses. */
function injuryOf(model: StrengthModel | null, id: string): ModelPlayer | null {
  const player = model?.players.get(id);
  return player && player.outShare >= INJURED_SHARE ? player : null;
}

function injuryLabel(player: ModelPlayer, status: string | null | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  const what = status ? `Injured (${status})` : "Injured";
  if (player.outShare >= 0.95) return `${what}, expected to miss the rest of the season.`;
  return player.returnExpected
    ? `${what}, predicted back around ${formatDay(player.returnExpected, today)}.`
    : `${what}, no predicted return date.`;
}

function trendLabel(pick: DraftSelection, trend: DraftTrend): string {
  const where = `Taken with pick ${pick.pickNo}. By weekly value now he ranks ${ordinal(trend.valueRank)} among drafted players`;
  if (trend.trend === "up") return `${where}, at least a round earlier than he went.`;
  if (trend.trend === "down") return `${where}, at least a round later than he went.`;
  return `${where}.`;
}

function splitName(name: string): [string, string] {
  const space = name.indexOf(" ");
  return space > 0 ? [name.slice(0, space), name.slice(space + 1)] : ["", name];
}

/** One pick. The whole card opens the player's details. */
function DraftCard({
  pick,
  trend,
  injury,
  pickedBy,
}: {
  pick: DraftSelection;
  trend: DraftTrend | undefined;
  injury: ModelPlayer | null;
  pickedBy: string | null;
}) {
  const positions = pick.player.positions.length > 0 ? pick.player.positions : ["?"];
  const trendText = trend?.trend ? trendLabel(pick, trend) : undefined;
  const injuryText = injury ? injuryLabel(injury, pick.player.injuryStatus) : undefined;
  const label = [injuryText, trendText].filter(Boolean).join(" ") || undefined;
  const [first, last] = splitName(pick.player.name);
  return (
    <PlayerButton player={pick.player} className="draft-card">
      <span className="draft-card-body">
        <span className="draft-card-top">
          <span className="draft-pick">
            {pick.round}.{pick.pickInRound}
          </span>
          {(injury || trend?.trend) && (
            <span className="draft-marks">
              {injury && (
                <span className="draft-injury" title={injuryText}>
                  <InjuryIcon />
                </span>
              )}
              {trend?.trend && (
                <span className="draft-trend" title={trendText}>
                  <TrendIcon trend={trend.trend} />
                </span>
              )}
            </span>
          )}
        </span>
        <span className="draft-name">
          {first && <span className="name-first">{first}</span>}
          <span className="name-last">{last}</span>
        </span>
        <span className="draft-card-meta">
          <TeamTag team={pick.player.team} empty="No team" />
          {pick.keeper && <span className="draft-note">Keeper</span>}
        </span>
        {pickedBy && <span className="draft-note">Picked by {pickedBy}</span>}
        {label && <span className="visually-hidden">{label}</span>}
      </span>
      <span className="draft-bands">
        {positions.map((position) => (
          <span key={position} className={`draft-band chip-${position.toLowerCase()}`}>
            {position}
          </span>
        ))}
      </span>
    </PlayerButton>
  );
}

export function Draft({ leagueId, snapshot, model, myRosterId }: Props) {
  const [board, setBoard] = useState<DraftBoard | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBoard(undefined);
    setError(null);
    getDraft(leagueId)
      .then((result) => !cancelled && setBoard(result.board))
      .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const trends = useMemo(() => {
    if (!board || !model) return new Map<number, DraftTrend>();
    return draftTrends(board.picks, (id) => model.players.get(id)?.expected ?? null, board.teams);
  }, [board, model]);

  if (error) {
    return (
      <p className="notice notice-error" role="alert">
        Could not load the draft: {error}
      </p>
    );
  }
  if (board === undefined) return <p className="quiet">Loading the draft…</p>;
  if (board === null) return <p className="notice">This league has no draft on Sleeper.</p>;
  if (board.type === "auction") {
    return <p className="notice">This league drafted by auction, so there is no pick-by-pick board to show.</p>;
  }

  const teamOf = (rosterId: number | null) => snapshot.teams.find((team) => team.rosterId === rosterId);
  const cell = new Map(board.picks.map((pick) => [`${pick.round}-${pick.slot}`, pick]));
  const rounds = Array.from({ length: board.rounds }, (_, index) => index + 1);
  const ups = [...trends.values()].filter((trend) => trend.trend === "up").length;
  const downs = [...trends.values()].filter((trend) => trend.trend === "down").length;
  const hurt = board.picks.filter((pick) => injuryOf(model, pick.player.id)).length;

  return (
    <section aria-label="Draft board">
      <p className="quiet draft-summary">
        {board.type === "snake" ? "Snake draft" : board.type === "linear" ? "Linear draft" : "Draft"}, {board.rounds}{" "}
        rounds, {board.teams} teams{board.status !== "complete" ? " (still in progress)" : ""}.
      </p>
      <div className="draft-scroll" tabIndex={0} aria-label="Draft board, scrolls sideways">
        <div className="draft-grid" style={{ "--draft-teams": board.teams } as CSSProperties}>
          {board.slots.map(({ slot, rosterId }) => {
            const team = teamOf(rosterId);
            const mine = rosterId === myRosterId;
            return (
              <div key={`head-${slot}`} className={mine ? "draft-head draft-head-mine" : "draft-head"}>
                <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? `Slot ${slot}`} size="sm" />
                <span className="draft-head-name">{team?.teamName ?? `Slot ${slot}`}</span>
                {mine && <span className="mine">You</span>}
              </div>
            );
          })}
          {rounds.flatMap((round) =>
            board.slots.map(({ slot, rosterId }) => {
              const pick = cell.get(`${round}-${slot}`);
              if (!pick)
                return <div key={`${round}-${slot}`} className="draft-card draft-card-empty" aria-hidden="true" />;
              const pickedBy =
                pick.rosterId !== null && rosterId !== null && pick.rosterId !== rosterId
                  ? (teamOf(pick.rosterId)?.teamName ?? null)
                  : null;
              return (
                <DraftCard
                  key={`${round}-${slot}`}
                  pick={pick}
                  trend={trends.get(pick.pickNo)}
                  injury={injuryOf(model, pick.player.id)}
                  pickedBy={pickedBy}
                />
              );
            }),
          )}
        </div>
      </div>
      <p className="quiet legend draft-legend">
        <span className="draft-legend-item">
          <TrendIcon trend="up" /> Worth at least a round earlier now ({ups})
        </span>
        <span className="draft-legend-item">
          <TrendIcon trend="down" /> Worth at least a round later now ({downs})
        </span>
        {model && (
          <span className="draft-legend-item">
            <InjuryIcon /> Injured, out more than a game or two ({hurt})
          </span>
        )}
      </p>
      <p className="quiet legend">
        {model
          ? "Marks compare where each player was picked with where his weekly value now (what he locks in an average week at his projected level, allowing for missed games) ranks among everyone drafted. Within a round either way shows no mark. An injured player's value already allows for the games he will miss, which is often why he is falling. Hover over a mark for the numbers, or select a card for the player's details."
          : "Marks for players beating or missing their draft spot appear once player stats have loaded."}
      </p>
    </section>
  );
}
