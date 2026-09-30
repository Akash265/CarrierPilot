/** Shared Phase 7a types (design doc §3-§4). */

export type ResearchStatus = "ok" | "no_results" | "failed";

/** A fact about to be written to company_research_facts (before it has an id). */
export interface ResearchFactDraft {
  sourceKind: "web" | "internal";
  factText: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  citedText: string | null;
}

export const PITCH_BULLET_KINDS = ["company", "role", "candidate"] as const;
export type PitchBulletKind = (typeof PITCH_BULLET_KINDS)[number];

export type EvidenceKind = "research" | "requirement" | "profile";

/** A copy of one cited evidence item, stored inside the pitch so it survives a research refresh. */
export interface EvidenceSnapshot {
  id: string;
  kind: EvidenceKind;
  text: string;
  sourceUrl: string | null;
}

/** One element of application_pitches.bullets. supported is null for a user_edited version. */
export interface StoredPitchBullet {
  kind: PitchBulletKind;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: EvidenceSnapshot[];
}

export const MAX_BULLET_CHARS = 600;

/** Phase 7c cover letter (design §3). Paragraph order: opening, company, evidence (1-2), closing. */
export const COVER_LETTER_ROLES = ["opening", "company", "evidence", "closing"] as const;
export type CoverLetterRole = (typeof COVER_LETTER_ROLES)[number];
export const MAX_PARAGRAPH_CHARS = 1200;

/** One element of cover_letters.paragraphs. supported is null for a user_edited version. */
export interface StoredCoverLetterParagraph {
  role: CoverLetterRole;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: EvidenceSnapshot[];
  /**
   * D106: the missing required terms this paragraph names (findGapTermMentions) -- [] when none (the
   * opening is always []) on a generated version, null on a user_edited one. Optional because rows
   * written before D106 lack it; every writer sets it, and readers treat an absent value as null.
   */
  missingTermMentions?: string[] | null;
}

/** Phase 7c interview preparation (design §3). */
export const LIKELY_QUESTION_CATEGORIES = ["technical", "behavioral", "role"] as const;
export type LikelyQuestionCategory = (typeof LIKELY_QUESTION_CATEGORIES)[number];
export const MAX_QUESTION_CHARS = 300;
export const MAX_OUTLINE_LINE_CHARS = 300;
export const MAX_FRAMING_CHARS = 800;
export const MAX_POINT_CHARS = 400;
export const MAX_GAP_TERMS = 5;
export const MAX_REQUIREMENT_TERM_CHARS = 200;

/** A required job term the profile evidence does not contain (computeGapTerms), with its job_requirements id. */
export interface GapTerm {
  term: string;
  requirementId: string;
}

/** Guard output shared by every interview-prep item (packs are never user-edited, so supported is never null). */
export interface GuardedItem {
  supported: boolean;
  unsupportedReason: string | null;
  evidence: EvidenceSnapshot[];
}
export interface StoredLikelyQuestion extends GuardedItem {
  question: string;
  category: LikelyQuestionCategory;
  answerOutline: string[];
}
export interface StoredGapQuestion extends GuardedItem {
  question: string;
  requirementTerm: string;
  framing: string;
}
export interface StoredTalkingPoint extends GuardedItem {
  text: string;
}
export interface StoredQuestionToAsk extends GuardedItem {
  question: string;
}
export interface StoredInterviewPrepSections {
  likelyQuestions: StoredLikelyQuestion[];
  gapQuestions: StoredGapQuestion[];
  talkingPoints: StoredTalkingPoint[];
  questionsToAsk: StoredQuestionToAsk[];
}
