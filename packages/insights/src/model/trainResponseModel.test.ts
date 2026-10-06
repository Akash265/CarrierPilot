import { describe, it, expect, vi } from "vitest";

vi.mock("./fitLogistic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fitLogistic")>();
  return { ...actual, fitLogistic: vi.fn(actual.fitLogistic) };
});

import { fitLogistic } from "./fitLogistic";
import { blendWeight, trainResponseModel, trainingRows } from "./trainResponseModel";
import { modelRecord, randomFactors, seededRandom, syntheticHistory } from "./testing";

const SETTINGS = { minDecided: 30, minPerClass: 8 };
/** Responses follow the skills factor: above 0.5 responds. */
const skillsDriven = () => syntheticHistory(40, 7, (f) => (f.skillsScore ?? 0) > 0.5);

describe("trainingRows", () => {
  it("keeps decided, non-external records that have factor scores", () => {
    const random = seededRandom(1);
    const rows = trainingRows([
      modelRecord("positive", randomFactors(random)),
      modelRecord("negative", randomFactors(random)),
      modelRecord("undecided", randomFactors(random)),
      modelRecord("excluded", randomFactors(random)),
      modelRecord("positive", null),
      modelRecord("positive", randomFactors(random), { external: true }),
    ]);
    expect(rows.map((r) => r.y)).toEqual([1, 0]);
  });
});

describe("blendWeight", () => {
  it("is decided / 200, capped at one half", () => {
    expect(blendWeight(30)).toBeCloseTo(0.15, 12);
    expect(blendWeight(100)).toBe(0.5);
    expect(blendWeight(500)).toBe(0.5);
  });
});

describe("trainResponseModel gates", () => {
  it("is insufficient_data below the decided minimum, without evaluating", () => {
    const result = trainResponseModel(syntheticHistory(29, 7, (f) => (f.skillsScore ?? 0) > 0.5), SETTINGS);
    expect(result).toMatchObject({ status: "insufficient_data", decided: 29, looLogLoss: null, baselineLogLoss: null, model: null, blendWeight: null });
  });

  it("is insufficient_data when either class has fewer than the per-class minimum", () => {
    const fewResponses = syntheticHistory(40, 7, (f) => (f.skillsScore ?? 0) > 0.85);
    const result = trainResponseModel(fewResponses, SETTINGS);
    expect(result.responses).toBeLessThan(8);
    expect(result.status).toBe("insufficient_data");
  });

  it("is insufficient_data when only the non-responses fall below the per-class minimum", () => {
    const random = seededRandom(3);
    const records = Array.from({ length: 40 }, (_, i) => modelRecord(i < 33 ? "positive" : "negative", randomFactors(random)));
    const result = trainResponseModel(records, SETTINGS);
    expect(result).toMatchObject({ responses: 33, nonResponses: 7, status: "insufficient_data", looLogLoss: null });
  });

  it("is no_pattern, with no losses, when the full fit fails after the count gate passed (spec §4.2)", () => {
    // The full fit is the first fitLogistic call; a failing fit is guarded but practically unreachable at lambda 1.
    vi.mocked(fitLogistic).mockReturnValueOnce(null);
    const result = trainResponseModel(skillsDriven(), SETTINGS);
    expect(result).toMatchObject({
      status: "no_pattern", decided: 40, looLogLoss: null, baselineLogLoss: null, blendWeight: null, model: null,
    });
  });

  it("is insufficient_data when no factor varies", () => {
    const flat = Array.from({ length: 40 }, (_, i) =>
      modelRecord(i % 2 === 0 ? "positive" : "negative", randomFactors(() => 0.5)));
    expect(trainResponseModel(flat, SETTINGS).status).toBe("insufficient_data");
  });

  it("is active when the history has a real pattern, with counts, both losses and the blend weight", () => {
    const result = trainResponseModel(skillsDriven(), SETTINGS);
    expect(result.status).toBe("active");
    expect(result.decided).toBe(40);
    expect(result.responses + result.nonResponses).toBe(40);
    expect(result.looLogLoss!).toBeLessThan(result.baselineLogLoss!);
    expect(result.blendWeight).toBeCloseTo(0.2, 12);
    expect(result.model!.scaling.keys).toHaveLength(9);
  });

  it("is no_pattern when responses are unrelated to the factors", () => {
    const result = trainResponseModel(syntheticHistory(40, 11, (_f, random) => random() < 0.5), SETTINGS);
    expect(result.status).toBe("no_pattern");
    expect(result.looLogLoss!).toBeGreaterThanOrEqual(result.baselineLogLoss!);
    expect(result.model).toBeNull();
    expect(result.blendWeight).toBeNull();
  });

  it("is deterministic", () => {
    expect(trainResponseModel(skillsDriven(), SETTINGS)).toEqual(trainResponseModel(skillsDriven(), SETTINGS));
  });
});
