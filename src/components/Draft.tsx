import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { type DraftGrade, draftGrades, GRADE_LETTERS, type GradeLetter } from "../../shared/draft.ts";
import type { ModelPlayer, StrengthModel } from "../../shared/strength.ts";
import { INJURED_SHARE } from "../../shared/trade.ts";
import type { DraftBoard, DraftSelection, LeagueSnapshot } from "../../shared/types.ts";
import { getDraft } from "../api.ts";
import { formatDay, formatPoints } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerButton } from "./PlayerName.tsx";
import { TeamTag } from "./TeamTag.tsx";

interface Props {
  leagueId: string;
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  myRosterId: number;
}

/** A pick's letter grade (F to S), colored red to green with S in gold. */
export function GradeBadge({ letter, grade }: { letter: GradeLetter; grade: string }) {
  return (
    <span className={`grade-badge grade-${letter.toLowerCase()}`} aria-hidden="true">
      {grade.replace("-", "\u2212")}
    </span>
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

function gradeLabel(pick: DraftSelection, grade: DraftGrade): string {
  return `Taken with pick ${pick.pickNo}, grade ${grade.grade}: weekly value now ${formatPoints(grade.value)}, against ${formatPoints(grade.around)} for the players picked around him.`;
}

function splitName(name: string): [string, string] {
  const space = name.indexOf(" ");
  return space > 0 ? [name.slice(0, space), name.slice(space + 1)] : ["", name];
}

/** One pick. The whole card opens the player's details. */
function DraftCard({
  pick,
  grade,
  injury,
  pickedBy,
}: {
  pick: DraftSelection;
  grade: DraftGrade | undefined;
  injury: ModelPlayer | null;
  pickedBy: string | null;
}) {
  const positions = pick.player.positions.length > 0 ? pick.player.positions : ["?"];
  // One mark per card: the injury, or else the grade (an injured player is not graded).
  const injuryText = injury ? injuryLabel(injury, pick.player.injuryStatus) : undefined;
  const gradeText = !injury && grade ? gradeLabel(pick, grade) : undefined;
  const label = injuryText ?? gradeText;
  const [first, last] = splitName(pick.player.name);
  return (
    <PlayerButton player={pick.player} className="draft-card">
      <span className="draft-card-body">
        <span className="draft-card-top">
          <span className="draft-pick">
            {pick.round}.{pick.pickInRound}
          </span>
          {injury ? (
            <span className="draft-mark" title={injuryText}>
              <InjuryIcon />
            </span>
          ) : (
            grade && (
              <span className="draft-mark" title={gradeText}>
                <GradeBadge letter={grade.letter} grade={grade.grade} />
              </span>
            )
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

  const grades = useMemo(() => {
    if (!board || !model) return new Map<number, DraftGrade>();
    // Injured players are left out: their value counts the games they will miss.
    return draftGrades(board.picks, (id) => (injuryOf(model, id) ? null : (model.players.get(id)?.expected ?? null)), board.teams);
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
                  grade={grades.get(pick.pickNo)}
                  injury={injuryOf(model, pick.player.id)}
                  pickedBy={pickedBy}
                />
              );
            }),
          )}
        </div>
      </div>
      {model && (
        <p className="quiet legend draft-legend">
          <span className="draft-legend-item" aria-label="Grades from F, worst, to S, best">
            {GRADE_LETTERS.map((letter) => (
              <GradeBadge key={letter} letter={letter} grade={letter} />
            ))}
          </span>
          <span className="draft-legend-item">
            <InjuryIcon /> Injured, out more than a game or two, not graded ({hurt})
          </span>
        </p>
      )}
      <p className="quiet legend">
        {model
          ? "Each pick is graded on his weekly value now (what he locks in an average week at his projected level, allowing for missed games) against the players picked around him, the nearest round of picks. C is about what that part of the draft turned into; B, A and then S, in gold, are better by more each step, and D and F worse. An injured player is not graded, since his value counts the games he will miss. Hover over a grade for the numbers, or select a card for the player's details."
          : "Grades for each pick appear once player stats have loaded."}
      </p>
    </section>
  );
}
