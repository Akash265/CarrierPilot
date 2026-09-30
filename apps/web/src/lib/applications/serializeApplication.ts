import type { ApplicationEventRow, ApplicationRow } from "@ai-career/applications";

export interface ApplicationView {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  jobUrl: string | null;
  status: ApplicationRow["status"];
  statusChangedAt: string;
  appliedAt: string;
  followUpAt: string | null;
  recruiterName: string | null;
  recruiterContact: string | null;
  salaryNotes: string | null;
  notes: string | null;
  resumeOptimizationId: string | null;
  applicationPitchId: string | null;
  coverLetterId: string | null;
  terminalAt: string | null;
  retentionPurgedAt: string | null;
  external: boolean;
  snapshotSummary: {
    matchOverall: number | null;
    atsOverall: number | null;
    documents: { resume: number | null; pitch: number | null; coverLetter: number | null };
  };
  createdAt: string;
}

export interface ApplicationEventView {
  id: string;
  type: ApplicationEventRow["type"];
  occurredAt: string;
  fromStatus: string | null;
  toStatus: string | null;
  detail: unknown;
}

type LooseSnapshot = {
  external?: boolean;
  match?: { overallScore?: number | null } | null;
  ats?: { overallScore?: number | null } | null;
  documents?: Record<"resume" | "pitch" | "coverLetter", { version?: number } | null> | null;
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The full snapshot stays server-side (Phase 10 input); the UI gets a one-line summary. */
export function toApplicationView(row: ApplicationRow): ApplicationView {
  const s = (row.featureSnapshot ?? {}) as LooseSnapshot;
  return {
    id: row.id,
    jobId: row.jobId,
    companyName: row.companyName,
    jobTitle: row.jobTitle,
    jobUrl: row.jobUrl,
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    appliedAt: row.appliedAt,
    followUpAt: row.followUpAt,
    recruiterName: row.recruiterName,
    recruiterContact: row.recruiterContact,
    salaryNotes: row.salaryNotes,
    notes: row.notes,
    resumeOptimizationId: row.resumeOptimizationId,
    applicationPitchId: row.applicationPitchId,
    coverLetterId: row.coverLetterId,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    retentionPurgedAt: row.retentionPurgedAt?.toISOString() ?? null,
    external: s.external === true,
    snapshotSummary: {
      matchOverall: numOrNull(s.match?.overallScore),
      atsOverall: numOrNull(s.ats?.overallScore),
      documents: {
        resume: numOrNull(s.documents?.resume?.version),
        pitch: numOrNull(s.documents?.pitch?.version),
        coverLetter: numOrNull(s.documents?.coverLetter?.version),
      },
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export function toEventView(row: ApplicationEventRow): ApplicationEventView {
  return {
    id: row.id, type: row.type, occurredAt: row.occurredAt.toISOString(), fromStatus: row.fromStatus, toStatus: row.toStatus, detail: row.detail,
  };
}
