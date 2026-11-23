// Turns the live week (Sleeper's lineup and scores, the NBA schedule, box
// scores, lock marks and the injury report) into what the lineup plan reads
// (shared/lineupPlan.ts), and plays the plan out against the other team for
// a win chance.

import { daysBetween, type InjuryNews, returnOutlook } from "./injury.ts";
import { GAME_MS, type LaneInput, type LineupPlan, type PlayerInput, type ShotInput } from "./lineupPlan.ts";
import { finishSlot, injuryKind, mulberry32, type SimSlot, type SlotStatus, teamWeek } from "./matchup.ts";
import { gameScoreFor, type StrengthModel } from "./strength.ts";
import type { MatchupSide, NbaGame, PlayerRef, WeekLine } from "./types.ts";

/** A game with no tip-off time is taken to start at this hour UTC on its day (7 PM Eastern). */
const DEFAULT_TIP_UTC = "23:00:00Z";

export function tipOf(game: NbaGame): number {
  return Date.parse(game.startTime ?? `${game.date}T${DEFAULT_TIP_UTC}`);
}

/** How a starter's slot stands, from his status this week (with any lock mark applied). */
export function laneFor(slot: string, player: PlayerRef | null, points: number, status: SlotStatus | null): LaneInput {
  const occupant = player?.id ?? null;
  if (!player || !status) return { slot, occupant, kind: "empty", points: 0 };
  switch (status.state) {
    case "locked":
      return { slot, occupant, kind: "fixed", points };
    case "open":
    case "final":
      return { slot, occupant, kind: "hand", points };
    case "unclear":
      return points > 0 ? { slot, occupant, kind: "hand", points } : { slot, occupant, kind: "empty", points: 0 };
    case "live": {
      const game = status.counted !== null ? status.games[status.counted]?.game : status.games.find((entry) => entry.game.state === "in_progress")?.game;
      return { slot, occupant, kind: "live", points, liveEnds: game ? tipOf(game) + GAME_MS : undefined };
    }
    default:
      return { slot, occupant, kind: "empty", points: 0 };
  }
}

/**
 * His chance of playing a game this week: his usual rate, and the injury
 * report. Out with a return window: none before it opens, his usual rate once
 * it has closed, rising through it. Out for the season: none. Out with no date:
 * none next game, half after. Day-to-day: 60% next game.
 */
export function gameChance(
  availability: number,
  news: InjuryNews | null | undefined,
  sleeperStatus: string | null | undefined,
  gameDate: string,
  /** Which of his games still to come this is (0 the next). */
  index: number,
): number {
  if (news) {
    const outlook = returnOutlook(news);
    if (outlook.kind === "season") return 0;
    if (outlook.kind === "window") {
      const { earliest, latest } = outlook.window;
      if (gameDate < earliest) return 0;
      if (gameDate >= latest) return availability;
      const span = Math.max(1, daysBetween(earliest, latest));
      return availability * Math.min(1, Math.max(0, (daysBetween(earliest, gameDate) + 1) / (span + 1)));
    }
  }
  const kind = injuryKind(news?.status ?? sleeperStatus);
  if (kind === "out") return index === 0 ? 0 : availability * 0.5;
  if (kind === "day-to-day" && index === 0) return availability * 0.6;
  return availability;
}

export interface PlanData {
  side: MatchupSide;
  /** Starters' statuses, in starter order (marks applied). */
  statuses: (SlotStatus | null)[];
  games: NbaGame[];
  lines: Record<string, WeekLine[]>;
  model: StrengthModel;
  /** Injury report entries by Sleeper ID. */
  injuries: Record<string, InjuryNews | null | undefined>;
  /** Players on injured reserve: they cannot play. */
  reserve: Set<string>;
  now: number;
}

