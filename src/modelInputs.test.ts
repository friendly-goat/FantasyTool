import { describe, expect, it } from "vitest";
import { fetchFromMock, MOCK_LEAGUE_ID } from "../server/mock.ts";
import { buildSnapshot, loadPlayers } from "../server/snapshot.ts";
import type { LeagueSnapshot } from "../shared/types.ts";
import { modelFingerprint } from "./modelInputs.ts";

describe("modelFingerprint", async () => {
  const players = await loadPlayers(fetchFromMock);
  const snapshot = await buildSnapshot(MOCK_LEAGUE_ID, fetchFromMock, players);
  const copy = (): LeagueSnapshot => structuredClone(snapshot);

  it("stays the same when only live or display data changes", () => {
    const later = copy();
    later.fetchedAt = later.fetchedAt.slice(0, 10) + "T23:59:00.000Z";
    later.live = true;
    later.refreshing = true;
    later.stale = true;
    later.statsVersion = "abc";
    later.transactions = [];
    for (const matchup of later.matchups) for (const side of matchup.sides) side.points += 12.5;
    // A manager moves his starters around: same players.
    const team = later.teams[0]!;
    const [first, second] = team.starters;
    if (first && second) [first.player, second.player] = [second.player, first.player];
    const benched = team.starters[2]!.player!;
    team.starters[2]!.player = team.bench[0]!;
    team.bench[0] = benched;
    expect(modelFingerprint(later)).toBe(modelFingerprint(snapshot));
  });

  it("changes when something the model reads changes", () => {
    const dropped = copy();
    dropped.teams[0]!.bench.pop();
    expect(modelFingerprint(dropped)).not.toBe(modelFingerprint(snapshot));

    const hurt = copy();
    hurt.teams[1]!.bench[0]!.injuryStatus = "Out";
    expect(modelFingerprint(hurt)).not.toBe(modelFingerprint(snapshot));

    const won = copy();
    won.teams[2]!.wins += 1;
    expect(modelFingerprint(won)).not.toBe(modelFingerprint(snapshot));

    const nextDay = copy();
    nextDay.fetchedAt = "2099-01-01T00:00:00.000Z";
    expect(modelFingerprint(nextDay)).not.toBe(modelFingerprint(snapshot));

    const rescored = copy();
    rescored.league.scoringSettings = { ...rescored.league.scoringSettings, pts: 2 };
    expect(modelFingerprint(rescored)).not.toBe(modelFingerprint(snapshot));
  });
});
