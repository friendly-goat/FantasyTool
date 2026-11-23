// The lineup plan: what to lock, start and bench for the rest of this
// fantasy week, from the scores in hand and every game your players have
// left. Pure functions; the Lineup plan view feeds them live data.
//
// The rules (lock-in mode): each starting slot counts one game. A player's
// game counts in the slot he is in when it tips; after it, his score can be
// locked before his next game, otherwise his next game in a starting slot
// replaces it, and if nothing is locked the last game counts. A slot is
// therefore a lane that takes games one after another: after each, lock or
// carry on, and a slot can take a second player's game the same night when
// the first game is over before the second tips.
//
// The plan, in steps:
//   1. Lanes. Each starting slot is fixed (a locked score), holds a score in
//      hand (his game is over and it is not locked), has a game being
//      played, or is empty.
//   2. Shots. Every game a rostered player still has to tip this week, with
//      his chance of playing it (his availability and the injury report).
//   3. Value of a lane: backward through its games, each worth his expected
//      score with locking whenever a game beats what the games after it are
//      worth (`laneValue`). That worth is the score to lock at.
//   4. Assignment: games in order of tip-off, each to the open lane it adds
//      most to (a lane he may play in, free by then), or to none.
//   5. Scores in hand: lock one when it beats what its lane would get
//      otherwise; a locked player is out for the week, so the games are
//      assigned again. A score to lock goes in the narrowest slot that
//      takes him when that frees a wider one (PF before F, F before UTIL).
//   6. The lineups that make it happen: who has to be in each slot when each
//      game tips, and the moves from one to the next.

import { slotAccepts } from "./analysis.ts";
import { gameScoreFor, QUANTILES } from "./strength.ts";

/** A game's length for planning: the slot is free for another game this long after tip-off. */
export const GAME_MS = 2.5 * 60 * 60_000;

/** A starting slot as it stands now. */
export interface LaneInput {
  /** The slot's name, e.g. "PG", "F", "UTIL". */
  slot: string;
  /** Who is in it now (Sleeper player ID), if anyone. */
  occupant: string | null;
  /**
   * fixed: a locked score (nothing can change it).
   * hand: his game is over and its score counts unless replaced (it can be locked).
   * live: his game is being played.
   * empty: nothing counts yet.
   */
  kind: "fixed" | "hand" | "live" | "empty";
  /** The fixed score, the score in hand, or points so far in the live game. */
  points: number;
  /** When the live game should be over (ms). */
  liveEnds?: number;
}

/** A game a player still has to tip this week. */
export interface ShotInput {
  gameId: string;
  /** Tip-off, ms. */
  tip: number;
  /** Chance he plays it. */
  chance: number;
}

export interface PlayerInput {
  id: string;
  name: string;
  positions: string[];
  /** Projected fantasy points a game, and game-to-game spread as a share of it (the model's). */
  level: number;
  spread: number;
  /** His games still to tip this week, in order (not one being played now). */
  shots: ShotInput[];
  /** A game being played now (tip, ms), when he is on the bench for it: he is busy until it ends. */
  liveTip?: number | null;
}

/** One of a lane's games in the plan. */
export interface PlannedShot {
  playerId: string;
  gameId: string;
  tip: number;
  chance: number;
  /** Lock after this game when he scores at least this; null for the lane's last game (it counts as is). */
  lockAt: number | null;
}

export type LaneDecision =
  /** A locked score. */
  | "fixed"
  /** Lock the score in hand (before his next game, or any other game in this slot). */
  | "lock"
  /** Keep the score in hand: he has no games left and nothing in this slot beats it. */
  | "keep"
  /** Let the score in hand go: the games planned in this slot are worth more. */
  | "pass"
  /** His game is being played. */
  | "live"
  /** Nothing in hand: the planned games fill it. */
  | "open";

