import { describe, it, expect } from "vitest";
import { labelOutcome, type LabelInput } from "./labels";
import type { InsightEvent } from "../types";

const NOW = new Date("2026-10-06T12:00:00Z");
const OPTS = { now: NOW, undecidedDays: 30 };
const ev = (type: InsightEvent["type"], at: string, toStatus: InsightEvent["toStatus"] = null): InsightEvent => ({
  applicationId: "a1", type, occurredAt: new Date(at), toStatus,
});
const input = (over: Partial<LabelInput>): LabelInput => ({ status: "applied", appliedAt: "2026-10-01", events: [], ...over });

describe("labelOutcome", () => {
  it("leaves a fresh open application undecided for both tiers", () => {
    const r = labelOutcome(input({}), OPTS);
    expect(r.response).toEqual({ label: "undecided", reason: "Undecided: last activity on 2026-10-01" });
    expect(r.interview.label).toBe("undecided");
  });

  it("uses history: screening then rejected is a response but not an interview", () => {
    const r = labelOutcome(input({
      status: "rejected",
      events: [ev("status_change", "2026-10-01T09:00:00Z", "applied"), ev("status_change", "2026-10-03T09:00:00Z", "screening"),
        ev("status_change", "2026-10-04T09:00:00Z", "rejected")],
    }), OPTS);
    expect(r.response).toEqual({ label: "positive", reason: "Response: reached screening on 2026-10-03" });
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: rejected" });
  });

  it("counts a recruiter contact as a response and an interview event as both", () => {
    const contact = labelOutcome(input({ events: [ev("recruiter_contact", "2026-10-02T10:00:00Z")] }), OPTS);
    expect(contact.response).toEqual({ label: "positive", reason: "Response: recruiter contact on 2026-10-02" });
    expect(contact.interview.label).toBe("undecided");

    const interview = labelOutcome(input({ status: "rejected", events: [ev("interview", "2026-10-02T10:00:00Z")] }), OPTS);
    expect(interview.response.label).toBe("positive");
    expect(interview.interview).toEqual({ label: "positive", reason: "Interview: interview logged for 2026-10-02" });
  });

  it("picks the earliest evidence for the reason", () => {
    const r = labelOutcome(input({
      status: "interviewing",
      events: [ev("status_change", "2026-10-05T00:00:00Z", "interviewing"), ev("recruiter_contact", "2026-10-02T00:00:00Z")],
    }), OPTS);
    expect(r.response.reason).toBe("Response: recruiter contact on 2026-10-02");
    expect(r.interview.reason).toBe("Interview: reached interviewing on 2026-10-05");
  });

  it("falls back to the current status when no event records the stage", () => {
    const r = labelOutcome(input({ status: "offer" }), OPTS);
    expect(r.response).toEqual({ label: "positive", reason: "Response: status is offer" });
    expect(r.interview).toEqual({ label: "positive", reason: "Interview: status is offer" });
  });

  it("treats accepted and declined (an offer) as positive for both tiers, even straight from applied", () => {
    for (const status of ["accepted", "declined"] as const) {
      const r = labelOutcome(input({ status, events: [ev("status_change", "2026-10-02T00:00:00Z", status)] }), OPTS);
      expect(r.response.label).toBe("positive");
      expect(r.interview.label).toBe("positive");
    }
  });

  it("labels rejected and no_response without evidence negative for both tiers", () => {
    expect(labelOutcome(input({ status: "rejected" }), OPTS).response).toEqual({ label: "negative", reason: "No response: rejected" });
    const noResponse = labelOutcome(input({ status: "no_response" }), OPTS);
    expect(noResponse.response).toEqual({ label: "negative", reason: "No response: marked no response" });
    expect(noResponse.interview).toEqual({ label: "negative", reason: "No interview: marked no response" });
  });

  it("excludes a withdrawal unless the tier already has evidence", () => {
    const plain = labelOutcome(input({ status: "withdrawn" }), OPTS);
    expect(plain.response).toEqual({ label: "excluded", reason: "Excluded: withdrawn" });
    expect(plain.interview.label).toBe("excluded");

    const afterInterview = labelOutcome(input({ status: "withdrawn", events: [ev("interview", "2026-10-02T00:00:00Z")] }), OPTS);
    expect(afterInterview.response.label).toBe("positive");
    expect(afterInterview.interview.label).toBe("positive");
  });

  it("turns an idle open application negative exactly at the cutoff", () => {
    const base = input({ appliedAt: "2026-09-06" });
    const atCutoff = new Date("2026-10-06T00:00:00Z");
    expect(labelOutcome(base, { now: new Date(atCutoff.getTime() - 1), undecidedDays: 30 }).response.label).toBe("undecided");
    const r = labelOutcome(base, { now: atCutoff, undecidedDays: 30 });
    expect(r.response).toEqual({ label: "negative", reason: "No response: no activity for 30 days" });
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: no activity for 30 days" });
  });

  it("applies the idle rule per tier: screening that went quiet is a response but no interview", () => {
    const r = labelOutcome(input({
      status: "screening", appliedAt: "2026-08-01", events: [ev("status_change", "2026-08-03T00:00:00Z", "screening")],
    }), OPTS);
    expect(r.response.label).toBe("positive");
    expect(r.interview).toEqual({ label: "negative", reason: "No interview: no activity for 30 days" });
  });

  it("measures activity from status changes and contacts, and ignores other event types", () => {
    const recent = labelOutcome(input({
      appliedAt: "2026-08-01", events: [ev("status_change", "2026-10-01T00:00:00Z", "applied")],
    }), OPTS);
    expect(recent.response.label).toBe("undecided");
    expect(recent.lastActivityAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");

    const noteOnly = labelOutcome(input({
      appliedAt: "2026-08-01",
      events: [{ applicationId: "a1", type: "note" as never, occurredAt: new Date("2026-10-05T00:00:00Z"), toStatus: null }],
    }), OPTS);
    expect(noteOnly.response.label).toBe("negative");
    expect(noteOnly.lastActivityAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("counts a future-dated interview as evidence", () => {
    const r = labelOutcome(input({ events: [ev("interview", "2026-10-20T09:00:00Z")] }), OPTS);
    expect(r.interview.label).toBe("positive");
  });

  it("never lets an offer fall to the idle rule for the interview tier", () => {
    const r = labelOutcome(input({ status: "offer", appliedAt: "2026-06-01" }), OPTS);
    expect(r.interview.label).toBe("positive");
  });
});
