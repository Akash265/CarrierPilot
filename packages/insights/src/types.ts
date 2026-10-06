import type { schema } from "@ai-career/db";
import type { FactorScores } from "@ai-career/matching/scoring";

/** Single source of truth: the Postgres enum's values (same as packages/applications). */
export type ApplicationStatus = (typeof schema.applicationStatusEnum.enumValues)[number];

export type Tier = "response" | "interview";
export const TIERS: readonly Tier[] = ["response", "interview"];

export type OutcomeLabel = "positive" | "negative" | "undecided" | "excluded";

export interface TierOutcome {
  label: OutcomeLabel;
  /** Short, user-facing explanation of the label (spec §4.2). */
  reason: string;
}

/** One application as the loader reads it. Never carries notes, recruiter fields, salary notes or the job URL (spec §8). */
export interface InsightApplication {
  id: string;
  jobId: string | null;
  companyName: string;
  jobTitle: string;
  status: ApplicationStatus;
  /** YYYY-MM-DD (UTC calendar date). */
  appliedAt: string;
  createdAt: Date;
  featureSnapshot: unknown;
}

/** Only these three event types are evidence or activity (spec §4.2); the loader reads nothing else. */
export type InsightEventType = "status_change" | "recruiter_contact" | "interview";

export interface InsightEvent {
  applicationId: string;
  type: InsightEventType;
  occurredAt: Date;
  /** Null exactly on the creation status_change (always written at `now`, even for a backdated appliedAt) -- never activity. */
  fromStatus: ApplicationStatus | null;
  toStatus: ApplicationStatus | null;
}

/** A confirmed career goal with its constraints. */
export interface InsightGoal {
  id: string;
  confirmedAt: Date | null;
  targetRoles: string[];
  salaryFloorNormalized: number | null;
  salaryCurrency: string | null;
  salaryIsParsed: boolean;
}

export interface InsightInputs {
  applications: InsightApplication[];
  events: InsightEvent[];
  goals: InsightGoal[];
}

export interface Interval {
  low: number;
  high: number;
}

/** One of matching's 9 factor names (skillsScore ... semanticScore). */
export type FactorKey = keyof FactorScores;
/** The 9 factor scores (0-1) of a match; null where the score is unknown (e.g. no comparable salary). */
export type FactorVector = Record<FactorKey, number | null>;

export interface DocumentsSent {
  resume: boolean;
  pitch: boolean;
  coverLetter: boolean;
  /** A pitch or cover letter with origin "user_edited" was sent. */
  edited: boolean;
}

/** One application in the outcome dataset (spec §4.4). Every null means "unknown", never zero. */
export interface OutcomeRecord {
  applicationId: string;
  external: boolean;
  appliedAt: string;
  response: TierOutcome;
  interview: TierOutcome;
  roleFamily: { key: string; label: string };
  company: { key: string; label: string };
  workMode: "remote" | "hybrid" | "onsite" | null;
  countryCode: string | null;
  salaryVsFloor: "below" | "at_or_above" | null;
  /** 0-100, only when the match was eligible. */
  matchScore: number | null;
  /** 0-100. */
  atsScore: number | null;
  /** 0-1. */
  requiredKeywordCoverage: number | null;
  postingAgeDays: number | null;
  documents: DocumentsSent | null;
  missedRequiredTerms: string[] | null;
  /** Phase 10b: the eligible match's 9 factor scores at apply time; null without an eligible match. */
  factors: FactorVector | null;
}
