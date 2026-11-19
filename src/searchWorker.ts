// Runs the trade search and the top moves off the page's thread (see search.ts).
import { teamSituations } from "../shared/insight.ts";
import { topMoves } from "../shared/moves.ts";
import { buildModel, leagueStrength } from "../shared/strength.ts";
import { findTrades } from "../shared/trade.ts";
import type { FromWorker, ToWorker } from "./search.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage: (message: FromWorker) => void;
};

let current: { source: number; build: () => ReturnType<typeof prepare> } | null = null;
let prepared: { source: number; data: ReturnType<typeof prepare> } | null = null;

function prepare(message: Extract<ToWorker, { type: "data" }>) {
  const model = buildModel(message.snapshot, message.report);
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
    if (!prepared || prepared.source !== current.source) prepared = { source: current.source, data: current.build() };
    const { snapshot, model, situations } = prepared.data;
    const { request } = message;
    const result =
      request.kind === "trades"
        ? findTrades(model, snapshot, request.rosterId, situations, request.options)
        : topMoves(model, snapshot, request.rosterId, situations);
    scope.postMessage({ id: message.id, result });
  } catch (error) {
    scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
