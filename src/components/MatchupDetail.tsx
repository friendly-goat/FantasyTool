import { useEffect, useMemo, useState } from "react";
import {
  applyLockMark,
  canMark,
  forecastMatchup,
  foulDeductions,
  gameChances,
  injuryKind,
  isFixed,
  lockAdvice,
  probablyLocked,
  settledPoints,
  slotStatus,
  stillToPlay,
  teamWeek,
  type LockAdvice,
  type SimSlot,
  type SlotStatus,
  type TeamGame,
} from "../../shared/matchup.ts";
import type { StrengthModel } from "../../shared/strength.ts";
import type {
  LeagueSnapshot,
  LockMarkInfo,
  Matchup,
  MatchupSide,
  MatchupSlot,
  Team,
  WeekData,
} from "../../shared/types.ts";
import { getLockMarks, getWeek, setLockMark } from "../api.ts";
import {
  formatAgo,
  formatPoints,
  formatRecord,
  formatStatLine,
  formatTipoff,
  formatWeekRange,
  formatWeekday,
} from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { PositionChip } from "./PositionChip.tsx";
import { TeamLogo } from "./TeamTag.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  canMarkLocks: boolean;
  matchup: Matchup;
  myRosterId: number | null;
  onBack: () => void;
  onOpenTeam: (rosterId: number) => void;
}

const WEEK_REFRESH_MS = 3 * 60_000;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

/** The NBA schedule, box scores and lock marks for the week, refreshed every few minutes while open. */
function useWeek(leagueId: string) {
  const [week, setWeek] = useState<WeekData | null>(null);
  const [marks, setMarks] = useState<LockMarkInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getWeek(leagueId)
        .then((data) => {
          if (cancelled) return;
          setWeek(data);
          setError(null);
        })
        .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
      // Marks are best effort: the view works without them.
      getLockMarks(leagueId)
        .then((data) => !cancelled && setMarks(data.marks))
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, WEEK_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [leagueId]);
  return { week, marks, setMarks, error };
}

/** How a mark stands on one starter, for the card. */
interface MarkView {
  /** What the mark says, when it applies. */
  applied: "locked" | "unlocked" | null;
  /** A mark was made on an earlier score and no longer applies. */
  stale: boolean;
  /** Whether this starter can be marked at all. */
  allowed: boolean;
}

const STATE_LABEL: Record<SlotStatus["state"], string> = {
  locked: "Locked",
  final: "Final",
  open: "Can lock",
  live: "Live",
  waiting: "Yet to play",
  done: "No games left",
  unclear: "Checking",
};

const STATE_NOTE: Record<SlotStatus["state"], string> = {
  locked: "This score is an earlier game this week, so it is locked.",
  final: "His last game of the week is over, so this score is final.",
  open: "This is his latest game. It counts unless he plays again, and can still be locked before his next game.",
  live: "His game is being played.",
  waiting: "He has not played yet this week.",
  done: "He has no games left this week and nothing counted.",
  unclear: "Sleeper's score matches none of his box scores yet; they may still be loading.",
};

const MARKED_NOTE = "You marked this score as locked. Sleeper does not share locks, so the app keeps your word for it.";

const PROBABLE_NOTE =
  "Sleeper does not share locks. This is his latest game and it beats what waiting is expected to bring, so a manager would usually lock it. It becomes certain once his next game starts.";

