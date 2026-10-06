import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@ai-career/insights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/insights")>();
  return { ...actual, trainResponseModel: vi.fn(actual.trainResponseModel) };
});

import { trainResponseModel } from "@ai-career/insights";
import { trainResponseModelSafely } from "./responseModel";

const ENV = { DEFAULT_USER_ID: "u", OUTCOME_UNDECIDED_DAYS: 30, OUTCOME_MODEL_MIN_DECIDED: 30, OUTCOME_MODEL_MIN_PER_CLASS: 8 };

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
