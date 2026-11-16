import { describe, expect, it } from "vitest";
import { Cache } from "./cache.ts";

function setup() {
  let time = 1_000_000;
  const cache = new Cache({ dir: null, now: () => time });
  return { cache, advance: (ms: number) => (time += ms) };
}

describe("Cache", () => {
  it("reuses a value until its TTL passes", async () => {
    const { cache, advance } = setup();
    let calls = 0;
    const load = async () => ++calls;

    expect((await cache.get("k", 1000, load)).value).toBe(1);
    advance(999);
    expect((await cache.get("k", 1000, load)).value).toBe(1);
    advance(2);
    expect((await cache.get("k", 1000, load)).value).toBe(2);
  });

  it("reloads early when forced", async () => {
    const { cache } = setup();
    let calls = 0;
    const load = async () => ++calls;

    await cache.get("k", 1000, load);
    expect((await cache.get("k", 1000, load, { force: true })).value).toBe(2);
  });

  it("shares one loader call between concurrent requests", async () => {
    const { cache } = setup();
    let calls = 0;
    const load = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ++calls;
    };

    const [a, b] = await Promise.all([cache.get("k", 1000, load), cache.get("k", 1000, load)]);
    expect([a.value, b.value, calls]).toEqual([1, 1, 1]);
  });

  it("serves the older value, marked stale, when a refresh fails", async () => {
    const { cache, advance } = setup();
    await cache.get("k", 1000, async () => "old");
    advance(5000);

    const result = await cache.get("k", 1000, async () => {
      throw new Error("network down");
    });
    expect(result).toMatchObject({ value: "old", stale: true });
  });

  it("surfaces the error when nothing is cached yet", async () => {
    const { cache } = setup();
    await expect(
      cache.get("k", 1000, async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
  });

  it("reports the age of a cached value", async () => {
    const { cache, advance } = setup();
    expect(await cache.age("k")).toBeNull();
    await cache.get("k", 1000, async () => 1);
    advance(250);
    expect(await cache.age("k")).toBe(250);
  });
});