export interface PlannedLane {
  index: number;
  slot: string;
  kind: LaneInput["kind"];
  /** Who is in it now. */
  occupant: string | null;
  points: number;
  decision: LaneDecision;
  /** For a live game: lock after it when he scores at least this (null: it counts as is). */
  liveLockAt: number | null;
  liveEnds: number | null;
  shots: PlannedShot[];
  /** What the games planned in this slot are worth, before any score in hand. */
  ahead: number;
  /** Expected final score for the slot. */
  value: number;
  /** For a score locked in another slot first: the slot it came from (a swap). */
  lockedFrom: number | null;
  /**
   * For a score in hand left unlocked: how much more the plan expects than with it locked (in
   * the best slot for it), and whether its holder plays on (a game of his is planned).
   */
  passBy: number | null;
  holderPlays: boolean;
}

export interface LineupState {
  /** When this lineup must be set by: the earliest tip-off it is for (ms). */
  at: number;
  /** Who must be in each starting slot (by lane), or null for empty. */
  slots: (string | null)[];
}

export type MoveKind = "swap" | "start" | "move" | "bench";

export interface Move {
  kind: MoveKind;
  /** The player moving into `slot` (start, move, swap), or leaving it (bench). */
  playerId: string;
  slot: number;
  /** For a swap: the other player and his slot. For a start: who goes to the bench, if anyone. */
  otherId: string | null;
  otherSlot: number | null;
}

export interface PlanStep {
  /** Set by this time (ms): the tip-off it is for. */
  by: number;
  /** Players whose game that is. */
  forPlayers: string[];
  moves: Move[];
  /** Only if these earlier games are not locked: player and the score he would lock at. */
  /** Only in slots whose earlier game is not locked by then: the slot, its player and the score he would lock at. */
  unless: { lane: number; playerId: string; lockAt: number }[];
}

export interface LineupPlan {
  lanes: PlannedLane[];
  /** Expected final total if the plan is followed. */
  expected: number;
  /** Points already settled (locked). */
  settled: number;
  /** Scores in hand to lock now, by lane (any swap first). */
  locks: {
    lane: number;
    playerId: string;
    points: number;
    /** What waiting is worth: his own games still to come this week (0 when he has none). */
    worth: number;
    /** What the lock adds to the expected total over not locking (scores in hand weighed either way). */
    gain: number;
    swapWith: { lane: number; playerId: string | null } | null;
  }[];
  steps: PlanStep[];
}

// ---- Value of a lane ---------------------------------------------------------

const scoreCache = new Map<string, number[]>();

/** His possible game scores, as many even steps of his distribution (ascending). */
export function scoreSteps(level: number, spread: number): number[] {
  const key = `${level.toFixed(3)}|${spread.toFixed(4)}`;
  let steps = scoreCache.get(key);
  if (!steps) {
    steps = QUANTILES.map((z) => gameScoreFor(level, spread, z));
    if (scoreCache.size > 2000) scoreCache.clear();
    scoreCache.set(key, steps);
  }
  return steps;
}

/** E[max(game, floor)] over his score steps. */
function expectedMax(steps: number[], floor: number): number {
  let sum = 0;
  for (const score of steps) sum += score > floor ? score : floor;
  return sum / steps.length;
}

export interface LaneGame {
  steps: number[];
  chance: number;
  /** A live game: he cannot score less than this (points so far). */
  floor?: number;
}

/**
 * What a lane's games are worth, played in order with a lock whenever a game
 * beats what the games after it are worth. Returns the worth from each game on
 * (`from[0]` is the whole lane; `from[games.length]` is 0): the score to lock at
 * after game j is `from[j + 1]`. A game he misses changes nothing; a missed last
 * game leaves nothing to count.
 */
export function laneValue(games: LaneGame[]): number[] {
  const from = new Array<number>(games.length + 1).fill(0);
  for (let j = games.length - 1; j >= 0; j--) {
    const game = games[j]!;
    const next = from[j + 1]!;
    const floor = game.floor ?? 0;
    const played = expectedMax(game.steps, Math.max(next, floor));
    // A live game is being played (chance 1); a floor above the next worth is a score in hand.
    from[j] = game.chance * (floor > next ? Math.max(played, floor) : played) + (1 - game.chance) * next;
  }
  return from;
}

// ---- The plan ------------------------------------------------------------------

