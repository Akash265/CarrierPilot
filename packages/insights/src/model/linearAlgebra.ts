/** Smallest pivot magnitude treated as non-zero. Below it the matrix is reported as singular. */
const PIVOT_EPSILON = 1e-12;

/**
 * Inverse of a square matrix by Gauss-Jordan elimination with partial pivoting, or null when it is singular.
 * The input is not modified. Sizes here are at most 10 x 10 (intercept + 9 factors), so O(n^3) is trivial.
 */
export function invert(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < PIVOT_EPSILON) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** Matrix (n x m) times vector (m). */
export function multiply(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  return matrix.map((row) => row.reduce((sum, value, j) => sum + value * vector[j], 0));
}
