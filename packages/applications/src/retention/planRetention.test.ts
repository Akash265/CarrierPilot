import { describe, it, expect } from "vitest";
import { isDueForPurge, planRetention, planOrphanSweep, ORPHAN_MIN_AGE_MS, type RetentionCandidate } from "./planRetention";

const DAY = 86_400_000;
const NOW = new Date("2026-11-01T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const c = (over: Partial<RetentionCandidate>): RetentionCandidate => ({ id: "a", jobId: "j", terminalAt: daysAgo(31), retentionPurgedAt: null, ...over });

describe("isDueForPurge", () => {
  it("is due exactly at the retention boundary, not a millisecond before", () => {
    expect(isDueForPurge(c({ terminalAt: daysAgo(30) }), NOW, 30)).toBe(true);
    expect(isDueForPurge(c({ terminalAt: new Date(daysAgo(30).getTime() + 1) }), NOW, 30)).toBe(false);
  });
  it("is never due when disabled, open, or external", () => {
    expect(isDueForPurge(c({}), NOW, 0)).toBe(false);
    expect(isDueForPurge(c({ terminalAt: null }), NOW, 30)).toBe(false);
    expect(isDueForPurge(c({ jobId: null }), NOW, 30)).toBe(false);
  });
  it("is not due again after a purge, unless the application was reopened and closed again later", () => {
    expect(isDueForPurge(c({ terminalAt: daysAgo(40), retentionPurgedAt: daysAgo(10) }), NOW, 30)).toBe(false);
    expect(isDueForPurge(c({ terminalAt: daysAgo(35), retentionPurgedAt: daysAgo(60) }), NOW, 30)).toBe(true);
  });
});

describe("planRetention", () => {
  it("keeps only due candidates", () => {
    const due = c({ id: "due" });
    expect(planRetention({ candidates: [due, c({ id: "fresh", terminalAt: daysAgo(1) })], now: NOW, retentionDays: 30 })).toEqual([due]);
  });
});

describe("planOrphanSweep", () => {
  it("returns unreferenced objects at least 24h old", () => {
    const objects = [
      { key: "u/referenced.pdf", lastModified: daysAgo(5) },
      { key: "u/orphan-old.pdf", lastModified: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS) },
      { key: "u/orphan-new.pdf", lastModified: new Date(NOW.getTime() - ORPHAN_MIN_AGE_MS + 1) },
    ];
    expect(planOrphanSweep({ objects, referencedKeys: new Set(["u/referenced.pdf"]), now: NOW })).toEqual(["u/orphan-old.pdf"]);
  });
});