interface Lane {
  input: LaneInput;
  index: number;
  fixed: boolean;
  /** The score in hand, while it is still in play. */
  hand: number | null;
  holder: string | null;
  shots: Entry[];
  /** For a lane whose score was locked after a swap from another lane. */
  lockedFrom: number | null;
  lockedPoints: number;
}

interface Entry {
  player: PlayerInput;
  shot: ShotInput;
}

/** Positions a slot takes: fewer is narrower. */
function width(slot: string): number {
  return ["PG", "SG", "SF", "PF", "C"].filter((position) => slotAccepts(slot, [position])).length;
}

function liveGame(lane: Lane, players: Map<string, PlayerInput>): LaneGame | null {
  if (lane.input.kind !== "live" || !lane.input.occupant) return null;
  const player = players.get(lane.input.occupant);
  if (!player) return { steps: [lane.input.points], chance: 1, floor: lane.input.points };
  return { steps: scoreSteps(player.level, player.spread), chance: 1, floor: lane.input.points };
}

function gamesOf(lane: Lane, players: Map<string, PlayerInput>, shots: Entry[] = lane.shots): LaneGame[] {
  const games: LaneGame[] = [];
  const live = liveGame(lane, players);
  if (live) games.push(live);
  for (const { player, shot } of shots) games.push({ steps: scoreSteps(player.level, player.spread), chance: shot.chance });
  return games;
}

/** What one planning works with: the players, the time, and lane values already worked out. */
interface Ctx {
  players: Map<string, PlayerInput>;
  now: number;
  memo: Map<string, number>;
}

/** What a lane's games are worth (its live game and planned games), ignoring any score in hand. */
function aheadOf(ctx: Ctx, lane: Lane, shots: Entry[] = lane.shots): number {
  if (lane.fixed) return 0;
  const live = lane.input.kind === "live" ? `${lane.input.occupant}@${lane.input.points}` : "";
  const key = `${live}|${shots.map((entry) => `${entry.player.id}:${entry.shot.gameId}`).join(",")}`;
  let value = ctx.memo.get(key);
  if (value === undefined) {
    value = laneValue(gamesOf(lane, ctx.players, shots))[0]!;
    ctx.memo.set(key, value);
  }
  return value;
}

/**
 * Whether a lane's score in hand is gone because its holder plays a game planned in another
 * slot: the score is the player's latest game, so it goes where he goes and his next game
 * replaces it.
 */
function holderAway(lanes: Lane[], lane: Lane): boolean {
  if (lane.hand === null || !lane.holder) return false;
  return lanes.some((other) => other !== lane && other.shots.some((entry) => entry.player.id === lane.holder));
}

/** A lane's expected final score: a locked score, or its games, or the score in hand if that is worth more. */
function worth(ctx: Ctx, lanes: Lane[], lane: Lane, shots: Entry[] = lane.shots): number {
  if (lane.fixed) return lane.lockedPoints;
  const ahead = aheadOf(ctx, lane, shots);
  return lane.hand !== null && !holderAway(lanes, lane) ? Math.max(lane.hand, ahead) : ahead;
}

const total = (ctx: Ctx, lanes: Lane[]) => lanes.reduce((sum, lane) => sum + worth(ctx, lanes, lane), 0);

/** The lane's games with one more, in order of tip-off. */
function withShot(shots: Entry[], entry: Entry): Entry[] {
  return [...shots, entry].sort((a, b) => a.shot.tip - b.shot.tip);
}

/**
 * Whether a lane can take a game: the slot takes his positions, it is not locked, and no other
 * game in it (its live game included) is being played at that tip-off.
 */
function fits(ctx: Ctx, lane: Lane, entry: Entry, shots: Entry[] = lane.shots): boolean {
  if (lane.fixed || !slotAccepts(lane.input.slot, entry.player.positions)) return false;
  const tip = entry.shot.tip;
  if (lane.input.kind === "live" && tip < (lane.input.liveEnds ?? ctx.now + GAME_MS)) return false;
  return shots.every((other) => other === entry || Math.abs(other.shot.tip - tip) >= GAME_MS);
}

