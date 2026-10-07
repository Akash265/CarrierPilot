import { describe, it, expect } from "vitest";
import { workerState, failureCode } from "./workerState";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW.getTime() - secondsAgo * 1000).toISOString();

describe("workerState", () => {
  it("is never_seen without a heartbeat", () => {
    expect(workerState(null, NOW, 90_000)).toBe("never_seen");
  });

  it("is running up to and including the stale threshold, stale after it", () => {
    expect(workerState({ startedAt: at(600), beatAt: at(90), pid: 1, stoppedAt: null }, NOW, 90_000)).toBe("running");
    expect(workerState({ startedAt: at(600), beatAt: at(90.001), pid: 1, stoppedAt: null }, NOW, 90_000)).toBe("stale");
  });

  it("is stopped after a clean stop, however long ago", () => {
    expect(workerState({ startedAt: at(9000), beatAt: at(3600), pid: 1, stoppedAt: at(3600) }, NOW, 90_000)).toBe("stopped");
  });

  it("is running again once a restarted worker beats after an old stop", () => {
    expect(workerState({ startedAt: at(10), beatAt: at(5), pid: 2, stoppedAt: at(3600) }, NOW, 90_000)).toBe("running");
  });

  it("treats an unparseable beat time as stale", () => {
    expect(workerState({ startedAt: "x", beatAt: "not a date", pid: 1, stoppedAt: null }, NOW, 90_000)).toBe("stale");
  });
});

describe("failureCode", () => {
  it("passes our own codes through", () => {
    expect(failureCode("no_active_goal")).toBe("no_active_goal");
    expect(failureCode("ingest:rate_limited")).toBe("ingest:rate_limited");
  });

  it("withholds anything that is not code-shaped (it may be a raw error message)", () => {
    expect(failureCode("duplicate key value violates unique constraint")).toBeNull();
    expect(failureCode("Jane Doe")).toBeNull();
    expect(failureCode("")).toBeNull();
    expect(failureCode(undefined)).toBeNull();
    expect(failureCode("a".repeat(81))).toBeNull();
  });
});
