import { describe, it, expect } from "vitest";
import { lastSeen, utcMinute, workerLabel } from "./format";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("lastSeen", () => {
  it("says seconds under a minute, minutes under an hour, hours under a day, then days", () => {
    expect(lastSeen(ago(0), NOW)).toBe("0 s ago");
    expect(lastSeen(ago(12_400), NOW)).toBe("12 s ago");
    expect(lastSeen(ago(59_999), NOW)).toBe("59 s ago");
    expect(lastSeen(ago(60_000), NOW)).toBe("1 min ago");
    expect(lastSeen(ago(3_599_999), NOW)).toBe("59 min ago");
    expect(lastSeen(ago(2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(lastSeen(ago(3 * 86_400_000), NOW)).toBe("3 d ago");
  });

  it("shows a dash when there is no time, and 0 s for a slightly-future clock", () => {
    expect(lastSeen(null, NOW)).toBe("—");
    expect(lastSeen(new Date(NOW.getTime() + 2000).toISOString(), NOW)).toBe("0 s ago");
  });
});

describe("utcMinute", () => {
  it("formats as YYYY-MM-DD HH:MM in UTC, or a dash", () => {
    expect(utcMinute("2026-10-07T09:05:59.999Z")).toBe("2026-10-07 09:05");
    expect(utcMinute(null)).toBe("—");
  });
});

describe("workerLabel", () => {
  it("names each worker readably", () => {
    expect(["job-ingestion", "matching", "maintenance", "browser"].map(workerLabel)).toEqual([
      "Job ingestion", "Matching", "Maintenance", "Browser autofill",
    ]);
  });
});