/** Every game still to tip for players who can take one, in order of tip-off. */
function entriesFor(ctx: Ctx, unavailable: Set<string>): Entry[] {
  return [...ctx.players.values()]
    .filter((player) => !unavailable.has(player.id))
    .flatMap((player) => player.shots.filter((shot) => shot.tip > ctx.now && shot.chance > 0).map((shot) => ({ player, shot })))
    .sort((a, b) => a.shot.tip - b.shot.tip || b.player.level - a.player.level || a.player.id.localeCompare(b.player.id));
}

/**
 * Step 4a: every game in order of tip-off, to the open lane whose games it adds most to. Scores
 * in hand are left out here (a game that cannot beat a score alone may still, with the games
 * after it), and are weighed in step 4b. Ties go to a lane with no score in hand, then the
 * narrowest slot, so wide slots stay free for players who fit nowhere else.
 */
function assign(ctx: Ctx, lanes: Lane[], entries: Entry[]): void {
  for (const lane of lanes) lane.shots = [];
  for (const entry of entries) {
    let best: Lane | null = null;
    let bestScore = 1e-6;
    for (const lane of lanes) {
      if (!fits(ctx, lane, entry)) continue;
      const gain = aheadOf(ctx, lane, withShot(lane.shots, entry)) - aheadOf(ctx, lane);
      // A tie-break far smaller than any real gain.
      const score = gain - (lane.hand !== null ? 1e-4 : 0) - width(lane.input.slot) * 1e-5;
      if (score > bestScore) {
        bestScore = score;
        best = lane;
      }
    }
    if (best) best.shots = withShot(best.shots, entry);
  }
}

/**
 * Step 4b: moves single games from lane to lane (or out of the plan) while that raises the
 * expected total with scores in hand counted. A game whose lane is better off keeping its score
 * goes where it adds something, or nowhere; a holder's game elsewhere costs his score in hand.
 */
function improve(ctx: Ctx, lanes: Lane[], entries: Entry[]): void {
  const laneOf = new Map<Entry, Lane | null>(entries.map((entry) => [entry, null]));
  for (const lane of lanes) for (const entry of lane.shots) laneOf.set(entry, lane);
  const holderLane = new Map<string, Lane>();
  for (const lane of lanes) if (lane.hand !== null && lane.holder && !lane.fixed) holderLane.set(lane.holder, lane);
  /** The lanes a move of this entry can change: where it is, where it goes, and its player's score in hand. */
  const affected = (entry: Entry, from: Lane | null, to: Lane | null) =>
    [...new Set([from, to, holderLane.get(entry.player.id) ?? null])].filter((lane): lane is Lane => lane !== null);
  const sum = (list: Lane[]) => list.reduce((value, lane) => value + worth(ctx, lanes, lane), 0);
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const entry of entries) {
      const from = laneOf.get(entry) ?? null;
      const fromShots = from?.shots ?? [];
      const fromRest = fromShots.filter((other) => other !== entry);
      let best: { to: Lane | null; delta: number } | null = null;
      const tryMove = (to: Lane | null) => {
        const lanesHit = affected(entry, from, to);
        const before = sum(lanesHit);
        const toShots = to?.shots ?? [];
        if (from) from.shots = fromRest;
        if (to) to.shots = withShot(toShots, entry);
        const delta = sum(lanesHit) - before;
        if (to) to.shots = toShots;
        if (from) from.shots = fromShots;
        if (delta > (best?.delta ?? 1e-6)) best = { to, delta };
      };
      if (from) tryMove(null);
      for (const lane of lanes) if (lane !== from && fits(ctx, lane, entry)) tryMove(lane);
      const chosen = best as { to: Lane | null; delta: number } | null;
      if (!chosen) continue;
      if (from) from.shots = fromRest;
      if (chosen.to) chosen.to.shots = withShot(chosen.to.shots, entry);
      laneOf.set(entry, chosen.to);
      moved = true;
    }
    if (!moved) break;
  }
}

/** Steps 4a and 4b. */
function arrange(ctx: Ctx, lanes: Lane[], unavailable: Set<string>): void {
  const entries = entriesFor(ctx, unavailable);
  assign(ctx, lanes, entries);
  improve(ctx, lanes, entries);
}