function StatusIcon({ state }: { state: SlotStatus["state"] }) {
  // Closed lock for settled scores, open lock for one that can still be
  // locked, a dot for a live game, a clock while waiting.
  if (state === "locked" || state === "final") {
    return (
      <svg viewBox="0 0 24 24" className="mx-icon" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    );
  }
  if (state === "open") {
    return (
      <svg viewBox="0 0 24 24" className="mx-icon" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 7.5-2" />
      </svg>
    );
  }
  if (state === "live") return <span className="mx-live-dot" aria-hidden="true" />;
  return (
    <svg viewBox="0 0 24 24" className="mx-icon" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** One game in the week strip: opponent logo, then points if played or the day if not. Selecting it opens the game below. */
function GameChip({
  entry,
  counted,
  selected,
  onSelect,
}: {
  entry: TeamGame;
  counted: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { game, opponent, home, line } = entry;
  const played = game.state !== "scheduled";
  const label = `${home ? "vs" : "at"} ${opponent ?? "?"}, ${formatWeekday(game.date)}${
    line ? `: ${formatPoints(line.points)} points` : game.state === "in_progress" ? ": playing now" : played ? ": did not play" : ""
  }${counted ? ", the game that counts" : ""}`;
  return (
    <li>
      <button
        type="button"
        className={`mx-game${played ? " mx-game-played" : ""}${counted ? " mx-game-counted" : ""}${
          game.state === "in_progress" ? " mx-game-live" : ""
        }${selected ? " mx-game-selected" : ""}`}
        aria-pressed={selected}
        aria-label={label}
        title={label}
        onClick={onSelect}
      >
        <span className="mx-game-logo">
          <TeamLogo team={opponent} fallback={<span className="mx-game-abbr">{opponent ?? "?"}</span>} />
          {!home && <span className="mx-game-at">@</span>}
        </span>
        <span className="mx-game-value">
          {line ? formatPoints(line.points) : game.state === "in_progress" ? "Live" : played ? "DNP" : formatWeekday(game.date)}
        </span>
      </button>
    </li>
  );
}

/** The game picked in the strip: the score and his box score if played, his projection if not. */
function GamePanel({
  entry,
  team,
  counted,
  projected,
  chance,
}: {
  entry: TeamGame;
  team: string | null;
  counted: boolean;
  /** His projected score for one game. */
  projected: number | null;
  /** His chance of playing this game, for games still to come. */
  chance: number | null;
}) {
  const { game, opponent, home, line } = entry;
  const us = team ?? "?";
  const them = opponent ?? "?";
  const ourScore = home ? game.homeScore : game.awayScore;
  const theirScore = home ? game.awayScore : game.homeScore;
  const started = game.state !== "scheduled";
  const matchupText = started && ourScore !== null && theirScore !== null
    ? `${us} ${ourScore} ${home ? "vs" : "@"} ${them} ${theirScore}`
    : `${us} ${home ? "vs" : "@"} ${them}`;
  const when =
    game.state === "final"
      ? (game.statusText ?? "Final")
      : game.state === "in_progress"
        ? (game.statusText ?? "Live")
        : formatTipoff(game.startTime, game.date);

  return (
    <div className={`mx-panel${game.state === "in_progress" ? " mx-panel-live" : ""}`}>
      <div className="mx-panel-head">
        <span className="mx-panel-game">{matchupText}</span>
        <span className="mx-panel-when">{when}</span>
      </div>
      <div className="mx-panel-body">
        <span className="mx-panel-stats">
          {line
            ? formatStatLine(line.stats, line.minutes)
            : game.state === "in_progress"
              ? "No stats yet"
              : started
                ? "Did not play"
                : chance !== null && chance < 0.995
                  ? `Yet to play · ${Math.round(chance * 100)}% chance he plays`
                  : "Yet to play"}
        </span>
        <span className="mx-panel-points">
          {line ? (
            <>
              <strong className="num">{formatPoints(line.points)}</strong>
              <span className="quiet">{counted ? "counts" : line.final ? "fantasy pts" : "so far"}</span>
            </>
          ) : started ? (
            <strong className="num quiet">{game.state === "in_progress" ? "–" : "0.00"}</strong>
          ) : projected !== null ? (
            <>
              <strong className="num">{formatPoints(projected)}</strong>
              <span className="quiet">projected</span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** Which game a card opens on: his live game, else his next game, else his latest. */
function defaultGame(games: TeamGame[]): number {
  const live = games.findIndex((entry) => entry.game.state === "in_progress");
  if (live >= 0) return live;
  const next = games.findIndex((entry) => entry.game.state === "scheduled");
  return next >= 0 ? next : games.length - 1;
}

function PlayerCard({
  entry,
  status,
  projection,
  perGame,
  availability,
  advice,
  probable,
  mark,
  onMark,
  side,
  bench,
}: {
  mark: MarkView | null;
  /** Saves a mark: true locked, false not locked, null clears it. */
  onMark: ((locked: boolean | null) => Promise<void>) | null;
  /** His usual chance of playing a game, for the game panel. */
  availability: number | null;
  entry: MatchupSlot | undefined;
  /** The other manager has probably locked this score (Sleeper does not say). */
  probable: boolean;
  status: SlotStatus | null;
  /** Expected final score for the slot. */
  projection: number | null;
  /** His projected score for one game. */
  perGame: number | null;
  advice: LockAdvice | null;
  side: "left" | "right";
  bench: boolean;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  if (!entry?.player) {
    return (
      <div className={`mx-card mx-${side} mx-empty`}>
        <span className="quiet">Empty slot</span>
      </div>
    );
  }
  const games = status?.games ?? [];
  const next = status?.nextGame ?? null;
  const selected = picked !== null && picked < games.length ? picked : defaultGame(games);
  const upcoming = games.filter((game) => game.game.state === "scheduled");
  const benchPoints = bench ? games.reduce<number | null>((best, game) => (game.line ? Math.max(best ?? 0, game.line.points) : best), null) : null;
  const shown = bench ? benchPoints : entry.points;
  const injury = injuryKind(entry.player.injuryStatus);
  const save = async (locked: boolean | null) => {
    if (!onMark) return;
    setSaving(true);
    setMarkError(null);
    try {
      await onMark(locked);
    } catch (reason) {
      setMarkError(reason instanceof Error ? reason.message : "Could not save the mark.");
    } finally {
      setSaving(false);
    }
  };
  // A settled score needs no projection: it is the final number.
  const settled = !bench && status !== null && (isFixed(status.state) || probable);
  return (
    <div className={`mx-card mx-${side}${status && !bench ? ` mx-${probable ? "probable" : status.state}` : ""}`}>
      <PlayerCell player={entry.player} />
      {!bench && status && (
        <div className="mx-status-row">
          <span
            className="mx-status"
            title={mark?.applied === "locked" ? MARKED_NOTE : probable ? PROBABLE_NOTE : STATE_NOTE[status.state]}
          >
            <StatusIcon state={probable ? "locked" : status.state} />
            {probable ? "Probably locked" : STATE_LABEL[status.state]}
          </span>
          <span
            className={`mx-points num${shown ? "" : " quiet"}`}
            title="The score Sleeper is counting for him right now: his latest game unless one was locked"
          >
            {shown ? formatPoints(shown) : "–"}
          </span>
        </div>
      )}
      {bench && (
        <div className="mx-status-row">
          <span className="mx-status quiet">Bench</span>
          <span className="mx-points num quiet" title="His best game this week. Bench games do not count.">
            {shown !== null ? formatPoints(shown) : "–"}
          </span>
        </div>
      )}
      <div className="mx-next">
        <span>
          {next
            ? `${next.home ? "vs" : "@"} ${next.opponent ?? "?"} · ${formatTipoff(next.game.startTime, next.game.date)}`
            : status?.gamesLeft === 0
              ? "No games left"
              : status?.gamesLeft === null
                ? "Schedule unavailable"
                : ""}
        </span>
        {perGame !== null && next && !settled && (
          <span className="mx-figure" title="His projected score for one game, before any injury">
            Per game <strong>{formatPoints(perGame)}</strong>
          </span>
        )}
      </div>
      {projection !== null && !bench && !settled && (
        <div className="mx-final-row">
          {injury === "out" && next ? (
            <span className="mx-injury">Out: next game counted as missed</span>
          ) : injury === "day-to-day" && next ? (
            <span className="mx-injury">Day-to-day: next game less likely</span>
          ) : (
            <span />
          )}
          <span
            className="mx-figure"
            title="What this slot is expected to end the week with: the score in hand if worth keeping, otherwise his remaining games, locked at the right time"
          >
            Expected final <strong>{formatPoints(projection)}</strong>
          </span>
        </div>
      )}
      {games.length > 0 && (
        <>
          <ol className="mx-games" aria-label="Games this week">
            {games.map((game, index) => (
              <GameChip
                key={game.game.id}
                entry={game}
                counted={!bench && status?.counted === index}
                selected={index === selected}
                onSelect={() => setPicked(index)}
              />
            ))}
          </ol>
          {games[selected] && (
            <GamePanel
              entry={games[selected]!}
              team={entry.player.team}
              counted={!bench && status?.counted === selected}
              projected={perGame}
              chance={(() => {
                const position = upcoming.indexOf(games[selected]!);
                if (position < 0 || availability === null) return null;
                return gameChances(availability, upcoming.length, injury)[position] ?? null;
              })()}
            />
          )}
        </>
      )}
      {!bench && mark && onMark && (mark.allowed || mark.applied || mark.stale) && (
        <div className="mx-mark">
          {mark.applied ? (
            <>
              <span>Marked {mark.applied === "locked" ? "locked" : "not locked"}</span>
              <button type="button" className="mx-mark-button" disabled={saving} onClick={() => void save(null)}>
                Undo
              </button>
            </>
          ) : mark.stale ? (
            <span className="quiet" title="He played again, so the score you marked was not locked.">
              Score changed since your mark
            </span>
          ) : probable ? (
            <>
              <button type="button" className="mx-mark-button" disabled={saving} onClick={() => void save(true)}>
                It is locked
              </button>
              <button type="button" className="mx-mark-button" disabled={saving} onClick={() => void save(false)}>
                Not locked
              </button>
            </>
          ) : (
            <button type="button" className="mx-mark-button" disabled={saving} onClick={() => void save(true)}>
              Mark locked
            </button>
          )}
          {markError && <span className="mx-mark-error">{markError}</span>}
        </div>
      )}
      {advice && (
        <p className={`mx-advice ${advice.lock ? "mx-advice-lock" : "mx-advice-wait"}`}>
          <strong>{advice.lock ? "Lock now" : "Wait"}</strong>{" "}
          {advice.lock
            ? `${formatPoints(advice.current)} beats ${formatPoints(advice.waiting)} expected from waiting.`
            : `${formatPoints(advice.waiting)} expected from waiting beats ${formatPoints(advice.current)}.`}
        </p>
      )}
    </div>
  );
}

function TeamHead({
  team,
  side,
  align,
  chance,
  projected,
  settled,
  probable,
  onOpenTeam,
}: {
  team: Team | undefined;
  side: MatchupSide;
  align: "left" | "right";
  chance: number | null;
  projected: number | null;
  settled: number | null;
  probable: number;
  onOpenTeam: (id: number) => void;
}) {
  const ahead = chance !== null && chance > 0.5;
  return (
    <div className={`mx-team mx-team-${align}`}>
      <div className="mx-team-id">
        <Avatar url={team?.avatarUrl ?? null} name={team?.teamName ?? "?"} size="lg" />
        <div className="mx-team-name">
          <button type="button" className="team-link" title={team?.teamName} onClick={() => onOpenTeam(side.rosterId)}>
            {team?.teamName ?? `Roster ${side.rosterId}`}
          </button>
          {team && <span className="quiet manager">{formatRecord(team.wins, team.losses, team.ties)}</span>}
        </div>
      </div>
      {chance !== null && (
        <div className="mx-chance">
          <span className={`mx-chance-label${ahead ? " up" : ""}`}>{percent.format(chance)} chance to win</span>
          <span className="mx-chance-bar" aria-hidden="true">
            <span className={`mx-chance-fill${ahead ? " ahead" : ""}`} style={{ width: `${chance * 100}%` }} />
          </span>
        </div>
      )}
      <dl className="mx-figures">
        {projected !== null && (
          <div className="mx-figure-main">
            <dt>Expected final</dt>
            <dd className="num">{formatPoints(projected)}</dd>
          </div>
        )}
        {settled !== null && (
          <div>
            <dt>Locked or final</dt>
            <dd className="num">{formatPoints(settled)}</dd>
          </div>
        )}
        {probable > 0 && (
          <div>
            <dt>Probably locked</dt>
            <dd className="num">{formatPoints(probable)}</dd>
          </div>
        )}
        <div>
          <dt>Sleeper's live total</dt>
          <dd className="num">{formatPoints(side.points)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Both lineups of one matchup, slot by slot, with where every starter stands this week. */
export function MatchupDetail({ snapshot, model, canMarkLocks, matchup, myRosterId, onBack, onOpenTeam }: Props) {
  const { week, marks, setMarks, error } = useWeek(snapshot.league.id);
  const markFor = (rosterId: number, playerId: string | undefined) =>
    playerId ? marks.find((mark) => mark.rosterId === rosterId && mark.playerId === playerId) : undefined;
  // Your team on the left, as on Sleeper.
  const sides = [...matchup.sides].sort((a, b) => Number(b.rosterId === myRosterId) - Number(a.rosterId === myRosterId));
  const [left, right] = sides;

  const scheduleKnown = !!week && week.schedule === "ready" && week.games.length > 0;
  const deductions = useMemo(
    () => foulDeductions([snapshot.league.scoringSettings.tf ?? 0, snapshot.league.scoringSettings.ff ?? 0]),
    [snapshot],
  );

  const statusOf = (entry: MatchupSlot | undefined, bench: boolean): SlotStatus | null => {
    if (!week || !entry?.player) return null;
    const games = teamWeek(week.games, entry.player.team, week.lines[entry.player.id] ?? [], scheduleKnown);
    return slotStatus(bench ? 0 : (entry.points ?? 0), games, scheduleKnown, deductions);
  };

  // Each starter's status as the data shows it, then with any mark applied.
  const marked = useMemo(
    () =>
      sides.map((side) =>
        side.starters.map((entry) => {
          const raw = statusOf(entry, false);
          if (!raw) return null;
          const applied = applyLockMark(raw, entry.points ?? 0, markFor(side.rosterId, entry.player?.id));
          return { raw, ...applied };
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [week, matchup, deductions, scheduleKnown, marks],
  );
  const starterStatus = marked.map((side) => side.map((entry) => entry?.status ?? null));

  // Your own locks you know; for the other team, mark scores a manager would
  // usually have locked.
  const probable = sides.map((side, s) =>
    side.starters.map((entry, i) => {
      const status = starterStatus[s]?.[i];
      if (side.rosterId === myRosterId || !status || !model || !entry.player) return false;
      if (marked[s]?.[i]?.marked) return false; // Your word beats the guess.
      return probablyLocked(
        status.state,
        entry.points ?? 0,
        status.gamesLeft,
        model.players.get(entry.player.id) ?? null,
        injuryKind(entry.player.injuryStatus),
      );
    }),
  );

  const forecast = useMemo(() => {
    if (!model || !scheduleKnown || sides.length < 2) return null;
    const simSides = sides.slice(0, 2).map((side, s) =>
      side.starters.map((entry, i): SimSlot => {
        const status = starterStatus[s]![i];
        const player = entry.player ? model.players.get(entry.player.id) : undefined;
        return {
          state: status?.state ?? "done",
          points: entry.points ?? 0,
          gamesLeft: status?.gamesLeft ?? 0,
          player: player ?? null,
          injury: injuryKind(entry.player?.injuryStatus),
        };
      }),
    ) as [SimSlot[], SimSlot[]];
    return forecastMatchup(simSides, 4000, matchup.matchupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, scheduleKnown, starterStatus, matchup]);

  if (!left) return null;
  const team = (side: MatchupSide | undefined) =>
    side ? snapshot.teams.find((candidate) => candidate.rosterId === side.rosterId) : undefined;

  const adviceFor = (sideIndex: number, entry: MatchupSlot | undefined, status: SlotStatus | null): LockAdvice | null => {
    const side = sides[sideIndex];
    if (!model || !side || side.rosterId !== myRosterId || !entry?.player || !status) return null;
    if ((status.state !== "open" && status.state !== "unclear") || !status.gamesLeft) return null;
    const player = model.players.get(entry.player.id);
    return player ? lockAdvice(entry.points ?? 0, status.gamesLeft, player, injuryKind(entry.player.injuryStatus)) : null;
  };

  const yetToPlay = (s: number) =>
    stillToPlay((starterStatus[s] ?? []).map((status, i) => (probable[s]?.[i] ? null : status)));
  const probableTotal = (s: number) =>
    sides[s]?.starters.reduce((sum, entry, i) => sum + (probable[s]?.[i] ? (entry.points ?? 0) : 0), 0) ?? 0;
  const settledTotal = (s: number) =>
    week ? settledPoints(starterStatus[s] ?? [], sides[s]?.starters.map((entry) => entry.points) ?? []) : null;

  const markViewOf = (s: number, index: number, entry: MatchupSlot | undefined): MarkView | null => {
    const info = marked[s]?.[index];
    const side = sides[s];
    if (!info || !side || !entry?.player) return null;
    const mark = markFor(side.rosterId, entry.player.id);
    return {
      applied: info.marked && mark ? (mark.locked ? "locked" : "unlocked") : null,
      stale: info.stale,
      allowed: canMark(info.raw.state, entry.points ?? 0),
    };
  };
  const onMarkFor = (s: number, entry: MatchupSlot | undefined) => {
    const side = sides[s];
    if (!canMarkLocks || !side || !entry?.player) return null;
    const playerId = entry.player.id;
    return async (locked: boolean | null) => {
      const result = await setLockMark(snapshot.league.id, side.rosterId, playerId, locked);
      setMarks(result.marks);
    };
  };

  const perGameOf = (entry: MatchupSlot | undefined) =>
    entry?.player && model ? (model.players.get(entry.player.id)?.projected ?? null) : null;

  const availabilityOf = (entry: MatchupSlot | undefined) =>
    entry?.player && model ? (model.players.get(entry.player.id)?.availability ?? null) : null;

  const rows = (pick: (side: MatchupSide) => MatchupSlot[]) => {
    const a = pick(left);
    const b = right ? pick(right) : [];
    return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => ({
      index,
      left: a[index],
      right: b[index],
      slot: a[index]?.slot ?? b[index]?.slot ?? "",
    }));
  };

  return (
    <section aria-label={`Week ${snapshot.week} matchup`}>
      <button type="button" className="button button-plain back-button" onClick={onBack}>
        All matchups
      </button>

      <div className="card mx">
        <div className="mx-head">
          <TeamHead
            team={team(left)}
            side={left}
            align="left"
            chance={forecast?.winChance[0] ?? null}
            projected={forecast?.projected[0] ?? null}
            settled={settledTotal(0)}
            probable={probableTotal(0)}
            onOpenTeam={onOpenTeam}
          />
          <span className="mx-vs">vs</span>
          {right ? (
            <TeamHead
              team={team(right)}
              side={right}
              align="right"
              chance={forecast?.winChance[1] ?? null}
              projected={forecast?.projected[1] ?? null}
              settled={settledTotal(1)}
              probable={probableTotal(1)}
              onOpenTeam={onOpenTeam}
            />
          ) : (
            <div className="mx-team" />
          )}
        </div>

        <div className="mx-strip">
          <span className="quiet">Yet to play ({yetToPlay(0)})</span>
          <span className="mx-week">
            Week {snapshot.week}
            {week && <span className="quiet"> · {formatWeekRange(week.start, week.end)}</span>}
          </span>
          <span className="quiet">Yet to play ({yetToPlay(1)})</span>
        </div>

        <details className="mx-help">
          <summary>What these numbers mean</summary>
          <dl>
            <div>
              <dt>Expected final</dt>
              <dd>
                Where each team should end the week. Locked and final scores stay; every other starter plays his remaining
                games and locks a score when it beats what waiting is expected to bring. Your opponent is assumed to lock
                the same way.
              </dd>
            </div>
            <div>
              <dt>Locked or final</dt>
              <dd>
                Scores we can tell are settled: an earlier game this week (so it was locked), or his last game of the week.
                Sleeper's data does not say which scores are locked, so a score from a player's latest game, with games
                still to come, is not counted here even if it is locked.
              </dd>
            </div>
            <div>
              <dt>Probably locked</dt>
              <dd>
                For the other team: latest-game scores that beat what waiting is expected to bring, so a manager would
                usually have locked them. It becomes certain when the player's next game starts: if the score stays, it
                was locked. Your own locks you know, so your side never shows this. The admin can mark a score locked or
                not locked to correct this; a mark stops applying if the player's score changes.
              </dd>
            </div>
            <div>
              <dt>Sleeper's live total</dt>
              <dd>
                The total Sleeper reports: each starter's latest game, locked or not. It drops or rises as players play
                again, so mid-week it is not a real score.
              </dd>
            </div>
            <div>
              <dt>Per game</dt>
              <dd>His projected score for one game, from his season, recent form and last season.</dd>
            </div>
            <div>
              <dt>Chance to win</dt>
              <dd>
                The share of 4,000 played-out weeks each team wins. Injury tags count: out means he misses his next game
                and is half as likely to play later this week; day-to-day makes his next game 40% less likely.
              </dd>
            </div>
            <div>
              <dt>Yet to play</dt>
              <dd>Starters whose score is not settled and who still have a game this week, as Sleeper counts them.</dd>
            </div>
          </dl>
        </details>

        {error && (
          <p className="notice notice-error" role="alert">
            Could not load this week's games: {error}
          </p>
        )}
        {week && week.schedule === "unavailable" && (
          <p className="notice">
            {week.scheduleMessage ?? "The NBA schedule is not available."} Locks are still spotted from box scores, but
            games left, lock advice and win chances need the schedule.
          </p>
        )}
        {!week && !error && <p className="quiet">Loading this week's games…</p>}

        {[
          { title: "Starters", rows: rows((side) => side.starters), bench: false },
          { title: "Bench", rows: rows((side) => side.bench), bench: true },
        ]
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <div key={group.title}>
              <h3 className="panel-heading">{group.title}</h3>
              <ul className="mx-rows">
                {group.rows.map((row) => {
                  const leftStatus = group.bench ? statusOf(row.left, true) : (starterStatus[0]?.[row.index] ?? null);
                  const rightStatus = group.bench ? statusOf(row.right, true) : (starterStatus[1]?.[row.index] ?? null);
                  return (
                    <li key={row.index} className="mx-row">
                      <PlayerCard
                        entry={row.left}
                        status={leftStatus}
                        projection={group.bench ? null : (forecast?.slotProjections[0][row.index] ?? null)}
                        perGame={perGameOf(row.left)}
                        availability={availabilityOf(row.left)}
                        advice={group.bench ? null : adviceFor(0, row.left, leftStatus)}
                        probable={!group.bench && (probable[0]?.[row.index] ?? false)}
                        mark={group.bench ? null : markViewOf(0, row.index, row.left)}
                        onMark={group.bench ? null : onMarkFor(0, row.left)}
                        side="left"
                        bench={group.bench}
                      />
                      <div className="mx-slot">
                        <PositionChip label={row.slot} />
                      </div>
                      <PlayerCard
                        entry={row.right}
                        status={rightStatus}
                        projection={group.bench ? null : (forecast?.slotProjections[1][row.index] ?? null)}
                        perGame={perGameOf(row.right)}
                        availability={availabilityOf(row.right)}
                        advice={group.bench ? null : adviceFor(1, row.right, rightStatus)}
                        probable={!group.bench && (probable[1]?.[row.index] ?? false)}
                        mark={group.bench ? null : markViewOf(1, row.index, row.right)}
                        onMark={group.bench ? null : onMarkFor(1, row.right)}
                        side="right"
                        bench={group.bench}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

        <p className="quiet legend">
          {week?.linesSyncedAt && `Box scores updated ${formatAgo(week.linesSyncedAt)}. `}Sleeper's scores update on their own: every couple of minutes while games are on.
        </p>
      </div>
    </section>
  );
}
