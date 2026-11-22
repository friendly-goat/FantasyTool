// The trade search and the top moves are the app's heaviest work (several
// seconds on a phone), so they run in a web worker (searchWorker.ts) and the
// page stays usable while they do. The worker builds the same strength model
// from the same league and stats; the model is deterministic, so its answers
// match what this thread would work out. Without workers (tests, old
// browsers) the work runs here instead, after the page has painted.
import type { FinderOptions, FinderResult, SearchProgress, SearchStage } from "../shared/trade.ts";
import { findTrades } from "../shared/trade.ts";
import { type Move, topMoves } from "../shared/moves.ts";
import type { TeamSituation } from "../shared/insight.ts";
import type { StrengthModel } from "../shared/strength.ts";
import type { LeagueSnapshot, ScheduleAhead, StatsReport } from "../shared/types.ts";

export type SearchRequest =
  | { kind: "trades"; rosterId: number; options: FinderOptions }
  | { kind: "moves"; rosterId: number };

/** Messages to the worker: the data for a model, or a search on it. */
export type ToWorker =
  | { type: "data"; source: number; snapshot: LeagueSnapshot; report: StatsReport; schedule: ScheduleAhead | null }
  | { type: "search"; id: number; source: number; request: SearchRequest };

/** Messages back: how far a search has got, its answer, or why it failed. */
export type FromWorker =
  | { id: number; progress: number; stage: SearchStage }
  | { id: number; result: FinderResult | Move[] }
  | { id: number; error: string };

interface Source {
  id: number;
  snapshot: LeagueSnapshot;
  report: StatsReport;
  schedule: ScheduleAhead | null;
}

const sources = new WeakMap<StrengthModel, Source>();
let nextSource = 0;

/** Call when a model is built, with what it was built from, so the worker can build the same one. */
export function registerModel(model: StrengthModel, snapshot: LeagueSnapshot, report: StatsReport, schedule: ScheduleAhead | null): void {
  if (!sources.has(model)) sources.set(model, { id: ++nextSource, snapshot, report, schedule });
}

let worker: Worker | null | undefined;
let sent = 0;
let nextId = 0;
const waiting = new Map<
  number,
  { resolve: (value: FinderResult | Move[]) => void; reject: (reason: Error) => void; progress?: SearchProgress }
>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === "undefined" ? null : new Worker(new URL("./searchWorker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const reply = event.data;
      const entry = waiting.get(reply.id);
      if (!entry) return;
      if ("progress" in reply) {
        entry.progress?.(reply.progress, reply.stage);
        return;
      }
      waiting.delete(reply.id);
      if ("error" in reply) entry.reject(new Error(reply.error));
      else entry.resolve(reply.result);
    };
    // A worker that cannot start (or crashes) hands everything back to this thread.
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      for (const [, entry] of waiting) entry.reject(new Error("worker failed"));
      waiting.clear();
    };
  }
  return worker;
}

function here(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  situations: Map<number, TeamSituation>,
  request: SearchRequest,
  progress?: SearchProgress,
): Promise<FinderResult | Move[]> {
  return new Promise((resolve) => {
    // Let a "Searching" label paint first.
    setTimeout(() => {
      resolve(
        request.kind === "trades"
          ? findTrades(model, snapshot, request.rosterId, situations, request.options, undefined, progress)
          : topMoves(model, snapshot, request.rosterId, situations),
      );
    }, 30);
  });
}

function run(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  situations: Map<number, TeamSituation>,
  request: SearchRequest,
  progress?: SearchProgress,
): Promise<FinderResult | Move[]> {
  const source = sources.get(model);
  const target = source ? getWorker() : null;
  if (!source || !target) return here(model, snapshot, situations, request, progress);
  if (sent !== source.id) {
    target.postMessage({ type: "data", source: source.id, snapshot: source.snapshot, report: source.report, schedule: source.schedule } satisfies ToWorker);
    sent = source.id;
  }
  const id = ++nextId;
  return new Promise<FinderResult | Move[]>((resolve, reject) => {
    waiting.set(id, { resolve, reject, progress });
    target.postMessage({ type: "search", id, source: source.id, request } satisfies ToWorker);
  }).catch(() => here(model, snapshot, situations, request, progress));
}

/** findTrades, off the page's thread when it can be. */
export function searchTrades(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  situations: Map<number, TeamSituation>,
  rosterId: number,
  options: FinderOptions,
  /** Told how far the search has got (0 to 1, and its step), for a progress bar. */
  progress?: SearchProgress,
): Promise<FinderResult> {
  return run(model, snapshot, situations, { kind: "trades", rosterId, options }, progress) as Promise<FinderResult>;
}

/** topMoves, off the page's thread when it can be. */
export function searchMoves(
  model: StrengthModel,
  snapshot: LeagueSnapshot,
  situations: Map<number, TeamSituation>,
  rosterId: number,
): Promise<Move[]> {
  return run(model, snapshot, situations, { kind: "moves", rosterId }) as Promise<Move[]>;
}
