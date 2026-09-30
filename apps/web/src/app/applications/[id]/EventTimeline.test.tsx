// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { describeEvent } from "./EventTimeline";

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ id: "e", type, occurredAt: "2026-10-01T00:00:00Z", fromStatus: null, toStatus: null, detail: {}, ...extra });

describe("describeEvent", () => {
  it("describes each event type in plain words", () => {
    expect(describeEvent(ev("status_change", { toStatus: "applied" }))).toBe("Applied");
    expect(describeEvent(ev("status_change", { fromStatus: "applied", toStatus: "rejected" }))).toBe("Status: Applied → Rejected");
    expect(describeEvent(ev("note", { detail: { text: "Called" } }))).toBe("Note: Called");
    expect(describeEvent(ev("recruiter_contact", { detail: { channel: "linkedin", summary: "Intro" } }))).toBe("Recruiter contact (linkedin): Intro");
    expect(describeEvent(ev("interview", { detail: { round: 2, kind: "technical", summary: "" } }))).toBe("Interview round 2 (technical)");
    expect(describeEvent(ev("follow_up_done"))).toBe("Follow-up done");
    expect(describeEvent(ev("follow_up_snoozed", { detail: { newFollowUpAt: "2026-10-08" } }))).toBe("Follow-up snoozed to 2026-10-08");
    expect(describeEvent(ev("documents_purged"))).toBe("Generated documents deleted after the retention period");
  });
});
