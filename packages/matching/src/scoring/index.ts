/**
 * Phase 10b spec §7: the dependency-light entry point `@ai-career/matching/scoring`. Only the pure scoring
 * functions and the factor types/constants -- nothing that reaches the Anthropic SDK, @ai-career/ai, the database
 * or BullMQ -- so packages such as @ai-career/insights can reuse matching's scoring rules without its pipeline.
 * index.test.ts enforces that every module reachable from here imports only relative paths.
 */
export { FACTOR_KEYS, FACTOR_WEIGHTS, type FactorScores, type WorkMode, type WorkModePreference, type Sponsorship } from "../types";
export { computeOverallScore } from "./computeOverallScore";
export { scoreExperience } from "./scoreExperience";
export { scoreFreshness } from "./scoreFreshness";
export { scoreIndustry } from "./scoreIndustry";
export { scoreLocation } from "./scoreLocation";
export { scoreRole } from "./scoreRole";
export { scoreSalary, type SalaryComparisonInput } from "./scoreSalary";
export { scoreSemantic } from "./scoreSemantic";
export { scoreSkills, type SkillMatchDetail, type SkillsScoreResult } from "./scoreSkills";
export { scoreSponsorship } from "./scoreSponsorship";
