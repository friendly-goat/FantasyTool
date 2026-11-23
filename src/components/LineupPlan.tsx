import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LineupPlan as Plan, type Move, planLineup, type PlanStep, type PlayerInput, waitWorthOf } from "../../shared/lineupPlan.ts";
import { planForecast, planInputs, simSlots } from "../../shared/lineupInputs.ts";
import { applyLockMark, foulDeductions, slotStatus, type SlotStatus, teamWeek } from "../../shared/matchup.ts";
import type { StrengthModel } from "../../shared/strength.ts";
import type { LeagueSnapshot, LivePlanData, MatchupSide, PlayerRef } from "../../shared/types.ts";
import { getPlan, setLockMark } from "../api.ts";
import { formatPoints } from "../format.ts";
import { readSaved, savedKeys, writeSaved } from "../saved.ts";
import { PlayerName } from "./PlayerName.tsx";
import { PositionChip } from "./PositionChip.tsx";

// Experimental (admin only): what to lock, start and bench for the rest of the
// week (shared/lineupPlan.ts), on data as fresh as the server has it. It asks
// again as often as the moment needs (every 20 seconds while games are on),
// shows when each kind of data was brought up to date, and warns when the
// scores lag behind.

interface Props {
  snapshot: LeagueSnapshot;
  model: StrengthModel | null;
  myRosterId: number;
  /** Whether lock marks can be saved (admin). */
  canMark: boolean;
}

/** Scores older than this while games are on get a warning. */
const LAG_WARN_MS = 3 * 60_000;
const QUIET_POLL_MS = 5 * 60_000;

