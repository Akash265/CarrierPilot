const MS_PER_DAY = 86_400_000;
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** The jobs-table fields the snapshot reads (numeric columns arrive from Drizzle as strings). */
export interface SnapshotJobInput {
  title: string;
  companyName: string;
  seniority: string | null;
  countryCode: string | null;
  locationRaw: string | null;
  workMode: string;
  employmentType: string | null;
  salaryMin: string | null;
  salaryMax: string | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  sponsorship: string;
  postedAt: Date | null;
  firstSeenAt: Date;
}

export interface SnapshotMatchInput {
  careerGoalId: string;
  eligible: boolean;
  overallScore: string | null;
  skillsScore: string | null;
  experienceScore: string | null;
  locationScore: string | null;
  sponsorshipScore: string | null;
  roleScore: string | null;
  salaryScore: string | null;
  industryScore: string | null;
  freshnessScore: string | null;
  semanticScore: string | null;
  computedAt: Date;
}

export interface SnapshotAtsInput {
  overallScore: string;
  requiredKeywordCoverage: string;
  preferredKeywordCoverage: string;
  semanticSimilarity: string | null;
}

export interface SnapshotDocumentRef {
  id: string;
  version: number;
  /** generated / user_edited for pitch and cover letter; null for the resume optimization. */
  origin: "generated" | "user_edited" | null;
  sourceProfileContentHash: string | null;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

export interface FeatureSnapshot {
  snapshotVersion: 2;
  external: boolean;
  job: { title: string; companyName: string } & Nullable<{
    seniority: string; countryCode: string; locationRaw: string; workMode: string; employmentType: string;
    salaryMin: number; salaryMax: number; salaryCurrency: string; salaryPeriod: string; sponsorship: string; postingAgeDays: number;
  }>;
  match: {
    careerGoalId: string; eligible: boolean; computedAt: string;
    overallScore: number | null; skillsScore: number | null; experienceScore: number | null; locationScore: number | null;
    sponsorshipScore: number | null; roleScore: number | null; salaryScore: number | null; industryScore: number | null;
    freshnessScore: number | null; semanticScore: number | null;
  } | null;
  ats: {
    overallScore: number; requiredKeywordCoverage: number; preferredKeywordCoverage: number; semanticSimilarity: number | null;
    /** v2 (Phase 10a): required job terms the sent resume text did not contain. null = unknown. */
    missedRequiredTerms: string[] | null;
  } | null;
  documents: { resume: SnapshotDocumentRef | null; pitch: SnapshotDocumentRef | null; coverLetter: SnapshotDocumentRef | null } | null;
}

export type BuildSnapshotInput =
  | { kind: "external"; companyName: string; jobTitle: string }
  | {
      kind: "ingested";
      job: SnapshotJobInput;
      match: SnapshotMatchInput | null;
      ats: SnapshotAtsInput | null;
      documents: { resume: SnapshotDocumentRef | null; pitch: SnapshotDocumentRef | null; coverLetter: SnapshotDocumentRef | null };
      /** YYYY-MM-DD */
      appliedAt: string;
      /** v2: required job terms the linked optimized resume missed; null when no optimization is linked. */
      missedRequiredTerms: string[] | null;
    };

/**
 * Phase 9 design §3: what was true when the user applied, for Phase 10. job_matches is overwritten on
 * every matching run and retention deletes the documents, so this is the only durable record. Missing
 * parts are null, never zero (a missing salary is not a salary of 0).
 * v2 (Phase 10a) adds ats.missedRequiredTerms; v1 snapshots stay as written (write-once).
 */
export function buildFeatureSnapshot(input: BuildSnapshotInput): FeatureSnapshot {
  if (input.kind === "external") {
    return {
      snapshotVersion: 2,
      external: true,
      job: {
        title: input.jobTitle, companyName: input.companyName, seniority: null, countryCode: null, locationRaw: null, workMode: null,
        employmentType: null, salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, sponsorship: null, postingAgeDays: null,
      },
      match: null,
      ats: null,
      documents: null,
    };
  }

  const { job, match, ats } = input;
  const reference = job.postedAt ?? job.firstSeenAt;
  const appliedMs = Date.parse(`${input.appliedAt}T00:00:00Z`);
  const postingAgeDays = Math.max(0, Math.floor((appliedMs - reference.getTime()) / MS_PER_DAY));

  return {
    snapshotVersion: 2,
    external: false,
    job: {
      title: job.title, companyName: job.companyName, seniority: job.seniority, countryCode: job.countryCode, locationRaw: job.locationRaw,
      workMode: job.workMode, employmentType: job.employmentType, salaryMin: num(job.salaryMin), salaryMax: num(job.salaryMax),
      salaryCurrency: job.salaryCurrency, salaryPeriod: job.salaryPeriod, sponsorship: job.sponsorship, postingAgeDays,
    },
    match: match && {
      careerGoalId: match.careerGoalId, eligible: match.eligible, computedAt: match.computedAt.toISOString(),
      overallScore: num(match.overallScore), skillsScore: num(match.skillsScore), experienceScore: num(match.experienceScore),
      locationScore: num(match.locationScore), sponsorshipScore: num(match.sponsorshipScore), roleScore: num(match.roleScore),
      salaryScore: num(match.salaryScore), industryScore: num(match.industryScore), freshnessScore: num(match.freshnessScore),
      semanticScore: num(match.semanticScore),
    },
    ats: ats && {
      overallScore: Number(ats.overallScore), requiredKeywordCoverage: Number(ats.requiredKeywordCoverage),
      preferredKeywordCoverage: Number(ats.preferredKeywordCoverage), semanticSimilarity: num(ats.semanticSimilarity),
      missedRequiredTerms: input.missedRequiredTerms,
    },
    documents: input.documents,
  };
}
