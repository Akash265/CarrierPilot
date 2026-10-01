import { describe, it, expect } from "vitest";
import { toApplicationView, toEventView } from "./serializeApplication";

const base = {
  id: "a1", userId: "u", jobId: "j1", companyName: "Acme", jobTitle: "DE", jobUrl: null, status: "applied" as const,
  statusChangedAt: new Date("2026-09-30T10:00:00Z"), appliedAt: "2026-09-30", followUpAt: null, recruiterName: null,
  recruiterContact: null, salaryNotes: null, notes: null, resumeOptimizationId: "r1", applicationPitchId: null, coverLetterId: null,
  terminalAt: null, retentionPurgedAt: null, createdAt: new Date("2026-09-30T10:00:00Z"), updatedAt: new Date("2026-09-30T10:00:00Z"),
};

describe("toApplicationView", () => {
  it("summarizes the snapshot and serializes dates, omitting userId and the full snapshot", () => {
    const view = toApplicationView({
      ...base,
      featureSnapshot: { external: false, match: { overallScore: 78 }, ats: { overallScore: 82 }, documents: { resume: { version: 3 }, pitch: null, coverLetter: { version: 1 } } },
    });
    expect(view).toMatchObject({
      id: "a1", external: false, statusChangedAt: "2026-09-30T10:00:00.000Z",
      snapshotSummary: { matchOverall: 78, atsOverall: 82, documents: { resume: 3, pitch: null, coverLetter: 1 } },
    });
    expect(view).not.toHaveProperty("userId");
    expect(view).not.toHaveProperty("featureSnapshot");
  });

  it("tolerates an external or unexpected snapshot shape", () => {
    expect(toApplicationView({ ...base, jobId: null, featureSnapshot: { external: true, match: null, ats: null, documents: null } }).snapshotSummary)
      .toEqual({ matchOverall: null, atsOverall: null, documents: { resume: null, pitch: null, coverLetter: null } });
    expect(toApplicationView({ ...base, featureSnapshot: {} }).external).toBe(false);
  });
});

describe("toEventView", () => {
  it("serializes an event", () => {
    expect(toEventView({ id: "e1", userId: "u", applicationId: "a1", type: "note", occurredAt: new Date("2026-10-01T00:00:00Z"),
      fromStatus: null, toStatus: null, detail: { text: "x" }, createdAt: new Date() }))
      .toEqual({ id: "e1", type: "note", occurredAt: "2026-10-01T00:00:00.000Z", fromStatus: null, toStatus: null, detail: { text: "x" } });
  });
});