const copyLanes = (lanes: Lane[]): Lane[] => lanes.map((lane) => ({ ...lane, input: { ...lane.input }, shots: [...lane.shots] }));

/**
 * A score in hand locked in lane `target`. Locked where he is, or moved first: he swaps with
 * whoever is in the target slot, who takes his slot (and must fit it).
 */
function lockInto(lanes: Lane[], from: number, target: number, players: Map<string, PlayerInput>): boolean {
  const source = lanes[from]!;
  const dest = lanes[target]!;
  const holder = source.holder!;
  const points = source.hand!;
  if (target === from) {
    source.fixed = true;
    source.lockedPoints = points;
    source.hand = null;
    source.shots = [];
    return true;
  }
  const holderPlayer = players.get(holder);
  if (!holderPlayer || dest.fixed || dest.hand !== null || dest.input.kind === "live") return false;
  if (!slotAccepts(dest.input.slot, holderPlayer.positions)) return false;
  const there = dest.input.occupant;
  if (there && !slotAccepts(source.input.slot, players.get(there)?.positions ?? [])) return false;
  dest.fixed = true;
  dest.lockedPoints = points;
  dest.lockedFrom = from;
  dest.shots = [];
  dest.input = { ...dest.input, occupant: holder, kind: "fixed", points };
  source.hand = null;
  source.holder = null;
  source.input = { ...source.input, occupant: there, kind: "empty", points: 0 };
  return true;
}

/** What waiting is worth for a player holding a score: his own games still to come, in one slot. */
export function waitWorthOf(player: PlayerInput, now: number): number {
  return waitingWorth(player, now);
}

function waitingWorth(player: PlayerInput | undefined, now: number): number {
  if (!player) return 0;
  const games = player.shots
    .filter((shot) => shot.tip > now)
    .map((shot) => ({ steps: scoreSteps(player.level, player.spread), chance: shot.chance }));
  return games.length > 0 ? laneValue(games)[0]! : 0;
}

