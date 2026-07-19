import { describe, expect, it } from "vitest";

import { TimeSeconds } from "../types/branded";

describe("TimeSeconds brand (T-15)", () => {
  it("preserves Infinity for live durations", () => {
    // Before T-15 this laundered Infinity to 0, zeroing live durations (F-08).
    expect(TimeSeconds(Infinity)).toBe(Infinity);
  });

  it("passes through finite non-negative values", () => {
    expect(TimeSeconds(0)).toBe(0);
    expect(TimeSeconds(123.4)).toBe(123.4);
  });

  it("rejects negatives and NaN to 0", () => {
    expect(TimeSeconds(-5)).toBe(0);
    expect(TimeSeconds(Number.NaN)).toBe(0);
  });
});
