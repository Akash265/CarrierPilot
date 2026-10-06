import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

vi.mock("@ai-career/insights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/insights")>();
  return { ...actual, trainResponseModel: vi.fn(actual.trainResponseModel) };
});

import { trainResponseModel, type FactorVector, type OutcomeRecord } from "@ai-career/insights";
import { clearResponseModelCache, trainResponseModelSafely } from "./responseModel";

const ENV = { DEFAULT_USER_ID: "u", OUTCOME_UNDECIDED_DAYS: 30, OUTCOME_MODEL_MIN_DECIDED: 30, OUTCOME_MODEL_MIN_PER_CLASS: 8 };

const factors = (skills: number): FactorVector => ({
  skillsScore: skills, experienceScore: 0.5, locationScore: 0.5, sponsorshipScore: 0.5, roleScore: 0.5,
  salaryScore: null, industryScore: 0.5, freshnessScore: 0.5, semanticScore: 0.5,
});
const record = (i: number, skills: number, positive: boolean): OutcomeRecord => ({
  applicationId: `a${i}`, external: false, appliedAt: "2026-09-01",
  response: { label: positive ? "positive" : "negative", reason: "" }, interview: { label: "undecided", reason: "" },
  roleFamily: { key: "__other__", label: "Other" }, company: { key: "acme", label: "Acme" }, workMode: null, countryCode: null,
  salaryVsFloor: null, matchScore: null, atsScore: null, requiredKeywordCoverage: null, postingAgeDays: null, documents: null,
  missedRequiredTerms: null, factors: factors(skills),
});
const history = () => Array.from({ length: 12 }, (_, i) => record(i, i / 12, i % 2 === 0));

beforeEach(() => {
  clearResponseModelCache();
  vi.mocked(trainResponseModel).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("trainResponseModelSafely", () => {
  it("passes the env gate settings through and summarizes the result", () => {
    const { result, summary } = trainResponseModelSafely([], ENV);
    expect(result.status).toBe("insufficient_data");
    expect(summary).toEqual({
      status: "insufficient_data", decided: 0, responses: 0, nonResponses: 0, minDecided: 30, minPerClass: 8, blendWeight: null,
    });
  });

  it("degrades to no_pattern when training throws, logging only the error class", () => {
    vi.mocked(trainResponseModel).mockImplementationOnce(() => {
      throw new RangeError("secret application text");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result, summary } = trainResponseModelSafely([], ENV);
    expect(result).toMatchObject({ status: "no_pattern", model: null, blendWeight: null });
    expect(summary.status).toBe("no_pattern");
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "response_model_failed", error: "RangeError" }));
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
  });
});

describe("trainResponseModelSafely cache", () => {
  it("does not retrain for identical training rows and settings", () => {
    const first = trainResponseModelSafely(history(), ENV);
    const second = trainResponseModelSafely(history(), ENV);
    expect(trainResponseModel).toHaveBeenCalledTimes(1);
    expect(second.result).toEqual(first.result);
    expect(second.summary).toEqual(first.summary);
  });

  it("ignores records that are not training rows when deciding whether to retrain", () => {
    trainResponseModelSafely(history(), ENV);
    const withUndecided = [...history(), { ...record(99, 0.3, true), response: { label: "undecided" as const, reason: "" } }];
    trainResponseModelSafely(withUndecided, ENV);
    expect(trainResponseModel).toHaveBeenCalledTimes(1);
  });

  it("retrains when a training row changes", () => {
    trainResponseModelSafely(history(), ENV);
    const changed = history();
    changed[3] = record(3, 0.99, true);
    trainResponseModelSafely(changed, ENV);
    expect(trainResponseModel).toHaveBeenCalledTimes(2);
  });

  it("retrains when the gate settings or the user change", () => {
    trainResponseModelSafely(history(), ENV);
    trainResponseModelSafely(history(), { ...ENV, OUTCOME_MODEL_MIN_DECIDED: 10 });
    trainResponseModelSafely(history(), { ...ENV, OUTCOME_MODEL_MIN_DECIDED: 10, OUTCOME_MODEL_MIN_PER_CLASS: 3 });
    trainResponseModelSafely(history(), { ...ENV, OUTCOME_MODEL_MIN_DECIDED: 10, OUTCOME_MODEL_MIN_PER_CLASS: 3, DEFAULT_USER_ID: "v" });
    expect(trainResponseModel).toHaveBeenCalledTimes(4);
  });

  it("never caches a failed training: the next identical call trains again", () => {
    vi.mocked(trainResponseModel).mockImplementationOnce(() => {
      throw new RangeError("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(trainResponseModelSafely(history(), ENV).result.status).toBe("no_pattern");
    const retry = trainResponseModelSafely(history(), ENV);
    expect(trainResponseModel).toHaveBeenCalledTimes(2);
    expect(retry.result.status).toBe("insufficient_data");
  });
});
