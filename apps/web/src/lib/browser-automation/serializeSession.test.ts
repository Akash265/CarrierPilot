import { describe, it, expect } from "vitest";
import type { SessionRow } from "@ai-career/browser";
import { toSessionView } from "./serializeSession";

const row = {
  id: "s1", userId: "u1", jobId: "j1", applicationId: null, portal: "greenhouse", adapterVersion: "greenhouse-v1",
  formUrl: "https://job-boards.greenhouse.io/acme/jobs/1", status: "awaiting_user", resumeDocumentId: "d1", coverLetterDocumentId: null,
  fieldAudit: [{ key: "f0", label: "Email", required: true, canonical: "email", action: "filled", reason: null, valueSource: "profile.email", verified: true }],
  stoppedBeforeSubmit: true, cancelRequestedAt: new Date("2026-10-01T10:00:00Z"), errorCode: null, submissionDetectedAt: null,
  startedAt: new Date("2026-10-01T09:59:00Z"), endedAt: null, createdAt: new Date("2026-10-01T09:58:00Z"), updatedAt: new Date(),
} as SessionRow;

describe("toSessionView", () => {
  it("exposes the audit and ISO dates, a cancel flag, and no user id", () => {
    const view = toSessionView(row);
    expect(view).toMatchObject({
      id: "s1", status: "awaiting_user", portal: "greenhouse", cancelRequested: true, startedAt: "2026-10-01T09:59:00.000Z",
      endedAt: null, createdAt: "2026-10-01T09:58:00.000Z",
    });
    expect(view.fieldAudit).toHaveLength(1);
    expect(view).not.toHaveProperty("userId");
  });
});