/** Builds the plan from the lanes as they stand and the games left. */
export function planLineup(inputs: LaneInput[], playerList: PlayerInput[], now: number): LineupPlan {
  const players = new Map(playerList.map((player) => [player.id, player]));
  const ctx: Ctx = { players, now, memo: new Map() };
  let lanes: Lane[] = inputs.map((input, index) => ({
    input,
    index,
    fixed: input.kind === "fixed",
    hand: input.kind === "hand" ? input.points : null,
    holder: input.kind === "hand" ? input.occupant : null,
    shots: [],
    lockedFrom: null,
    lockedPoints: input.kind === "fixed" ? input.points : 0,
  }));
  // Players who cannot take another game this week: locked in.
  const unavailable = new Set<string>();
  for (const lane of lanes) {
    if (lane.fixed && lane.input.occupant) unavailable.add(lane.input.occupant);
  }
  const locks: LineupPlan["locks"] = [];

  // Step 5: lock the score in hand whose lock raises the expected total most (in whichever slot
  // that is best: where he is, or one that frees his slot for games), then plan again; until
  // locking nothing more helps. A lock that changes nothing is still made: unlocked, his next
  // game (or the slot's) would replace the score.
  for (let round = 0; round < inputs.length; round++) {
    arrange(ctx, lanes, unavailable);
    const base = total(ctx, lanes);
    let best: { lanes: Lane[]; value: number; from: number; target: number } | null = null;
    for (const source of lanes) {
      if (source.fixed || source.hand === null || !source.holder) continue;
      for (const target of lanes) {
        const trial = copyLanes(lanes);
        if (!lockInto(trial, source.index, target.index, players)) continue;
        const without = new Set(unavailable).add(source.holder);
        arrange(ctx, trial, without);
        const value = total(ctx, trial);
        // Ties: the narrowest slot that takes him (it keeps the wider ones open for anyone who
        // still plays), and where he is when the widths match.
        const tied = best !== null && Math.abs(value - best.value) <= 1e-6;
        const narrower = best !== null && width(target.input.slot) < width(lanes[best.target]!.input.slot);
        const sameWidth = best !== null && width(target.input.slot) === width(lanes[best.target]!.input.slot);
        const better = !best || value > best.value + 1e-6 || (tied && (narrower || (sameWidth && target.index === source.index)));
        if (value >= base - 1e-6 && better) best = { lanes: trial, value, from: source.index, target: target.index };
      }
    }
    if (!best) break;
    const source = lanes[best.from]!;
    const holder = source.holder!;
    locks.push({
      lane: best.target,
      playerId: holder,
      points: source.hand!,
      worth: waitingWorth(players.get(holder), now),
      gain: best.value - base,
      swapWith: best.target === best.from ? null : { lane: best.from, playerId: lanes[best.target]!.input.occupant },
    });
    unavailable.add(holder);
    lanes = best.lanes;
  }
  arrange(ctx, lanes, unavailable);
  const finalTotal = total(ctx, lanes);

  /** For a score in hand left unlocked: the plan's total less the best it could do with it locked. */
  const passBy = (lane: Lane): number | null => {
    if (lane.fixed || lane.hand === null || !lane.holder) return null;
    let best = -Infinity;
    for (const target of lanes) {
      const trial = copyLanes(lanes);
      if (!lockInto(trial, lane.index, target.index, players)) continue;
      arrange(ctx, trial, new Set(unavailable).add(lane.holder));
      best = Math.max(best, total(ctx, trial));
    }
    return Number.isFinite(best) ? Math.max(0, finalTotal - best) : null;
  };
  const planned: PlannedLane[] = lanes.map((lane) => {
    const games = gamesOf(lane, players);
    const from = laneValue(games);
    const live = lane.input.kind === "live" && !lane.fixed;
    const shotOffset = live ? 1 : 0;
    const shots: PlannedShot[] = lane.shots.map(({ player, shot }, index) => {
      const after = from[shotOffset + index + 1]!;
      const last = index === lane.shots.length - 1;
      return { playerId: player.id, gameId: shot.gameId, tip: shot.tip, chance: shot.chance, lockAt: last ? null : after };
    });
    const ahead = lane.fixed ? 0 : from[0]!;
    const locked = locks.find((entry) => entry.lane === lane.index);
    const holderHasGames = lane.holder ? (players.get(lane.holder)?.shots.some((shot) => shot.tip > now) ?? false) : false;
    let decision: LaneDecision;
    if (lane.fixed) decision = locked ? (players.get(locked.playerId)?.shots.some((shot) => shot.tip > now) ? "lock" : "keep") : "fixed";
    else if (live) decision = "live";
    else if (lane.hand !== null) decision = lane.hand >= ahead && !holderAway(lanes, lane) ? (holderHasGames ? "lock" : "keep") : "pass";
    else decision = "open";
    return {
      index: lane.index,
      slot: lane.input.slot,
      kind: inputs[lane.index]!.kind,
      occupant: inputs[lane.index]!.occupant,
      points: inputs[lane.index]!.points,
      decision,
      liveLockAt: live ? (lane.shots.length > 0 ? from[1]! : null) : null,
      liveEnds: live ? (lane.input.liveEnds ?? null) : null,
      shots,
      ahead,
      value: worth(ctx, lanes, lane),
      lockedFrom: lane.lockedFrom,
      passBy: decision === "pass" ? passBy(lane) : null,
      holderPlays: lane.holder ? lanes.some((other) => other.shots.some((entry) => entry.player.id === lane.holder)) : false,
    };
  });

  const expected = planned.reduce((sum, lane) => sum + lane.value, 0);
  const settled = inputs.reduce((sum, lane) => sum + (lane.kind === "fixed" ? lane.points : 0), 0);
  const lineup = lanes.map((lane) => lane.input.occupant);
  return { lanes: planned, expected, settled, locks, steps: planSteps(planned, lanes, lineup, inputs, players, now) };
}

// ---- Step 6: lineups and moves ----------------------------------------------------

