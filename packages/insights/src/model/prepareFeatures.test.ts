import { describe, it, expect } from "vitest";
import { fitScaling, standardize } from "./prepareFeatures";
import type { FactorVector } from "../types";

const vector = (over: Partial<FactorVector> = {}): FactorVector => ({
  skillsScore: null, experienceScore: null, locationScore: null, sponsorshipScore: null, roleScore: null, salaryScore: null,
  industryScore: null, freshnessScore: null, semanticScore: null, ...over,
});

describe("fitScaling", () => {
  it("computes mean and population standard deviation per factor, in factor order", () => {
    const scaling = fitScaling([vector({ skillsScore: 0.2, roleScore: 1 }), vector({ skillsScore: 0.6, roleScore: 0 })]);
    expect(scaling.keys).toEqual(["skillsScore", "roleScore"]);
    expect(scaling.means[0]).toBeCloseTo(0.4, 12);
    expect(scaling.sds[0]).toBeCloseTo(0.2, 12);
    expect(scaling.means[1]).toBeCloseTo(0.5, 12);
    expect(scaling.sds[1]).toBeCloseTo(0.5, 12);
  });

  it("drops a factor that never varies or has fewer than two values", () => {
    const scaling = fitScaling([
      vector({ skillsScore: 0.5, sponsorshipScore: 1, salaryScore: 0.3 }),
      vector({ skillsScore: 0.7, sponsorshipScore: 1 }),
    ]);
    expect(scaling.keys).toEqual(["skillsScore"]);
  });

  it("ignores missing values when computing the statistics", () => {
    const scaling = fitScaling([vector({ salaryScore: 0 }), vector({ salaryScore: 1 }), vector({})]);
    expect(scaling.means).toEqual([0.5]);
  });
});

describe("standardize", () => {
  it("z-scores kept factors and maps a missing value to 0 (the training mean)", () => {
    const scaling = fitScaling([vector({ skillsScore: 0.2, roleScore: 1 }), vector({ skillsScore: 0.6, roleScore: 0 })]);
    const z = standardize(scaling, vector({ skillsScore: 0.8, roleScore: null, experienceScore: 0.9 }));
    expect(z[0]).toBeCloseTo(2, 12);
    expect(z[1]).toBe(0);
    expect(z).toHaveLength(2);
  });
});
