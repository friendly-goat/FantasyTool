import { describe, expect, it } from "vitest";
import { gameChance, planForecast } from "./lineupInputs.ts";
import { GAME_MS, laneValue, type LaneInput, movesBetween, planLineup, type PlayerInput, scoreSteps } from "./lineupPlan.ts";
import type { InjuryNews } from "./injury.ts";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-23T18:00:00Z");
const at = (hours: number) => NOW + hours * HOUR;

const player = (id: string, positions: string[], level: number, tips: number[], chance = 1): PlayerInput => ({
  id,
  name: id,
  positions,
  level,
  spread: 0.3,
  shots: tips.map((tip, index) => ({ gameId: `${id}-${index}`, tip, chance })),
});
const lane = (slot: string, occupant: string | null, kind: LaneInput["kind"] = "empty", points = 0): LaneInput => ({
  slot,
  occupant,
  kind,
  points,
});
/** A lineup where every slot but those given is already locked. */
const lockedRest = (slots: string[]) => slots.map((slot, index) => lane(slot, `locked${index}`, "fixed", 30));

describe("lane value", () => {
  it("is his average for one sure game, more with a second game to fall back on, less when he may miss", () => {
    const steps = scoreSteps(30, 0.3);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    expect(laneValue([{ steps, chance: 1 }])[0]).toBeCloseTo(mean, 6);
    const two = laneValue([{ steps, chance: 1 }, { steps, chance: 1 }]);
    expect(two[0]).toBeGreaterThan(mean);
    expect(two[1]).toBeCloseTo(mean, 6); // lock the first game at what the second is worth
    expect(laneValue([{ steps, chance: 0.5 }])[0]).toBeCloseTo(mean / 2, 6);
  });

  it("never lets a live game finish below its points so far", () => {
    const steps = scoreSteps(20, 0.3);
    expect(laneValue([{ steps, chance: 1, floor: 45 }])[0]).toBeCloseTo(45, 6);
  });
});

