import { useEffect, useMemo, useState } from "react";
import {
  forecastMatchup,
  foulDeductions,
  injuryKind,
  isFixed,
  lockAdvice,
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
import type { LeagueSnapshot, Matchup, MatchupSide, MatchupSlot, Team, WeekData } from "../../shared/types.ts";
import { getWeek } from "../api.ts";
import { formatAgo, formatPoints, formatRecord, formatTipoff, formatWeekRange, formatWeekday } from "../format.ts";
import { Avatar } from "./Avatar.tsx";
import { PlayerCell } from "./PlayerCell.tsx";
import { PositionChip } from "./PositionChip.tsx";
import { TeamLogo } from "./TeamTag.tsx";

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  matchup: Matchup;
  myRosterId: number | null;
  onBack: () => void;
  onOpenTeam: (rosterId: number) => void;
}

const WEEK_REFRESH_MS = 3 * 60_000;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

/** The NBA schedule and box scores for the week, refreshed every few minutes while open. */
function useWeek(leagueId: string) {
  const [week, setWeek] = useState<WeekData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getWeek(leagueId)
        .then((data) => {
          if (cancelled) return;
          setWeek(data);
          setError(null);
        })
        .catch((reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)));
    void load();
    const timer = window.setInterval(load, WEEK_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [leagueId]);
  return { week, error };
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

/** One game in the week strip: opponent logo, then points if played or the day if not. */
function GameChip({ entry, counted }: { entry: TeamGame; counted: boolean }) {
  const { game, opponent, home, line } = entry;
  const played = game.state !== "scheduled";
  const label = `${home ? "vs" : "at"} ${opponent ?? "?"}, ${formatWeekday(game.date)}${
    played ? `: ${line ? `${formatPoints(line.points)} points` : "did not play"}` : ""
  }${counted ? ", the game that counts" : ""}`;
  return (
    <li
      className={`mx-game${played ? " mx-game-played" : ""}${counted ? " mx-game-counted" : ""}${
        game.state === "in_progress" ? " mx-game-live" : ""
      }`}
      title={label}
    >
      <span className="mx-game-logo">
        <TeamLogo team={opponent} fallback={<span className="mx-game-abbr">{opponent ?? "?"}</span>} />
        {!home && <span className="mx-game-at">@</span>}
      </span>
      <span className="mx-game-value">
        {played ? (line ? formatPoints(line.points) : "DNP") : formatWeekday(game.date)}
      </span>
      <span className="visually-hidden">{label}</span>
    </li>
  );
}

function PlayerCard({
  entry,
  status,
  projection,
  perGame,
  advice,
  side,
  bench,
}: {
  entry: MatchupSlot | undefined;
  status: SlotStatus | null;
  /** Expected final score for the slot. */
  projection: number | null;
  /** His projected score for one game. */
  perGame: number | null;
  advice: LockAdvice | null;
  side: "left" | "right";
  bench: boolean;
}) {
  if (!entry?.player) {
    return (
      <div className={`mx-card mx-${side} mx-empty`}>
        <span className="quiet">Empty slot</span>
      </div>
    );
  }
  const games = status?.games ?? [];
  const next = status?.nextGame ?? null;
  const benchPoints = bench ? games.reduce<number | null>((best, game) => (game.line ? Math.max(best ?? 0, game.line.points) : best), null) : null;
  const shown = bench ? benchPoints : entry.points;
  const injury = injuryKind(entry.player.injuryStatus);
  // A settled score needs no projection: it is the final number.
  const settled = !bench && status !== null && isFixed(status.state);
  return (
    <div className={`mx-card mx-${side}${status && !bench ? ` mx-${status.state}` : ""}`}>
      <PlayerCell player={entry.player} />
      {!bench && status && (
        <div className="mx-status-row">
          <span className="mx-status" title={STATE_NOTE[status.state]}>
            <StatusIcon state={status.state} />
            {STATE_LABEL[status.state]}
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
        <ol className="mx-games" aria-label="Games this week">
          {games.map((game, index) => (
            <GameChip key={game.game.id} entry={game} counted={!bench && status?.counted === index} />
          ))}
        </ol>
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
  onOpenTeam,
}: {
  team: Team | undefined;
  side: MatchupSide;
  align: "left" | "right";
  chance: number | null;
  projected: number | null;
  settled: number | null;
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
        <div>
          <dt>Sleeper's live total</dt>
          <dd className="num">{formatPoints(side.points)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Both lineups of one matchup, slot by slot, with where every starter stands this week. */
export function MatchupDetail({ snapshot, model, matchup, myRosterId, onBack, onOpenTeam }: Props) {
  const { week, error } = useWeek(snapshot.league.id);
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

  const starterStatus = useMemo(
    () => sides.map((side) => side.starters.map((entry) => statusOf(entry, false))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [week, matchup, deductions, scheduleKnown],
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

  const yetToPlay = (s: number) => stillToPlay(starterStatus[s] ?? []);
  const settledTotal = (s: number) =>
    week ? settledPoints(starterStatus[s] ?? [], sides[s]?.starters.map((entry) => entry.points) ?? []) : null;

  const perGameOf = (entry: MatchupSlot | undefined) =>
    entry?.player && model ? (model.players.get(entry.player.id)?.projected ?? null) : null;

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
                A score from a player's latest game with games still to come may also be locked; Sleeper does not share
                that, so it is not counted here. Sleeper's own app shows locked totals that include those.
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
                        advice={group.bench ? null : adviceFor(0, row.left, leftStatus)}
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
                        advice={group.bench ? null : adviceFor(1, row.right, rightStatus)}
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
          {week?.linesSyncedAt && `Box scores updated ${formatAgo(week.linesSyncedAt)}. `}Sleeper's scores update when you
          press Refresh.
        </p>
      </div>
    </section>
  );
}
