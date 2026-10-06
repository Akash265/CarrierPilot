import { describe, it, expect } from "vitest";
import { coverageBand, postingAgeBand, scoreBand } from "./bands";

describe("bands", () => {
  it.each([
    [0, "lt50"], [49.99, "lt50"], [50, "50-69"], [69.99, "50-69"], [70, "70-84"], [84.99, "70-84"], [85, "85+"], [100, "85+"],
  ])("score %f -> %s", (score, key) => {
    expect(scoreBand(score).key).toBe(key);
  });

  it.each([
    [0, "lt50"], [0.4999, "lt50"], [0.5, "50-79"], [0.7999, "50-79"], [0.8, "80+"], [1, "80+"],
  ])("coverage %f -> %s", (coverage, key) => {
    expect(coverageBand(coverage).key).toBe(key);
  });

  it.each([
    [0, "0-2"], [2, "0-2"], [3, "3-7"], [7, "3-7"], [8, "8-30"], [30, "8-30"], [31, "31+"], [400, "31+"],
  ])("posting age %i days -> %s", (days, key) => {
    expect(postingAgeBand(days).key).toBe(key);
  });

  it("labels bands for display", () => {
    expect(scoreBand(10).label).toBe("Under 50");
    expect(scoreBand(60).label).toBe("50–69");
    expect(coverageBand(0.9).label).toBe("80%+");
    expect(postingAgeBand(40).label).toBe("31+ days");
  });
});