/** The plan's lanes and players from the live week. */
export function planInputs(data: PlanData): { lanes: LaneInput[]; players: PlayerInput[] } {
  const lanes = data.side.starters.map((entry, index) =>
    laneFor(entry.slot, entry.player, entry.points ?? 0, data.statuses[index] ?? null),
  );
  const roster = [...data.side.starters, ...data.side.bench].flatMap((entry) => (entry.player ? [entry.player] : []));
  const players: PlayerInput[] = [];
  for (const ref of roster) {
    if (data.reserve.has(ref.id)) continue;
    const model = data.model.players.get(ref.id);
    const lines = data.lines[ref.id] ?? [];
    const team = lines[lines.length - 1]?.team ?? ref.team;
    const week = teamWeek(data.games, team, lines, true);
    const upcoming = week.filter((entry) => entry.game.state === "scheduled" && tipOf(entry.game) > data.now);
    // A game past its tip-off that the schedule has not caught up with is being played.
    const live = week.find(
      (entry) =>
        entry.game.state === "in_progress" ||
        (entry.game.state === "scheduled" && tipOf(entry.game) <= data.now && data.now < tipOf(entry.game) + GAME_MS),
    );
    const shots: ShotInput[] = upcoming.map((entry, index) => ({
      gameId: entry.game.id,
      tip: tipOf(entry.game),
      chance: gameChance(model?.availability ?? 0.9, data.injuries[ref.id], ref.injuryStatus, entry.game.date, index),
    }));
    players.push({
      id: ref.id,
      name: ref.name,
      positions: ref.positions,
      level: model?.projected ?? 0,
      spread: model?.spread ?? 0.3,
      shots,
      liveTip: live ? tipOf(live.game) : null,
    });
  }
  return { lanes, players };
}

/** The other team's starters as the win-chance simulation sees them. */
export function simSlots(side: MatchupSide, statuses: (SlotStatus | null)[], model: StrengthModel): SimSlot[] {
  return side.starters.map((entry, index) => {
    const status = statuses[index];
    const player = entry.player ? model.players.get(entry.player.id) : undefined;
    return {
      state: status?.state ?? "done",
      points: entry.points ?? 0,
      gamesLeft: status?.gamesLeft ?? 0,
      player: player ?? null,
      injury: injuryKind(entry.player?.injuryStatus),
    };
  });
}

function draw(level: number, spread: number, random: () => number): number {
  const u1 = Math.max(1e-9, random());
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
  return gameScoreFor(level, spread, z);
}

/** One playing-out of your week following the plan: each slot locks at the plan's scores. */
export function samplePlan(plan: LineupPlan, players: Map<string, PlayerInput>, random: () => number): number {
  let total = 0;
  for (const lane of plan.lanes) {
    if (lane.decision === "fixed" || lane.decision === "lock" || lane.decision === "keep") {
      total += lane.value;
      continue;
    }
    let score = 0;
    let settled = false;
    if (lane.decision === "live" && lane.occupant) {
      const player = players.get(lane.occupant);
      const live = Math.max(lane.points, player ? draw(player.level, player.spread, random) : lane.points);
      score = live;
      if (lane.liveLockAt === null || live >= lane.liveLockAt) settled = true;
    }
    for (let i = 0; i < lane.shots.length && !settled; i++) {
      const shot = lane.shots[i]!;
      const player = players.get(shot.playerId);
      const last = i === lane.shots.length - 1;
      if (player && random() < shot.chance) {
        score = draw(player.level, player.spread, random);
        if (last || shot.lockAt === null || score >= shot.lockAt) settled = true;
      } else if (last) {
        score = 0;
        settled = true;
      }
    }
    // An open slot with no games planned counts nothing.
    total += settled || lane.decision === "live" ? score : 0;
  }
  return total;
}

export interface PlanForecast {
  /** Your expected total following the plan, and theirs. */
  yours: number;
  theirs: number;
  winChance: number;
}

/** Your week following the plan against theirs (each of their managers locking when a score beats waiting). */
export function planForecast(
  plan: LineupPlan,
  players: PlayerInput[],
  theirs: SimSlot[],
  runs = 3000,
  seed = 1,
): PlanForecast {
  const random = mulberry32(seed);
  const byId = new Map(players.map((player) => [player.id, player]));
  let wins = 0;
  let mine = 0;
  let other = 0;
  for (let run = 0; run < runs; run++) {
    const a = samplePlan(plan, byId, random);
    const b = theirs.reduce((sum, slot) => sum + finishSlot(slot, random), 0);
    mine += a;
    other += b;
    wins += a > b ? 1 : a === b ? 0.5 : 0;
  }
  return { yours: mine / runs, theirs: other / runs, winChance: wins / runs };
}
