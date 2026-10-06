import { describe, it, expect } from "vitest";
import { trainResponseModel } from "./trainResponseModel";
import { describeFactors } from "./predictResponse";
import { syntheticHistory } from "./testing";
import type { FactorVector } from "../types";

/**
 * Spec §9 evaluation dataset (CLAUDE.md §10 "AI evaluation"): synthetic histories with a known truth. The model
 * must find a planted signal (accuracy), say "no pattern" for noise and "insufficient data" for a tiny history
 * (honesty), and give identical results on every run (consistency).
 */
const SETTINGS = { minDecided: 30, minPerClass: 8 };
const v = (f: FactorVector, key: keyof FactorVector) => f[key] ?? 0;

const CASES: {
  name: string;
  n: number;
  seed: number;
  respond: (f: FactorVector, random: () => number) => boolean;
  status: "insufficient_data" | "no_pattern" | "active";
  topFactors?: string[];
}[] = [
  { name: "signal in skills", n: 40, seed: 7, respond: (f) => v(f, "skillsScore") > 0.5, status: "active", topFactors: ["skillsScore"] },
  {
    name: "signal in skills and role", n: 60, seed: 3, respond: (f) => v(f, "skillsScore") + v(f, "roleScore") > 1,
    status: "active", topFactors: ["roleScore", "skillsScore"],
  },
  { name: "lower freshness responds (negative signal)", n: 40, seed: 5, respond: (f) => v(f, "freshnessScore") < 0.5, status: "active", topFactors: ["freshnessScore"] },
  { name: "pure noise", n: 40, seed: 11, respond: (_f, random) => random() < 0.5, status: "no_pattern" },
  { name: "tiny history", n: 12, seed: 7, respond: (f) => v(f, "skillsScore") > 0.5, status: "insufficient_data" },
];

describe("response model evaluation", () => {
  it.each(CASES)("$name -> $status", ({ n, seed, respond, status, topFactors }) => {
    const result = trainResponseModel(syntheticHistory(n, seed, respond), SETTINGS);
    expect(result.status).toBe(status);
    if (topFactors) {
      const top = describeFactors(result.model!).slice(0, topFactors.length).map((f) => f.key).sort();
      expect(top).toEqual([...topFactors].sort());
    }
  });

  it("finds the direction of a positive signal", () => {
    const result = trainResponseModel(syntheticHistory(40, 7, (f) => v(f, "skillsScore") > 0.5), SETTINGS);
    expect(describeFactors(result.model!)[0]).toMatchObject({ key: "skillsScore", direction: "higher" });
  });

  it("finds the direction of a negative signal", () => {
    const result = trainResponseModel(syntheticHistory(40, 5, (f) => v(f, "freshnessScore") < 0.5), SETTINGS);
    expect(describeFactors(result.model!)[0]).toMatchObject({ key: "freshnessScore", direction: "lower" });
  });

  it("is consistent: every case gives identical results across runs", () => {
    for (const { n, seed, respond } of CASES) {
      expect(trainResponseModel(syntheticHistory(n, seed, respond), SETTINGS))
        .toEqual(trainResponseModel(syntheticHistory(n, seed, respond), SETTINGS));
    }
  });
});
