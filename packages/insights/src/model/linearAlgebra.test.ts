import { describe, it, expect } from "vitest";
import { invert, multiply } from "./linearAlgebra";

describe("invert", () => {
  it("inverts a matrix so that A x inverse(A) is the identity", () => {
    const a = [[4, 7, 2], [3, 6, 1], [2, 5, 3]];
    const inv = invert(a)!;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const cell = a[i].reduce((sum, v, k) => sum + v * inv[k][j], 0);
        expect(cell).toBeCloseTo(i === j ? 1 : 0, 12);
      }
    }
  });

  it("needs row swaps (zero first pivot) and still inverts", () => {
    expect(invert([[0, 1], [1, 0]])).toEqual([[0, 1], [1, 0]]);
  });

  it("returns null for a singular matrix and leaves the input untouched", () => {
    const a = [[1, 2], [2, 4]];
    expect(invert(a)).toBeNull();
    expect(a).toEqual([[1, 2], [2, 4]]);
  });
});

describe("multiply", () => {
  it("multiplies a matrix by a vector", () => {
    expect(multiply([[1, 2], [3, 4]], [5, 6])).toEqual([17, 39]);
  });
});
