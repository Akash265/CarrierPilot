import { describe, it, expect } from "vitest";
import { NOTO_SANS_REGULAR_BASE64, NOTO_SANS_BOLD_BASE64 } from "./fonts.generated";

// A TrueType font starts with the sfnt version 0x00010000.
const isTrueType = (base64: string) => Buffer.from(base64, "base64").subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));

describe("embedded fonts", () => {
  it("contains Noto Sans Regular and Bold as TrueType data", () => {
    expect(isTrueType(NOTO_SANS_REGULAR_BASE64)).toBe(true);
    expect(isTrueType(NOTO_SANS_BOLD_BASE64)).toBe(true);
    expect(Buffer.from(NOTO_SANS_REGULAR_BASE64, "base64").length).toBeGreaterThan(100_000);
    expect(NOTO_SANS_REGULAR_BASE64).not.toBe(NOTO_SANS_BOLD_BASE64);
  });
});
