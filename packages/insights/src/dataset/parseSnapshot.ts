import { FACTOR_KEYS } from "@ai-career/matching/scoring";
import type { DocumentsSent, FactorVector } from "../types";

/** The parts of a feature snapshot (v1 or v2, packages/applications/src/snapshot.ts) the dataset uses. */
export interface ParsedSnapshot {
  external: boolean;
  careerGoalId: string | null;
  /** 0-100; only for an eligible match. */
  matchScore: number | null;
  workMode: "remote" | "hybrid" | "onsite" | null;
  countryCode: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postingAgeDays: number | null;
  atsScore: number | null;
  requiredKeywordCoverage: number | null;
  /** v2 only; null for v1 snapshots and for applications sent without an optimized resume. */
  missedRequiredTerms: string[] | null;
  documents: DocumentsSent | null;
  /** Phase 10b: the 9 factor scores (0-1) of an eligible match; null when there is no eligible match. */
  factors: FactorVector | null;
}

type Obj = Record<string, unknown>;
const WORK_MODES = new Set(["remote", "hybrid", "onsite"]);

const obj = (value: unknown): Obj | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

/**
 * Spec §6: tolerant by design. The snapshot is stored jsonb written by an older or newer version of the code,
 * so every field is checked by hand and anything unexpected becomes null ("unknown") instead of an error.
 */
export function parseSnapshot(raw: unknown): ParsedSnapshot {
  const snapshot = obj(raw) ?? {};
  const job = obj(snapshot.job) ?? {};
  const match = obj(snapshot.match);
  const ats = obj(snapshot.ats);
  const documents = obj(snapshot.documents);
  const workMode = str(job.workMode);
  const missed = ats && Array.isArray(ats.missedRequiredTerms)
    ? ats.missedRequiredTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : null;

  return {
    external: snapshot.external === true,
    careerGoalId: match ? str(match.careerGoalId) : null,
    matchScore: match && match.eligible === true ? num(match.overallScore) : null,
    workMode: workMode !== null && WORK_MODES.has(workMode) ? (workMode as "remote" | "hybrid" | "onsite") : null,
    countryCode: str(job.countryCode)?.toUpperCase() ?? null,
    salaryMin: num(job.salaryMin),
    salaryMax: num(job.salaryMax),
    salaryCurrency: str(job.salaryCurrency),
    postingAgeDays: num(job.postingAgeDays),
    atsScore: ats ? num(ats.overallScore) : null,
    requiredKeywordCoverage: ats ? num(ats.requiredKeywordCoverage) : null,
    missedRequiredTerms: missed,
    documents: documents
      ? {
          resume: obj(documents.resume) !== null,
          pitch: obj(documents.pitch) !== null,
          coverLetter: obj(documents.coverLetter) !== null,
          edited: [documents.pitch, documents.coverLetter].some((d) => obj(d)?.origin === "user_edited"),
        }
      : null,
    factors: match && match.eligible === true
      ? (Object.fromEntries(FACTOR_KEYS.map((key) => [key, num(match[key])])) as FactorVector)
      : null,
  };
}
