import { describe, expect, it } from "vitest";
import { pullCloses } from "./sheetGestures.ts";

describe("pullCloses", () => {
  it("closes on a long pull whatever its speed, and on a quick flick once it has moved a little", () => {
    expect(pullCloses(150, 0, 800)).toBe(true);
    expect(pullCloses(100, 0, 800)).toBe(false);
    expect(pullCloses(40, 0.8, 800)).toBe(true);
    expect(pullCloses(20, 2, 800)).toBe(false);
  });

  it("needs less on a short sheet, and never closes on no pull", () => {
    expect(pullCloses(90, 0, 320)).toBe(true);
    expect(pullCloses(0, 3, 800)).toBe(false);
  });
});
