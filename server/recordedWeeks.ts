// Finished weeks' final scores recorded by hand from Sleeper's app, for weeks the
// standings ledger cannot split (it began after they were played; see
// shared/weekScores.ts). Keyed by league ID. Each entry is checked against the
// standings' points for and against when the history is served, and a mismatch
// is logged.
import type { RecordedWeek } from "../shared/weekScores.ts";

export const RECORDED_WEEKS: Record<string, RecordedWeek[]> = {};