function planSteps(
  planned: PlannedLane[],
  lanes: Lane[],
  /** The lineup once the locks (and their swaps) are made. */
  afterLocks: (string | null)[],
  inputs: LaneInput[],
  players: Map<string, PlayerInput>,
  now: number,
): PlanStep[] {
  // Every tip-off still to come for a rostered player: each one may need the lineup changed.
  const tips = [...new Set([...players.values()].flatMap((player) => player.shots.map((shot) => shot.tip)).filter((tip) => tip > now))].sort(
    (a, b) => a - b,
  );
  const playingAt = (tip: number) =>
    new Set([...players.values()].filter((player) => player.shots.some((shot) => shot.tip === tip)).map((player) => player.id));
  const steps: PlanStep[] = [];
  let previous = [...afterLocks];
  for (const tip of tips) {
    const tipping = playingAt(tip);
    const required: (string | null | undefined)[] = planned.map(() => undefined);
    const forPlayers: string[] = [];
    const unless: PlanStep["unless"] = [];
    planned.forEach((lane, index) => {
      if (lanes[index]!.fixed) {
        required[index] = previous[index] ?? null;
        return;
      }
      const shotNow = lane.shots.find((shot) => shot.tip === tip);
      if (shotNow) {
        required[index] = shotNow.playerId;
        forPlayers.push(shotNow.playerId);
        // Only if the game before it in this slot is not locked.
        const before = lane.shots.filter((shot) => shot.tip < tip).at(-1);
        if (before?.lockAt != null) unless.push({ lane: index, playerId: before.playerId, lockAt: before.lockAt });
        else if (!before && lane.decision === "live" && lane.liveLockAt != null && lane.occupant)
          unless.push({ lane: index, playerId: lane.occupant, lockAt: lane.liveLockAt });
        return;
      }
      // Still playing an earlier game in this slot.
      const playing = lane.shots.find((shot) => shot.tip < tip && tip < shot.tip + GAME_MS);
      if (playing) {
        required[index] = playing.playerId;
        return;
      }
      if (lane.decision === "live" && lane.occupant && tip < (lane.liveEnds ?? now + GAME_MS)) required[index] = lane.occupant;
    });
    // The other slots: anyone not playing at this tip-off (whoever is there if possible), or nobody.
    const used = new Set(required.filter((id): id is string => !!id));
    planned.forEach((_, index) => {
      if (required[index] !== undefined) return;
      const there = previous[index];
      if (there && !tipping.has(there) && !used.has(there)) {
        required[index] = there;
        used.add(there);
        return;
      }
      required[index] = null;
    });
    const next = required.map((id) => id ?? null);
    const moves = movesBetween(previous, next);
    if (moves.length > 0) steps.push({ by: tip, forPlayers, moves, unless });
    previous = next;
  }
  return steps;
}

/** The moves that turn one lineup into the next: swaps first, then starts, moves and benchings. */
export function movesBetween(before: (string | null)[], after: (string | null)[]): Move[] {
  const moves: Move[] = [];
  const done = new Set<number>();
  for (let i = 0; i < after.length; i++) {
    if (done.has(i) || before[i] === after[i]) continue;
    const incoming = after[i];
    const outgoing = before[i];
    // A swap: the two trade slots.
    if (incoming && outgoing) {
      const j = before.indexOf(incoming);
      if (j >= 0 && j !== i && after[j] === outgoing && !done.has(j)) {
        moves.push({ kind: "swap", playerId: incoming, slot: i, otherId: outgoing, otherSlot: j });
        done.add(i);
        done.add(j);
        continue;
      }
    }
    if (incoming) {
      const from = before.indexOf(incoming);
      const outgoingStays = outgoing ? after.includes(outgoing) : true;
      if (from >= 0) moves.push({ kind: "move", playerId: incoming, slot: i, otherId: outgoingStays ? null : (outgoing ?? null), otherSlot: from });
      else moves.push({ kind: "start", playerId: incoming, slot: i, otherId: outgoingStays ? null : (outgoing ?? null), otherSlot: null });
    } else if (outgoing && !after.includes(outgoing)) {
      moves.push({ kind: "bench", playerId: outgoing, slot: i, otherId: null, otherSlot: null });
    }
    done.add(i);
  }
  return moves;
}
