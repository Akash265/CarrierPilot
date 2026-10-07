import { describe, it, expect } from "vitest";
import { AI_OPERATIONS } from "@ai-career/ai";
import { formatUsd, operationLabel, percentOfCeiling } from "./format";

describe("formatUsd", () => {
  it("shows whole cents, and a sub-cent amount as <$0.01", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.005)).toBe("$0.01");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});

describe("percentOfCeiling", () => {
  it("floors, so 79.9% is never shown as 80%", () => {
    expect(percentOfCeiling(15.98, 20)).toBe(79);
    expect(percentOfCeiling(16, 20)).toBe(80);
    expect(percentOfCeiling(25, 20)).toBe(125);
  });
});

describe("operationLabel", () => {
  it("has a readable label for every operation", () => {
    for (const op of AI_OPERATIONS) expect(operationLabel(op)).not.toBe(op);
  });

  it("falls back to the raw name for an operation it does not know", () => {
    expect(operationLabel("future_operation")).toBe("future_operation");
  });
});
