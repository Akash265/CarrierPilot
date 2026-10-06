import { describe, it, expect } from "vitest";
import { standsOut, wilsonInterval } from "./wilson";

describe("wilsonInterval", () => {
  it.each([
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [5, 10, 0.2366, 0.7634],
    [1, 1, 0.2065, 1],
    [11, 50, 0.1275, 0.3524],
    [3, 5, 0.2307, 0.8824],
  ])("%i of %i -> [%f, %f]", (positives, decided, low, high) => {
    const interval = wilsonInterval(positives, decided);
    expect(interval.low).toBeCloseTo(low, 4);
    expect(interval.high).toBeCloseTo(high, 4);
  });

  it("stays inside [0, 1]", () => {
    expect(wilsonInterval(0, 3).low).toBeGreaterThanOrEqual(0);
    expect(wilsonInterval(3, 3).high).toBeLessThanOrEqual(1);
  });

  it("rejects an empty or impossible sample", () => {
    expect(() => wilsonInterval(0, 0)).toThrow(RangeError);
    expect(() => wilsonInterval(4, 3)).toThrow(RangeError);
    expect(() => wilsonInterval(-1, 3)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 3)).toThrow(RangeError);
  });
});

describe("standsOut", () => {
  it("is higher only when the whole interval is above the overall rate", () => {
    expect(standsOut({ low: 0.31, high: 0.6 }, 0.3)).toBe("higher");
    expect(standsOut({ low: 0.3, high: 0.6 }, 0.3)).toBeNull();
  });

  it("is lower only when the whole interval is below the overall rate", () => {
    expect(standsOut({ low: 0.05, high: 0.29 }, 0.3)).toBe("lower");
    expect(standsOut({ low: 0.05, high: 0.3 }, 0.3)).toBeNull();
  });
});