describe("lineup plan", () => {
  it("locks a score in hand that beats his games to come, and lets a poor one go", () => {
    const players = [player("star", ["PG"], 25, [at(24)]), player("cold", ["SG"], 30, [at(26)])];
    const plan = planLineup([lane("PG", "star", "hand", 45), lane("SG", "cold", "hand", 8)], players, NOW);
    expect(plan.lanes[0]!.decision).toBe("lock");
    expect(plan.locks.map((entry) => entry.playerId)).toEqual(["star"]);
    expect(plan.lanes[1]!.decision).toBe("pass");
    expect(plan.lanes[1]!.shots.map((shot) => shot.playerId)).toEqual(["cold"]);
    expect(plan.expected).toBeGreaterThan(45 + 8);
  });

  it("gives one slot two games the same night when the first is over before the second tips", () => {
    const players = [player("early", ["SF"], 28, [at(1)]), player("late", ["SF"], 28, [at(1) + GAME_MS + HOUR])];
    const plan = planLineup([...lockedRest(["PG", "SG"]), lane("UTIL", "early")], players, NOW);
    const util = plan.lanes[2]!;
    expect(util.shots.map((shot) => shot.playerId)).toEqual(["early", "late"]);
    // Lock the early game only if it beats what the late one is worth.
    expect(util.shots[0]!.lockAt).toBeGreaterThan(20);
    expect(util.shots[1]!.lockAt).toBeNull();
    // Before the late game: put him in, unless the early game was locked.
    const late = plan.steps.find((step) => step.forPlayers.includes("late"))!;
    expect(late.moves).toEqual([{ kind: "start", playerId: "late", slot: 2, otherId: "early", otherSlot: null }]);
    expect(late.unless).toEqual([{ lane: 2, playerId: "early", lockAt: util.shots[0]!.lockAt }]);
  });

  it("starts a bench player who plays tonight in place of a starter who does not", () => {
    const players = [player("idle", ["C"], 30, [at(48)]), player("bench", ["C"], 22, [at(2)])];
    const plan = planLineup([...lockedRest(["PG"]), lane("UTIL", "idle")], players, NOW);
    expect(plan.steps[0]!.moves).toEqual([{ kind: "start", playerId: "bench", slot: 1, otherId: "idle", otherSlot: null }]);
    // And back for the idle player's game later in the week.
    expect(plan.lanes[1]!.shots.map((shot) => shot.playerId)).toEqual(["bench", "idle"]);
  });

  it("benches a starter whose game tonight is not worth risking a score in hand", () => {
    const players = [player("held", ["PF"], 20, [at(3)])];
    const plan = planLineup([lane("PF", "held", "hand", 60)], players, NOW);
    expect(plan.lanes[0]!.decision).toBe("lock");
    expect(plan.lanes[0]!.shots).toEqual([]);
  });

  it("locks a score in the narrowest slot that takes him, freeing the wider one", () => {
    // Randle-style: a PF holding a big score in F; the PF slot's player is a SF/PF who still plays.
    const players = [player("big", ["PF"], 22, [at(30)]), player("wing", ["SF", "PF"], 26, [at(3)])];
    const plan = planLineup([lane("PF", "wing"), lane("F", "big", "hand", 50)], players, NOW);
    expect(plan.locks).toMatchObject([{ lane: 0, playerId: "big", points: 50, swapWith: { lane: 1, playerId: "wing" } }]);
    expect(plan.lanes[1]!.shots.map((shot) => shot.playerId)).toEqual(["wing"]);
  });

  it("weighs a score in hand against all his games to come, not one at a time", () => {
    // Neither game alone is expected to beat 40, but two chances at one are.
    const players = [player("steady", ["SG"], 38, [at(24), at(48)])];
    const plan = planLineup([lane("SG", "steady", "hand", 40)], players, NOW);
    expect(plan.locks).toEqual([]);
    expect(plan.lanes[0]!.decision).toBe("pass");
    expect(plan.lanes[0]!.shots).toHaveLength(2);
    // A score well above both chances is locked, and the reason says what waiting was worth.
    const high = planLineup([lane("SG", "steady", "hand", 55)], players, NOW);
    expect(high.locks).toMatchObject([{ playerId: "steady", points: 55 }]);
    expect(high.locks[0]!.worth).toBeGreaterThan(38);
    expect(high.locks[0]!.worth).toBeLessThan(55);
    expect(high.locks[0]!.gain).toBeGreaterThanOrEqual(0);
  });

  it("never counts a score in hand while its holder plays a game in another slot", () => {
    // He holds 30 in C; his later game is worth more in UTIL only if his 30 is given up.
    const players = [player("holder", ["C"], 34, [at(24)])];
    const plan = planLineup([lane("C", "holder", "hand", 30), lane("UTIL", null)], players, NOW);
    const value = plan.lanes.reduce((sum, entry) => sum + entry.value, 0);
    // Either he locks 30, or plays on for about 34: never both.
    expect(value).toBeLessThan(30 + 34 - 1);
    expect(plan.expected).toBeCloseTo(value, 6);
  });

  it("plans a full week quickly enough to run again every half minute", () => {
    const slots = ["PG", "SG", "G", "SF", "PF", "F", "C", "UTIL", "UTIL"];
    const positions = [["PG"], ["SG"], ["PG", "SG"], ["SF"], ["PF"], ["SF", "PF"], ["C"], ["PF", "C"], ["SG", "SF"], ["C"], ["PG"], ["SF"], ["PF"], ["SG"]];
    const players = positions.map((list, index) =>
      player(`p${index}`, list, 20 + (index % 5) * 4, [at(2 + (index % 3)), at(26 + (index % 4)), at(50 + (index % 2)), at(74)]),
    );
    const lanes = slots.map((slot, index) => (index < 3 ? lane(slot, `p${index}`, "hand", 25 + index * 5) : lane(slot, `p${index}`)));
    const started = performance.now();
    const plan = planLineup(lanes, players, NOW);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(plan.expected).toBeGreaterThan(0);
    // Every planned game fits its slot and no slot plays two games at once.
    for (const entry of plan.lanes) {
      entry.shots.forEach((shot, index) => {
        if (index > 0) expect(shot.tip - entry.shots[index - 1]!.tip).toBeGreaterThanOrEqual(GAME_MS);
      });
    }
  });

  it("does not rely on a player who will miss his game", () => {
    const players = [player("hurt", ["SG"], 40, [at(2)], 0), player("fit", ["SG"], 15, [at(2)])];
    const plan = planLineup([lane("SG", "hurt")], players, NOW);
    expect(plan.lanes[0]!.shots.map((shot) => shot.playerId)).toEqual(["fit"]);
    expect(plan.steps[0]!.moves[0]).toMatchObject({ kind: "start", playerId: "fit", otherId: "hurt" });
  });

  it("plays the plan out for a win chance that matches its expected total", () => {
    const players = [player("a", ["PG"], 30, [at(2), at(26)]), player("b", ["C"], 25, [at(3)])];
    const plan = planLineup([lane("PG", "a"), lane("C", "b"), lane("UTIL", "x", "fixed", 20)], players, NOW);
    const forecast = planForecast(plan, players, [{ state: "locked", points: 40, gamesLeft: 0, player: null }], 6000, 7);
    expect(forecast.yours).toBeCloseTo(plan.expected, 0);
    expect(forecast.theirs).toBe(40);
    expect(forecast.winChance).toBeGreaterThan(0.5);
  });
});

describe("moves between lineups", () => {
  it("reads two players trading slots as one swap", () => {
    expect(movesBetween(["a", "b", "c"], ["b", "a", "c"])).toEqual([{ kind: "swap", playerId: "b", slot: 0, otherId: "a", otherSlot: 1 }]);
    expect(movesBetween(["a", null], ["a", "d"])).toEqual([{ kind: "start", playerId: "d", slot: 1, otherId: null, otherSlot: null }]);
    expect(movesBetween(["a", "b"], ["a", null])).toEqual([{ kind: "bench", playerId: "b", slot: 1, otherId: null, otherSlot: null }]);
  });
});

describe("chance of playing a game", () => {
  const news = (extra: Partial<InjuryNews>) =>
    ({ status: "Out", asOf: "2026-11-23", returnDate: null, seasonOut: false, reevaluation: false, ...extra }) as InjuryNews;
  it("follows the injury report", () => {
    expect(gameChance(0.9, null, null, "2026-11-24", 0)).toBe(0.9);
    expect(gameChance(0.9, news({ seasonOut: true }), null, "2026-11-24", 0)).toBe(0);
    expect(gameChance(0.9, news({ returnDate: "2026-12-20" }), null, "2026-11-24", 0)).toBe(0);
    expect(gameChance(0.9, news({}), null, "2026-11-24", 0)).toBe(0);
    expect(gameChance(0.9, news({}), null, "2026-11-26", 1)).toBeCloseTo(0.45);
    expect(gameChance(0.9, null, "Questionable", "2026-11-24", 0)).toBeCloseTo(0.54);
  });
});
