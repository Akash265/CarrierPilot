export * from "./types";
export { capText, isHttpUrl } from "./research/text";
export { extractCitedFacts, MAX_WEB_FACTS, MAX_FACT_CHARS } from "./research/extractCitedFacts";
export { deriveInternalFacts, type InternalJobSummary } from "./research/deriveInternalFacts";
export {
  runCompanyResearch, MAX_PAUSE_CONTINUATIONS,
  type CompanyResearchInput, type CompanyResearchResult, type CompanyResearchEnv,
} from "./research/runCompanyResearch";
export {
  ensureCompanyResearch, loadCompanyResearch, CompanyResearchRefreshFailedError,
  type CompanyResearchRow, type CompanyResearchFactRow, type CompanyResearchWithFacts, type JobForResearch,
} from "./research/ensureCompanyResearch";
export {
  buildEvidenceIndex, type PitchEvidenceItem, type ResearchFactForEvidence, type RequirementForEvidence,
} from "./pitch/buildEvidenceIndex";
export { PitchDraftSchema, PitchDraftBulletSchema, type PitchDraft, type PitchDraftBullet } from "./pitch/pitchSchema";
export { generatePitch, PitchGenerationValidationError, type GeneratePitchInput } from "./pitch/generatePitch";
export { applyPitchGuard, REQUIRED_EVIDENCE_KIND, type PitchGuardResult } from "./pitch/applyPitchGuard";
export { insertPitchVersion, type ApplicationPitchRow, type NewPitchVersion } from "./pipeline/insertPitchVersion";
export {
  runPitchGeneration, PitchGenerationError,
  type PitchGenerationErrorClass, type RunPitchGenerationEnv, type RunPitchGenerationOptions, type RunPitchGenerationResult,
} from "./pipeline/runPitchGeneration";
export { createEditedPitch, EditPitchBodySchema, PitchEditError, type EditPitchBody } from "./pipeline/createEditedPitch";
export {
  checkCitations, indexEvidence, toGuarded, quoteId, KIND_LABEL,
  type CitationRequirement, type CitationResult, type EvidenceLookup,
} from "./guard/checkCitations";
export { ApplicationGenerationError, type ApplicationGenerationErrorClass } from "./pipeline/generationError";
export {
  prepareApplicationContext,
  type ApplicationContext, type ApplicationContextEnv, type PrepareApplicationContextOptions, type JobRow, type JobRequirementRow,
} from "./pipeline/prepareApplicationContext";
export { CoverLetterDraftSchema, CoverLetterDraftParagraphSchema, isValidParagraphOrder, type CoverLetterDraft } from "./coverLetter/coverLetterSchema";
export { generateCoverLetter, CoverLetterGenerationValidationError, type GenerateCoverLetterInput } from "./coverLetter/generateCoverLetter";
export { applyCoverLetterGuard, COVER_LETTER_CITATION_RULES, type CoverLetterGuardResult } from "./coverLetter/applyCoverLetterGuard";
export { insertCoverLetterVersion, type CoverLetterRow, type NewCoverLetterVersion } from "./pipeline/insertCoverLetterVersion";
export { runCoverLetterGeneration, type RunCoverLetterGenerationResult } from "./pipeline/runCoverLetterGeneration";
export { createEditedCoverLetter, EditCoverLetterBodySchema, CoverLetterEditError, type EditCoverLetterBody } from "./pipeline/createEditedCoverLetter";
export { computeGapTerms, containsTerm } from "./interviewPrep/computeGapTerms";
export { InterviewPrepDraftSchema, type InterviewPrepDraft } from "./interviewPrep/interviewPrepSchema";
export { generateInterviewPrep, InterviewPrepGenerationValidationError, type GenerateInterviewPrepInput } from "./interviewPrep/generateInterviewPrep";
export { applyInterviewPrepGuard, type InterviewPrepGuardResult, type InterviewPrepGapTerms } from "./interviewPrep/applyInterviewPrepGuard";
export { insertInterviewPrepVersion, type InterviewPrepRow, type NewInterviewPrepVersion } from "./pipeline/insertInterviewPrepVersion";
export { runInterviewPrepGeneration, type RunInterviewPrepGenerationResult } from "./pipeline/runInterviewPrepGeneration";
