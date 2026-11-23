// Runs the trade search and the top moves off the page's thread (see search.ts).
import { teamSituations } from "../shared/insight.ts";
import { topMoves } from "../shared/moves.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import { findTrades, type SearchStage } from "../shared/trade.ts";
import type { FromWorker, ToWorker } from "./search.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: (message: FromWorker) => void;
};

let current: { source: number; build: () => ReturnType<typeof prepare> } | null = null;
let prepared: { source: number; data: ReturnType<typeof prepare> } | null = null;

function prepare(message: Extract<ToWorker, { type: "data" }>) {
  const model = buildModel(message.snapshot, message.report, undefined, message.schedule);
  const situations = teamSituations(message.snapshot, model, leagueStrength(message.snapshot, model));
  return { snapshot: message.snapshot, model, situations };
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "data") {
    // Built when the first search needs it.
    current = { source: message.source, build: () => prepare(message) };
    return;
  }
  try {
    if (!current || current.source !== message.source) throw new Error("no data for this model");
    if (!prepared || prepared.source !== current.source) {
      scope.postMessage({ id: message.id, progress: 0, stage: "setup" });
      prepared = { source: current.source, data: current.build() };
    }
    const { snapshot, model, situations } = prepared.data;
    const { request } = message;
    // Progress goes back a few times a second at most, and at every new step.
    let sentAt = 0;
    let sentStage = "";
    const progress = (share: number, stage: SearchStage) => {
      const now = Date.now();
      if (stage === sentStage && now - sentAt < 60) return;
      sentAt = now;
      sentStage = stage;
      scope.postMessage({ id: message.id, progress: share, stage });
    };
    const result =
      request.kind === "trades"
        ? findTrades(model, snapshot, request.rosterId, situations, request.options, undefined, progress)
        : topMoves(model, snapshot, request.rosterId, situations, undefined, progress);
    scope.postMessage({ id: message.id, result });
  } catch (error) {
    scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
