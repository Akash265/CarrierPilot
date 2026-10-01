import { describe, it, expect } from "vitest";
import {
  CreateApplicationBodySchema, UpdateApplicationBodySchema, ChangeStatusBodySchema, UserEventBodySchema, DateOnlySchema, todayUtc,
} from "./bodies";

const JOB = "11111111-1111-4111-8111-111111111111";
const future = () => new Date(Date.now() + 3 * 86_400_000).toISOString();
/** UTC calendar date `n` days from now. */
const dayOffset = (n: number) => todayUtc(new Date(Date.now() + n * 86_400_000));

describe("DateOnlySchema / todayUtc", () => {
  it("accepts real YYYY-MM-DD dates only", () => {
    expect(DateOnlySchema.safeParse("2026-02-28").success).toBe(true);
    expect(DateOnlySchema.safeParse("2026-02-30").success).toBe(false);
    expect(DateOnlySchema.safeParse("28/02/2026").success).toBe(false);
  });
  it("formats the UTC date", () => {
    expect(todayUtc(new Date("2026-10-01T23:30:00Z"))).toBe("2026-10-01");
  });
});

describe("CreateApplicationBodySchema", () => {
  it("accepts an ingested job with document links", () => {
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, resumeOptimizationId: JOB, appliedAt: "2026-09-30" }).success).toBe(true);
  });
  it("accepts an external job and trims its text", () => {
    const r = CreateApplicationBodySchema.parse({ external: { companyName: "  Globex ", jobTitle: "Analyst", jobUrl: "https://globex.example/jobs/1" } });
    expect(r.external?.companyName).toBe("Globex");
  });
  it("requires exactly one of jobId and external", () => {
    expect(CreateApplicationBodySchema.safeParse({}).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, external: { companyName: "A", jobTitle: "B" } }).success).toBe(false);
  });
  it("rejects document links on an external application", () => {
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B" }, coverLetterId: JOB }).success).toBe(false);
  });
  it("rejects a non-http URL, a blank company and unknown keys", () => {
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B", jobUrl: "javascript:alert(1)" } }).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "  ", jobTitle: "B" } }).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, featureSnapshot: {} }).success).toBe(false);
  });
  it("accepts automationSessionId only together with jobId", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(CreateApplicationBodySchema.safeParse({ jobId: id, automationSessionId: id }).success).toBe(true);
    const external = CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B" }, automationSessionId: id });
    expect(external.success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ jobId: id, automationSessionId: "nope" }).success).toBe(false);
  });
});

describe("appliedAt bound (not after today, UTC)", () => {
  it("accepts today and past dates on create and update", () => {
    for (const appliedAt of [dayOffset(0), dayOffset(-30)]) {
      expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, appliedAt }).success, appliedAt).toBe(true);
      expect(UpdateApplicationBodySchema.safeParse({ appliedAt }).success, appliedAt).toBe(true);
    }
  });
  it("rejects a future appliedAt on create and update", () => {
    expect(CreateApplicationBodySchema.safeParse({ jobId: JOB, appliedAt: dayOffset(2) }).success).toBe(false);
    expect(CreateApplicationBodySchema.safeParse({ external: { companyName: "A", jobTitle: "B" }, appliedAt: dayOffset(2) }).success).toBe(false);
    expect(UpdateApplicationBodySchema.safeParse({ appliedAt: dayOffset(2) }).success).toBe(false);
  });
});

describe("UpdateApplicationBodySchema", () => {
  it("accepts a partial edit and rejects an empty one", () => {
    expect(UpdateApplicationBodySchema.safeParse({ recruiterName: "Sam", followUpAt: null }).success).toBe(true);
    expect(UpdateApplicationBodySchema.safeParse({}).success).toBe(false);
  });
  it("rejects over-long notes", () => {
    expect(UpdateApplicationBodySchema.safeParse({ notes: "x".repeat(5001) }).success).toBe(false);
  });
});

describe("ChangeStatusBodySchema", () => {
  it("accepts a known status with an optional past occurredAt and note", () => {
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "rejected", occurredAt: "2026-09-01T10:00:00Z", note: "Form email" }).success).toBe(true);
  });
  it("rejects an unknown status and a future occurredAt", () => {
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "ghosted" }).success).toBe(false);
    expect(ChangeStatusBodySchema.safeParse({ toStatus: "rejected", occurredAt: future() }).success).toBe(false);
  });
});

describe("UserEventBodySchema", () => {
  it("accepts each user event type", () => {
    for (const body of [
      { type: "note", detail: { text: "Called back" } },
      { type: "recruiter_contact", detail: { channel: "linkedin", summary: "Intro" } },
      { type: "interview", detail: { round: 2, kind: "technical", scheduledFor: future() } },
      { type: "follow_up_done", detail: {} },
      { type: "follow_up_snoozed", detail: { newFollowUpAt: dayOffset(7) } },
    ]) {
      expect(UserEventBodySchema.safeParse(body).success, body.type).toBe(true);
    }
  });
  it("allows a future occurredAt only for interviews", () => {
    expect(UserEventBodySchema.safeParse({ type: "interview", occurredAt: future(), detail: { kind: "onsite" } }).success).toBe(true);
    expect(UserEventBodySchema.safeParse({ type: "note", occurredAt: future(), detail: { text: "x" } }).success).toBe(false);
  });
  it("requires a snoozed follow-up date strictly after today (UTC)", () => {
    expect(UserEventBodySchema.safeParse({ type: "follow_up_snoozed", detail: { newFollowUpAt: dayOffset(1) } }).success).toBe(true);
    expect(UserEventBodySchema.safeParse({ type: "follow_up_snoozed", detail: { newFollowUpAt: dayOffset(0) } }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "follow_up_snoozed", detail: { newFollowUpAt: dayOffset(-3) } }).success).toBe(false);
  });
  it("rejects system-only types and bad details", () => {
    expect(UserEventBodySchema.safeParse({ type: "status_change", detail: {} }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "documents_purged", detail: {} }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "note", detail: { text: "" } }).success).toBe(false);
    expect(UserEventBodySchema.safeParse({ type: "recruiter_contact", detail: { channel: "fax" } }).success).toBe(false);
  });
});
