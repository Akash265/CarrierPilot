import type { FieldAuditEntry, SessionRow } from "@ai-career/browser";

export interface SessionView {
  id: string;
  jobId: string;
  status: SessionRow["status"];
  portal: SessionRow["portal"];
  adapterVersion: string;
  formUrl: string;
  fieldAudit: FieldAuditEntry[];
  errorCode: string | null;
  applicationId: string | null;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
  stoppedBeforeSubmit: boolean;
  cancelRequested: boolean;
  submissionDetectedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toSessionView(row: SessionRow): SessionView {
  return {
    id: row.id,
    jobId: row.jobId,
    status: row.status,
    portal: row.portal,
    adapterVersion: row.adapterVersion,
    formUrl: row.formUrl,
    fieldAudit: row.fieldAudit as FieldAuditEntry[],
    errorCode: row.errorCode,
    applicationId: row.applicationId,
    resumeDocumentId: row.resumeDocumentId,
    coverLetterDocumentId: row.coverLetterDocumentId,
    stoppedBeforeSubmit: row.stoppedBeforeSubmit,
    cancelRequested: row.cancelRequestedAt !== null,
    submissionDetectedAt: iso(row.submissionDetectedAt),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    createdAt: row.createdAt.toISOString(),
  };
}
