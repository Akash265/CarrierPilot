import { describe, it, expect } from "vitest";
import { formatFactorPushes, formatLikelyResponse, modelUnavailableReason } from "./formatPersonal";

const P = { probability: 0.354, low: 0.221, high: 0.498, raises: ["Skills", "Role"], lowers: ["Freshness"] };

describe("formatPersonal", () => {
  it("states the likely response with its range", () => {
    expect(formatLikelyResponse(P)).toBe("likely response 35% (22–50%)");
  });

  it("lists the factors that raise and lower it, omitting an empty side", () => {
    expect(formatFactorPushes(P)).toBe("Raises: Skills, Role · Lowers: Freshness");
    expect(formatFactorPushes({ ...P, raises: [] })).toBe("Lowers: Freshness");
    expect(formatFactorPushes({ ...P, raises: [], lowers: [] })).toBe("");
  });

  it("explains why the model is unavailable", () => {
    const base = { decided: 12, responses: 3, minDecided: 30, minPerClass: 8 };
    expect(modelUnavailableReason({ ...base, status: "insufficient_data" })).toBe(
      "Needs 30 decided applications with at least 8 responses and 8 without. You have 12 (3 with a response)."
    );
    expect(modelUnavailableReason({ ...base, status: "no_pattern" })).toBe("Your history doesn't show a pattern that beats your average yet.");
    expect(modelUnavailableReason({ ...base, status: "active" })).toBeNull();
  });
});