/** The plan's data, saved copy first, asked again as often as the server says. */
function usePlanData(leagueId: string, rosterId: number) {
  const [data, setData] = useState<LivePlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pollMs = useRef(QUIET_POLL_MS);

  const load = useCallback(async () => {
    window.clearTimeout(timer.current);
    try {
      const next = await getPlan(leagueId, rosterId);
      setData(next);
      setError(null);
      setFetchedAt(Date.now());
      pollMs.current = next.pollMs;
      void writeSaved(savedKeys.plan(leagueId, rosterId), next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The plan's data could not be loaded.");
    } finally {
      if (document.visibilityState === "visible") timer.current = window.setTimeout(() => void load(), pollMs.current);
    }
  }, [leagueId, rosterId]);

  useEffect(() => {
    let cancelled = false;
    void readSaved<LivePlanData>(savedKeys.plan(leagueId, rosterId)).then((saved) => {
      if (!cancelled && saved) setData((current) => current ?? saved);
    });
    void load();
    // Hidden: no asking. Back in view: ask at once (a lineup is often checked just before a tip-off).
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
      else window.clearTimeout(timer.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [leagueId, rosterId, load]);

  return { data, error, fetchedAt, reload: load };
}

/** The time now, moved on every half minute (so "now" and "later" follow the clock). */
function useNow(stepMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(id);
  }, [stepMs]);
  return now;
}

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const dayKey = (ms: number) => new Date(ms).toDateString();

function dayLabel(ms: number, now: number): string {
  if (dayKey(ms) === dayKey(now)) return "Later today";
  if (dayKey(ms) === dayKey(now + 86_400_000)) return "Tomorrow";
  return weekday.format(ms);
}

interface Built {
  mine: MatchupSide;
  theirs: MatchupSide | null;
  statuses: (SlotStatus | null)[];
  plan: Plan;
  players: PlayerInput[];
  names: Map<string, PlayerRef>;
  forecast: { yours: number; theirs: number; winChance: number } | null;
}

function build(data: LivePlanData, snapshot: LeagueSnapshot, model: StrengthModel, rosterId: number, now: number): Built | null {
  const matchup = data.matchup;
  const mine = matchup?.sides.find((side) => side.rosterId === rosterId);
  if (!matchup || !mine) return null;
  const theirs = matchup.sides.find((side) => side.rosterId !== rosterId) ?? null;
  const scheduleKnown = data.week.schedule === "ready" && data.week.games.length > 0;
  const deductions = foulDeductions([snapshot.league.scoringSettings.tf ?? 0, snapshot.league.scoringSettings.ff ?? 0]);
  const statusesOf = (side: MatchupSide) =>
    side.starters.map((entry) => {
      if (!entry.player) return null;
      const lines = data.week.lines[entry.player.id] ?? [];
      const team = lines[lines.length - 1]?.team ?? entry.player.team;
      const raw = slotStatus(entry.points ?? 0, teamWeek(data.week.games, team, lines, scheduleKnown), scheduleKnown, deductions);
      const mark = data.marks.find((candidate) => candidate.rosterId === side.rosterId && candidate.playerId === entry.player!.id);
      return applyLockMark(raw, entry.points ?? 0, mark).status;
    });
  const statuses = statusesOf(mine);
  const { lanes, players } = planInputs({
    side: mine,
    statuses,
    games: data.week.games,
    lines: data.week.lines,
    model,
    injuries: data.injuries,
    reserve: new Set(data.reserve),
    now,
  });
  const plan = planLineup(lanes, players, now);
  const names = new Map<string, PlayerRef>();
  for (const side of matchup.sides) {
    for (const entry of [...side.starters, ...side.bench]) if (entry.player) names.set(entry.player.id, entry.player);
  }
  const forecast = theirs ? planForecast(plan, players, simSlots(theirs, statusesOf(theirs), model), 2000, matchup.matchupId) : null;
  return { mine, theirs, statuses, plan, players, names, forecast };
}

/** A player by ID, as a name that opens his card. */
function Who({ id, names }: { id: string | null; names: Map<string, PlayerRef> }) {
  const player = id ? names.get(id) : undefined;
  if (!player) return <span className="quiet">nobody</span>;
  return <PlayerName player={player} />;
}

function Tag({ kind }: { kind: "lock" | "swap" | "start" | "move" | "bench" | "keep" | "pass" | "live" }) {
  const label = { lock: "Lock", swap: "Swap", start: "Start", move: "Move", bench: "Bench", keep: "Keep", pass: "Don't lock", live: "Live" }[kind];
  return <span className={`plan-tag plan-tag-${kind}`}>{label}</span>;
}

function MoveLine({ move, slots, names }: { move: Move; slots: string[]; names: Map<string, PlayerRef> }) {
  const slot = (index: number | null) => (index === null ? null : <PositionChip label={slots[index] ?? "?"} />);
  if (move.kind === "swap") {
    return (
      <li className="plan-move">
        <Tag kind="swap" />
        <span>
          <Who id={move.playerId} names={names} /> {slot(move.otherSlot)} with <Who id={move.otherId} names={names} /> {slot(move.slot)}
        </span>
      </li>
    );
  }
  if (move.kind === "bench") {
    return (
      <li className="plan-move">
        <Tag kind="bench" />
        <span>
          <Who id={move.playerId} names={names} /> {slot(move.slot)}, leaving it empty
        </span>
      </li>
    );
  }
  return (
    <li className="plan-move">
      <Tag kind={move.kind} />
      <span>
        <Who id={move.playerId} names={names} /> in {slot(move.slot)}
        {move.kind === "move" && move.otherSlot !== null && <> (from {slot(move.otherSlot)})</>}
        {move.otherId && (
          <>
            {" "}
            and bench <Who id={move.otherId} names={names} />
          </>
        )}
      </span>
    </li>
  );
}

function StepCard({
  step,
  number,
  slots,
  names,
  now,
}: {
  step: PlanStep;
  number: number;
  slots: string[];
  names: Map<string, PlayerRef>;
  now: number;
}) {
  const soon = step.by - now < 60 * 60_000;
  return (
    <li className="plan-step">
      <span className="plan-step-number" aria-hidden="true">
        {number}
      </span>
      <div className="plan-step-body">
        <p className="plan-step-when">
          Before {clock.format(step.by)}
          {step.forPlayers.length > 0 && (
            <>
              {" "}
              for{" "}
              {step.forPlayers.map((id, index) => (
                <span key={id}>
                  {index > 0 && (index === step.forPlayers.length - 1 ? " and " : ", ")}
                  <Who id={id} names={names} />
                </span>
              ))}
              's tip-off
            </>
          )}
          {soon && <span className="plan-soon">soon</span>}
        </p>
        <ul className="plan-moves">
          {step.moves.map((move, index) => (
            <MoveLine key={index} move={move} slots={slots} names={names} />
          ))}
        </ul>
        {step.unless.length > 0 && (
          <ul className="plan-step-if quiet">
            {step.unless.map((entry) => (
              <li key={`${entry.lane}-${entry.playerId}`}>
                If <Who id={entry.playerId} names={names} /> finishes with {formatPoints(entry.lockAt)} or more, lock him in{" "}
                <PositionChip label={slots[entry.lane] ?? "?"} /> instead and leave that slot as it is.
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** Why a score in hand is left unlocked, in the plan's own numbers. */
function passReason(lane: Plan["lanes"][number], waiting: number): string {
  const ahead = lane.passBy !== null && lane.passBy >= 0.05 ? ` The plan comes out about ${formatPoints(lane.passBy)} ahead without the lock.` : "";
  if (lane.holderPlays && waiting >= lane.points) return `Playing on is worth about ${formatPoints(waiting)}, more than this.${ahead}`;
  if (lane.holderPlays) return `He plays on in another slot, and the games planned here are worth about ${formatPoints(lane.ahead)}.${ahead}`;
  return `The games planned in this slot are worth about ${formatPoints(lane.ahead)}, more than this.${ahead}`;
}

/** Why a score is worth locking, in the plan's own numbers. */
function lockReason(lock: Plan["locks"][number], games: number): string {
  const moved = lock.swapWith ? " Moving him first frees his slot for someone still to play." : "";
  if (games === 0) return `His last game of the week.${moved || " Nothing still to play beats it."}`;
  const gamesText = games === 1 ? "his last game" : `his ${games} games left`;
  const gainText = lock.gain >= 0.05 ? ` Locking adds about ${formatPoints(lock.gain)} to your expected total.` : "";
  if (lock.worth < lock.points) {
    return `Waiting on ${gamesText} is worth about ${formatPoints(lock.worth)}, less than this.${moved}${gainText} Lock before his next game.`;
  }
  return `Waiting on ${gamesText} is worth about ${formatPoints(lock.worth)}, but his slot does more with other players' games.${moved}${gainText} Lock before his next game.`;
}

const STATE_TEXT: Record<string, string> = {
  fixed: "Locked",
  lock: "Lock it",
  keep: "Final",
  pass: "In hand",
  live: "Playing",
  open: "To play",
};

export function LineupPlan({ snapshot, model, myRosterId, canMark }: Props) {
  const leagueId = snapshot.league.id;
  const { data, error, fetchedAt, reload } = usePlanData(leagueId, myRosterId);
  const now = useNow();
  const [saving, setSaving] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);

  // The plan runs on the server's clock (moved on by the time since it answered), so a phone
  // whose clock is off still plans around the real tip-offs.
  const planNow = data && fetchedAt ? Date.parse(data.now) + Math.max(0, now - fetchedAt) : now;
  const built = useMemo(
    () => (data && model ? build(data, snapshot, model, myRosterId, planNow) : null),
    // planNow moves with now and fetchedAt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, model, snapshot, myRosterId, now, fetchedAt],
  );

  async function markLocked(playerId: string) {
    setSaving(playerId);
    setMarkError(null);
    try {
      await setLockMark(leagueId, myRosterId, playerId, true);
      await reload();
    } catch (cause) {
      setMarkError(cause instanceof Error ? cause.message : "The mark could not be saved.");
    } finally {
      setSaving(null);
    }
  }

  const head = (
    <div className="plan-head">
      <h2 className="team-title">
        Lineup plan <span className="plan-beta">Experimental</span>
      </h2>
      {data && <Freshness data={data} fetchedAt={fetchedAt} now={now} />}
    </div>
  );

  if (!data) {
    return (
      <section className="plan" aria-label="Lineup plan" aria-busy="true">
        {head}
        {error ? <p className="notice notice-error">{error}</p> : <p className="quiet">Loading this week's games and scores…</p>}
      </section>
    );
  }
  if (!model) {
    return (
      <section className="plan" aria-label="Lineup plan">
        {head}
        <p className="notice">The plan needs player stats, which are still loading.</p>
      </section>
    );
  }
  if (data.week.schedule !== "ready") {
    return (
      <section className="plan" aria-label="Lineup plan">
        {head}
        <p className="notice">{data.week.scheduleMessage ?? "The NBA schedule is not available, so there is no plan yet."}</p>
      </section>
    );
  }
  if (!built) {
    return (
      <section className="plan" aria-label="Lineup plan">
        {head}
        <p className="notice">Your team has no matchup this week.</p>
      </section>
    );
  }

  const { plan, names, forecast, mine } = built;
  const slots = mine.starters.map((entry) => entry.slot);
  const nextBy = plan.steps[0]?.by ?? null;
  // Now: the locks, the games being played, scores to let go, and the moves for the next tip-off
  // that hang on nothing still to be decided.
  const nowSteps = plan.steps.filter((step) => step.by === nextBy && step.unless.length === 0 && dayKey(step.by) === dayKey(planNow));
  const laterSteps = plan.steps.filter((step) => !nowSteps.includes(step));
  const groups = new Map<string, PlanStep[]>();
  for (const step of laterSteps) {
    const label = dayLabel(step.by, planNow);
    groups.set(label, [...(groups.get(label) ?? []), step]);
  }
  const gamesLeftCount = (id: string) => built.players.find((entry) => entry.id === id)?.shots.filter((shot) => shot.tip > planNow).length ?? 0;
  const gamesLeft = (id: string) => gamesLeftCount(id) > 0;
  /** What waiting is worth for a holder: his own games left, as one slot would play them. */
  const gamesLeftWorth = (id: string | null) => {
    const player = id ? built.players.find((entry) => entry.id === id) : undefined;
    return player ? waitWorthOf(player, planNow) : 0;
  };
  // A score with no games left needs no lock, unless it should move to free a wider slot.
  const shownLocks = plan.locks.filter((lock) => gamesLeft(lock.playerId) || lock.swapWith);
  const live = plan.lanes.filter((lane) => lane.decision === "live");
  const passes = plan.lanes.filter((lane) => lane.decision === "pass");
  let number = 0;

  return (
    <section className="plan" aria-label="Lineup plan">
      {head}

      <dl className="plan-figures">
        {forecast && (
          <div className="plan-figure-main">
            <dt>Win chance</dt>
            <dd className="num">{Math.round(forecast.winChance * 100)}%</dd>
          </div>
        )}
        <div>
          <dt>Expected, following the plan</dt>
          <dd className="num">{formatPoints(plan.expected)}</dd>
        </div>
        {forecast && (
          <div>
            <dt>Their expected</dt>
            <dd className="num">{formatPoints(forecast.theirs)}</dd>
          </div>
        )}
        <div>
          <dt>Locked so far</dt>
          <dd className="num">{formatPoints(plan.settled)}</dd>
        </div>
      </dl>

      {markError && <p className="notice notice-error">{markError}</p>}

      <h3 className="panel-heading">Now</h3>
      {shownLocks.length + live.length + passes.length + nowSteps.length === 0 ? (
        <p className="quiet">Nothing to do right now: your lineup is set for what comes next.</p>
      ) : (
        <ol className="plan-steps">
          {shownLocks.map((lock) => {
            number += 1;
            const player = names.get(lock.playerId);
            const hasGames = gamesLeft(lock.playerId);
            return (
              <li key={`lock-${lock.playerId}`} className="plan-step">
                <span className="plan-step-number" aria-hidden="true">
                  {number}
                </span>
                <div className="plan-step-body">
                  <ul className="plan-moves">
                    {lock.swapWith && (
                      <MoveLine
                        move={{ kind: "swap", playerId: lock.playerId, slot: lock.lane, otherId: lock.swapWith.playerId, otherSlot: lock.swapWith.lane }}
                        slots={slots}
                        names={names}
                      />
                    )}
                    <li className="plan-move">
                      <Tag kind={hasGames ? "lock" : "keep"} />
                      <span>
                        <Who id={lock.playerId} names={names} />
                        's {formatPoints(lock.points)} in <PositionChip label={slots[lock.lane] ?? "?"} />
                      </span>
                    </li>
                  </ul>
                  <p className="plan-step-why quiet">{lockReason(lock, gamesLeftCount(lock.playerId))}</p>
                  {canMark && hasGames && player && (
                    <button type="button" className="button button-plain plan-mark" disabled={saving === lock.playerId} onClick={() => void markLocked(lock.playerId)}>
                      {saving === lock.playerId ? "Saving…" : "I locked it"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
          {live.map((lane) => {
            number += 1;
            return (
              <li key={`live-${lane.index}`} className="plan-step">
                <span className="plan-step-number" aria-hidden="true">
                  {number}
                </span>
                <div className="plan-step-body">
                  <ul className="plan-moves">
                    <li className="plan-move">
                      <Tag kind="live" />
                      <span>
                        <Who id={lane.occupant} names={names} /> in <PositionChip label={lane.slot} />, {formatPoints(lane.points)} so far
                      </span>
                    </li>
                  </ul>
                  <p className="plan-step-why quiet">
                    {lane.liveLockAt === null
                      ? "Counts as it ends: nothing after it in this slot."
                      : `After the game, lock it if he finishes with ${formatPoints(lane.liveLockAt)} or more.`}
                  </p>
                </div>
              </li>
            );
          })}
          {passes.length > 0 &&
            (() => {
              number += 1;
              return (
                <li key="passes" className="plan-step">
                  <span className="plan-step-number" aria-hidden="true">
                    {number}
                  </span>
                  <div className="plan-step-body">
                    <p className="plan-step-when">Don't lock these yet</p>
                    <ul className="plan-moves">
                      {passes.map((lane) => (
                        <li key={`pass-${lane.index}`} className="plan-move plan-move-reason">
                          <Tag kind="pass" />
                          <span>
                            <Who id={lane.occupant} names={names} />
                            's {formatPoints(lane.points)} in <PositionChip label={lane.slot} />
                            <span className="plan-step-why quiet">{passReason(lane, gamesLeftWorth(lane.occupant))}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })()}
          {nowSteps.map((step) => {
            number += 1;
            return <StepCard key={`step-${step.by}`} step={step} number={number} slots={slots} names={names} now={planNow} />;
          })}
        </ol>
      )}

      {[...groups.entries()].map(([label, steps]) => (
        <div key={label} className="plan-group">
          <h3 className="panel-heading">{label}</h3>
          <ol className="plan-steps">
            {steps.map((step, index) => (
              <StepCard key={`${step.by}-${index}`} step={step} number={index + 1} slots={slots} names={names} now={planNow} />
            ))}
          </ol>
        </div>
      ))}
      {laterSteps.length > 0 && (
        <p className="quiet panel-note">
          Later steps depend on how tonight's games go, so the plan works itself out again as scores come in.
        </p>
      )}

      <h3 className="panel-heading">Slot by slot</h3>
      <div className="table-scroll">
        <table className="players-table plan-table">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">Now</th>
              <th scope="col">Games planned</th>
              <th scope="col" className="num">Expected</th>
            </tr>
          </thead>
          <tbody>
            {plan.lanes.map((lane) => {
              const locked = plan.locks.find((entry) => entry.lane === lane.index);
              const occupant = locked ? locked.playerId : lane.occupant;
              return (
                <tr key={lane.index}>
                  <td className="plan-slot">
                    <PositionChip label={lane.slot} />
                  </td>
                  <td className="plan-now">
                    <Who id={occupant} names={names} />
                    <span className="plan-state quiet">
                      {STATE_TEXT[lane.decision]}
                      {(lane.decision !== "open" || lane.points > 0) && lane.kind !== "empty" ? ` ${formatPoints(locked ? locked.points : lane.points)}` : ""}
                    </span>
                  </td>
                  <td className="plan-games">
                    {lane.shots.length === 0 ? (
                      <span className="quiet">–</span>
                    ) : (
                      <ul className="plan-shots">
                        {lane.shots.map((shot) => (
                          <li key={shot.gameId + shot.playerId}>
                            <Who id={shot.playerId} names={names} />{" "}
                            <span className="quiet">
                              {dayKey(shot.tip) === dayKey(planNow) ? clock.format(shot.tip) : `${weekday.format(shot.tip).slice(0, 3)} ${clock.format(shot.tip)}`}
                              {shot.chance < 0.995 ? `, ${Math.round(shot.chance * 100)}% to play` : ""}
                              {shot.lockAt !== null ? `, lock at ${formatPoints(shot.lockAt)}` : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="num plan-value">{formatPoints(lane.value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="quiet panel-note">
        Each slot counts one game. Games are planned into the slots where they add most to your expected total, and a
        game is worth locking when it beats what the games after it in its slot are expected to bring. A score in hand is
        locked when that raises the expected total. Sleeper does not share locks, so a score the data cannot settle is
        treated as not locked until you press "I locked it".
      </p>
    </section>
  );
}

/** When each kind of data was brought up to date, how soon it is asked for again, and a warning when scores lag. */
function Freshness({ data, fetchedAt, now }: { data: LivePlanData; fetchedAt: number | null; now: number }) {
  const at = (iso: string | null) => (iso ? clock.format(new Date(iso)) : "not yet");
  const lagging =
    data.phase === "live" &&
    [data.asOf.league, data.asOf.boxScores].some((iso) => !iso || now - Date.parse(iso) > LAG_WARN_MS);
  const phaseText =
    data.phase === "live"
      ? "Games on: updates every 20 seconds"
      : data.phase === "pregame"
        ? "Tip-off soon: updates every minute"
        : "Updates every 5 minutes, faster when games are on";
  return (
    <div className="plan-fresh">
      <p className={`plan-phase plan-phase-${data.phase}`}>
        {data.phase === "live" && <span className="live-dot" aria-hidden="true" />}
        {phaseText}
      </p>
      <dl className="plan-asof quiet">
        <div>
          <dt>Sleeper scores</dt>
          <dd>{at(data.asOf.league)}</dd>
        </div>
        <div>
          <dt>Box scores</dt>
          <dd>{at(data.asOf.boxScores)}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{at(data.asOf.schedule)}</dd>
        </div>
        <div>
          <dt>Injury report</dt>
          <dd>{at(data.asOf.injuries)}</dd>
        </div>
        {fetchedAt && (
          <div>
            <dt>Checked</dt>
            <dd>{clock.format(fetchedAt)}</dd>
          </div>
        )}
      </dl>
      {lagging && (
        <p className="notice notice-warn">
          Scores are more than a few minutes behind. The server is catching up; the plan updates when they arrive.
        </p>
      )}
    </div>
  );
}
