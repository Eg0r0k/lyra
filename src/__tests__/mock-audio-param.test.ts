/**
 * Self-tests for the scheduling AudioParam mock in test-utils (T-31).
 *
 * The library's fade/volume/normalization tests rely on this mock computing
 * AudioParam values from an automation timeline. If the mock's own math were
 * wrong, those tests could pass or fail for the wrong reason. These tests pin
 * the mock's semantics directly. The param reads the owning context's
 * `currentTime`, so here the clock is driven by plain assignment (no timers).
 */
import { describe, expect, it } from "vitest";
import { MockAudioContext } from "./test-utils";

interface TestParam {
  value: number;
  setValueAtTime: (value: number, time: number) => void;
  linearRampToValueAtTime: (value: number, time: number) => void;
  exponentialRampToValueAtTime: (value: number, time: number) => void;
  setTargetAtTime: (value: number, time: number, timeConstant: number) => void;
  cancelScheduledValues: (time: number) => void;
}

function newParam(): { ctx: MockAudioContext; param: TestParam } {
  const ctx = new MockAudioContext();
  const node = ctx.createGain() as unknown as { gain: TestParam };
  return { ctx, param: node.gain };
}

describe("mock AudioParam scheduler (T-31)", () => {
  it("setValueAtTime is a step change at its scheduled time", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(0.5, 1);

    ctx.currentTime = 0.5;
    expect(param.value).toBe(1); // before the event → base value

    ctx.currentTime = 1;
    expect(param.value).toBe(0.5); // step applied at t=1
  });

  it("linearRampToValueAtTime interpolates linearly from the previous anchor", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(0, 0);
    param.linearRampToValueAtTime(1, 1);

    ctx.currentTime = 0.5;
    expect(param.value).toBeCloseTo(0.5, 5); // linear midpoint

    ctx.currentTime = 1;
    expect(param.value).toBe(1);
  });

  it("exponentialRampToValueAtTime interpolates geometrically", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(1, 0);
    param.exponentialRampToValueAtTime(4, 1);

    ctx.currentTime = 0.5;
    expect(param.value).toBeCloseTo(2, 5); // 1 * 4^0.5

    ctx.currentTime = 1;
    expect(param.value).toBeCloseTo(4, 5);
  });

  it("exponentialRampToValueAtTime throws for a non-positive target", () => {
    const { param } = newParam();
    param.setValueAtTime(1, 0);

    expect(() => param.exponentialRampToValueAtTime(0, 1)).toThrow(RangeError);
    expect(() => param.exponentialRampToValueAtTime(-1, 1)).toThrow(RangeError);
  });

  it("exponentialRampToValueAtTime throws when the start value is non-positive", () => {
    const { param } = newParam();
    param.setValueAtTime(0, 0); // start value 0 at the current time

    expect(() => param.exponentialRampToValueAtTime(1, 1)).toThrow(RangeError);
  });

  it("setTargetAtTime approaches the target asymptotically", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(1, 0);
    param.setTargetAtTime(0, 0, 0.1); // target 0, time constant 0.1s

    ctx.currentTime = 0;
    expect(param.value).toBeCloseTo(1, 5); // starts at V0

    ctx.currentTime = 0.1;
    expect(param.value).toBeCloseTo(Math.exp(-1), 3); // ~0.368 after one tc

    ctx.currentTime = 1;
    expect(param.value).toBeLessThan(0.01); // ~e^-10 → near target
  });

  it("cancelScheduledValues drops events at or after the given time", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(0.5, 0);
    param.setValueAtTime(0.9, 1);

    param.cancelScheduledValues(1);

    ctx.currentTime = 2;
    expect(param.value).toBe(0.5); // the t=1 event was cancelled
  });

  it("direct value assignment resets the timeline to a constant", () => {
    const { ctx, param } = newParam();
    param.setValueAtTime(0.2, 0);
    ctx.currentTime = 5;
    expect(param.value).toBe(0.2);

    param.value = 0.7;
    ctx.currentTime = 10;
    expect(param.value).toBe(0.7);
  });
});
