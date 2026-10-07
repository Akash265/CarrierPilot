/**
 * Wall-clock budget for one adversarial / large-input check in this package's tests (D176, generalising D165). These
 * checks exist to catch a *stall* -- catastrophic regex backtracking or a quadratic loop on hostile posting text, which
 * costs seconds to minutes -- not to benchmark. Locally every such case takes ≤ ~1 s (most under 100 ms), but on the
 * CI runner, where turbo runs all packages' suites in parallel, the same cases took up to ~14x longer (1163 ms and
 * 1013 ms against a 1000 ms budget, with code that measured 105 ms and 72 ms locally). 4000 ms absorbs that contention
 * and stays under Vitest's 5 s per-test timeout, so a real stall is still reported by the assertion, not a timeout.
 */
export const STALL_BUDGET_MS = 4000;
