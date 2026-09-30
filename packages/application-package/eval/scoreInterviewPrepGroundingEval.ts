/**
 * Manual interview-prep-grounding scorer. Checks what fake-client unit tests cannot: that a real model,
 * given genuine evidence and deterministically computed gap terms, (1) cites ids the guard accepts for
 * every item of every fixture, (2) writes at most one gap question per missing required term and never
 * routes a gap term into a likelyQuestion, and (3) never frames a gap question's advice as if the
 * candidate already had the missing skill (findSkillClaim -- the heuristic the guard enforces since D102;
 * read the flagged framings, since a flag can be a false positive). Run when ANTHROPIC_MODEL_RESEARCH or generateInterviewPrep's prompt/schema changes.
 *
 * Usage (from packages/application-package, real ANTHROPIC_API_KEY in the repo root .env): `pnpm eval:interview-prep`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { buildEvidenceIndex, type RequirementForEvidence } from "../src/pitch/buildEvidenceIndex";
import { computeGapTerms } from "../src/interviewPrep/computeGapTerms";
import { findSkillClaim } from "../src/interviewPrep/findSkillClaim";
import { generateInterviewPrep } from "../src/interviewPrep/generateInterviewPrep";
import { applyInterviewPrepGuard } from "../src/interviewPrep/applyInterviewPrepGuard";
import { MAX_GAP_TERMS } from "../src/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "interview-prep-fixtures");

interface Fixture {
  jobTitle: string;
  companyName: string;
  research: { id: string; text: string; sourceUrl: string | null }[];
  requirements: RequirementForEvidence[];
  catalog: EvidenceCatalogEntry[];
}

const citedIds = (evidence: { id: string }[]) => evidence.map((e) => e.id).join(", ") || "(none)";

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);
  let supported = 0;
  let total = 0;
  let gapAnswered = 0;
  let gapAnsweredSupported = 0;
  let gapTotal = 0;
  let flaggedFramings = 0;
  let likelyQuestionGapFlags = 0;

  for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))) {
    const fixture: Fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf-8"));
    try {
      const researchFacts = fixture.research.map((r) => ({ id: r.id.slice(2), factText: r.text, sourceUrl: r.sourceUrl }));
      const evidence = buildEvidenceIndex(researchFacts, fixture.requirements, fixture.catalog);
      // Same split as runInterviewPrepGeneration (D100).
      const allGapTerms = computeGapTerms(fixture.requirements, fixture.catalog);
      const gapTerms = allGapTerms.slice(0, MAX_GAP_TERMS);
      const draft = await generateInterviewPrep(client, env, {
        jobTitle: fixture.jobTitle,
        companyName: fixture.companyName,
        evidence,
        gapTerms,
      });
      const result = applyInterviewPrepGuard(evidence, { modelGapTerms: gapTerms, allGapTerms }, draft);

      console.log(`\n${name} (requiresReview=${result.requiresReview}):`);
      console.log(`  gapTerms: ${gapTerms.length === 0 ? "(none)" : gapTerms.map((g) => g.term).join(", ")}`);

      const gapTermsLower = new Set(gapTerms.map((g) => g.term.toLowerCase()));

      console.log(`  likelyQuestions (${result.sections.likelyQuestions.filter((q) => q.supported).length}/${result.sections.likelyQuestions.length} supported):`);
      for (const q of result.sections.likelyQuestions) {
        total += 1;
        if (q.supported) supported += 1;
        if (q.unsupportedReason?.includes("targets a missing required term")) likelyQuestionGapFlags += 1;
        console.log(`    [${q.category}] supported=${q.supported}${q.unsupportedReason ? ` (${q.unsupportedReason})` : ""}`);
        console.log(`      cited: ${citedIds(q.evidence)}`);
        console.log(`      Q: ${q.question}`);
      }

      console.log(`  gapQuestions (${result.sections.gapQuestions.filter((q) => q.supported).length}/${result.sections.gapQuestions.length} supported):`);
      const answeredTerms = new Set<string>();
      const answeredSupportedTerms = new Set<string>();
      for (const q of result.sections.gapQuestions) {
        total += 1;
        if (q.supported) supported += 1;
        const key = q.requirementTerm.toLowerCase();
        if (gapTermsLower.has(key)) {
          answeredTerms.add(key);
          if (q.supported) answeredSupportedTerms.add(key);
        }
        // The same detector the guard enforces (D102), so this count equals the guard's claim flags.
        const claimSentence = findSkillClaim(q.framing, q.requirementTerm);
        if (claimSentence !== null) flaggedFramings += 1;
        console.log(`    [${q.requirementTerm}] supported=${q.supported}${q.unsupportedReason ? ` (${q.unsupportedReason})` : ""}`);
        console.log(`      cited: ${citedIds(q.evidence)}`);
        console.log(`      Q: ${q.question}`);
        console.log(`      Framing: ${q.framing}`);
        if (claimSentence !== null) console.log(`      FRAMING MAY CLAIM THE MISSING SKILL (flagged by the guard; read it): "${claimSentence}"`);
      }
      gapAnswered += answeredTerms.size;
      gapAnsweredSupported += answeredSupportedTerms.size;
      gapTotal += gapTerms.length;

      console.log(`  talkingPoints (${result.sections.talkingPoints.filter((p) => p.supported).length}/${result.sections.talkingPoints.length} supported):`);
      for (const p of result.sections.talkingPoints) {
        total += 1;
        if (p.supported) supported += 1;
        console.log(`    supported=${p.supported}${p.unsupportedReason ? ` (${p.unsupportedReason})` : ""}`);
        console.log(`      cited: ${citedIds(p.evidence)}`);
        console.log(`      ${p.text}`);
      }

      console.log(`  questionsToAsk (${result.sections.questionsToAsk.filter((q) => q.supported).length}/${result.sections.questionsToAsk.length} supported):`);
      for (const q of result.sections.questionsToAsk) {
        total += 1;
        if (q.supported) supported += 1;
        console.log(`    supported=${q.supported}${q.unsupportedReason ? ` (${q.unsupportedReason})` : ""}`);
        console.log(`      cited: ${citedIds(q.evidence)}`);
        console.log(`      ${q.question}`);
      }
    } catch (error) {
      console.log(`\n${name}: GENERATION FAILED -- ${(error as Error).message}`);
    }
  }

  console.log(`\nSupported items: ${supported}/${total} (every fixture id is genuine, so anything below ${total}/${total} is a prompt regression).`);
  console.log(`Gap terms answered: ${gapAnswered}/${gapTotal} (supported: ${gapAnsweredSupported}/${gapTotal}) (a gap term with no gap question is a prompt regression).`);
  console.log(`Likely questions that also target a gap term (should route to gapQuestions instead): ${likelyQuestionGapFlags} (should be 0).`);
  console.log(`Framings that may claim a missing skill: ${flaggedFramings} (should be 0; read them).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
