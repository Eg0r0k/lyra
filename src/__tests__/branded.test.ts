import { describe, expect, it } from "vitest";

import { PlaybackRate, TimeSeconds } from "../types/branded";

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

describe("PlaybackRate brand (T-22a / F-26)", () => {
  it("clamps finite values — including 0 and negatives — into [0.0625, 16]", () => {
    expect(PlaybackRate(0)).toBe(0.0625);
    expect(PlaybackRate(-1)).toBe(0.0625);
    expect(PlaybackRate(32)).toBe(16);
    expect(PlaybackRate(2)).toBe(2);
  });

  it("falls back to 1 for non-finite inputs", () => {
    expect(PlaybackRate(Number.NaN)).toBe(1);
    expect(PlaybackRate(Infinity)).toBe(1);
  });
});
