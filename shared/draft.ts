// How drafted players compare with where they were picked.
//
// Rule: rank every drafted player by his weekly value now (his lock-in value
// at his projected level, allowing for missed games: `expected` in the
// strength model). That ranking is the order the same players would go in if
// the draft were rerun today. A player whose rank is at least one full round
// (one pick per team) earlier than where he went is beating his draft spot;
// at least a round later, he is falling short of it. Anything closer shows no
// mark.
//
// This is a display label only. Nothing else in the analysis reads it.

export interface DraftTrend {
  /** Order he was picked in, among players with a known value (1 = first). */
  pickOrder: number;
  /** Where his value now ranks among the same players (1 = most valuable). */
  valueRank: number;
  /** pickOrder minus valueRank: positive means worth an earlier pick than he went. */
  shift: number;
  trend: "up" | "down" | null;
}

export function draftTrends(
  picks: { pickNo: number; player: { id: string } }[],
  valueOf: (playerId: string) => number | null,
  roundSize: number,
): Map<number, DraftTrend> {
  const valued = picks
    .map((pick) => ({ pickNo: pick.pickNo, value: valueOf(pick.player.id) }))
    .filter((entry): entry is { pickNo: number; value: number } => entry.value !== null && Number.isFinite(entry.value))
    .sort((a, b) => a.pickNo - b.pickNo);

  const byValue = [...valued].sort((a, b) => b.value - a.value || a.pickNo - b.pickNo);
  const valueRank = new Map(byValue.map((entry, index) => [entry.pickNo, index + 1]));
  const threshold = Math.max(1, roundSize);

  const trends = new Map<number, DraftTrend>();
  valued.forEach((entry, index) => {
    const pickOrder = index + 1;
    const rank = valueRank.get(entry.pickNo)!;
    const shift = pickOrder - rank;
    trends.set(entry.pickNo, {
      pickOrder,
      valueRank: rank,
      shift,
      trend: shift >= threshold ? "up" : shift <= -threshold ? "down" : null,
    });
  });
  return trends;
}
