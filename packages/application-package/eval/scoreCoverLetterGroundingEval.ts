/**
 * Manual cover-letter-grounding scorer. Checks what fake-client unit tests cannot: that a real model, given
 * genuine evidence, (1) cites ids the guard accepts for every paragraph of every fixture, and (2) does not
 * put numbers in a paragraph that appear in none of that paragraph's cited evidence (a reported heuristic for
 * invented metrics, not an assertion), and (3) reports non-opening paragraphs that mention a missing required
 * term -- the D101 rule that marks the letter for review (fixture 4 has a real, non-alias gap). Run when ANTHROPIC_MODEL_FAST or generateCoverLetter's prompt/schema changes.
 *
 * Usage (from packages/application-package, real ANTHROPIC_API_KEY in the repo root .env): `pnpm eval:cover-letter`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { generateCoverLetter, type GenerateCoverLetterInput } from "../src/coverLetter/generateCoverLetter";
import { applyCoverLetterGuard } from "../src/coverLetter/applyCoverLetterGuard";
import { findGapTermMentions } from "../src/coverLetter/findGapTermMentions";
import { computeGapTerms, type RequirementForGapDetection } from "../src/interviewPrep/computeGapTerms";
import type { PitchEvidenceItem } from "../src/pitch/buildEvidenceIndex";
import type { GapTerm } from "../src/types";
import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "cover-letter-fixtures");

/**
 * The fixtures carry only the evidence index, so rebuild computeGapTerms' inputs from it: "[required] X"
 * requirement items, and profile items whose text is already "context: text" (the same haystack text
 * computeGapTerms builds from the catalog). The evidence text does not carry job_requirements.term_type,
 * so every rebuilt requirement is typed "skill" (every fixture requirement is a short named skill or tool);
 * the D104 four-word limit still applies.
 */
function gapTermsFromEvidence(evidence: PitchEvidenceItem[]): GapTerm[] {
  const requirements: RequirementForGapDetection[] = evidence
    .filter((e) => e.kind === "requirement")
    .map((e) => {
      const m = /^\[(required|preferred)\] (.*)$/.exec(e.text);
      return { id: e.id.slice(2), termText: m ? m[2] : e.text, requirementLevel: (m?.[1] ?? "preferred") as "required" | "preferred", termType: "skill" };
    });
  const catalog = evidence
    .filter((e) => e.kind === "profile")
    .map((e) => ({ sourceFactId: e.id.slice(2), sourceType: "work_experience_bullet", text: e.text, context: null }) as EvidenceCatalogEntry);
  return computeGapTerms(requirements, catalog);
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);
  let supported = 0;
  let total = 0;
  let flaggedNumbers = 0;
  let gapMentionParagraphs = 0;

  for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))) {
    const fixture: GenerateCoverLetterInput = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf-8"));
    try {
      const gapTerms = gapTermsFromEvidence(fixture.evidence);
      const draft = await generateCoverLetter(client, env, fixture);
      const result = applyCoverLetterGuard(fixture.evidence, draft);
      const mentions = findGapTermMentions(result.paragraphs, gapTerms);
      gapMentionParagraphs += mentions.length;
      // Same rule as runCoverLetterGeneration (D101).
      const requiresReview = result.requiresReview || mentions.length > 0;
      console.log(`\n${name} (requiresReview=${requiresReview}):`);
      console.log(`  gapTerms: ${gapTerms.length === 0 ? "(none)" : gapTerms.map((g) => g.term).join(", ")}`);
      for (const [i, p] of result.paragraphs.entries()) {
        total += 1;
        if (p.supported) supported += 1;
        const cited = p.evidence.map((e) => e.text).join(" ");
        const numbers = p.text.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
        const uncited = numbers.filter((n) => !cited.includes(n));
        flaggedNumbers += uncited.length;
        console.log(`  [${p.role}] supported=${p.supported}${p.unsupportedReason ? ` (${p.unsupportedReason})` : ""}`);
        console.log(`    cited: ${p.evidence.map((e) => e.id).join(", ") || "(none)"}`);
        console.log(`    ${p.text}`);
        if (uncited.length > 0) console.log(`    NUMBERS NOT IN CITED EVIDENCE (investigate): ${uncited.join(", ")}`);
        const mention = mentions.find((m) => m.paragraphIndex === i);
        if (mention) console.log(`    MENTIONS MISSING REQUIRED TERM "${mention.term}" (letter marked for review; read it)`);
      }
    } catch (error) {
      console.log(`\n${name}: GENERATION FAILED -- ${(error as Error).message}`);
    }
  }

  console.log(`\nSupported paragraphs: ${supported}/${total} (every fixture id is genuine, so anything below ${total}/${total} is a prompt regression).`);
  console.log(`Numbers not found in cited evidence: ${flaggedNumbers} (should be 0).`);
  console.log(
    `Non-opening paragraphs that mention a missing required term: ${gapMentionParagraphs} (each marks its letter for review; read them -- a mention is not always a claim).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
