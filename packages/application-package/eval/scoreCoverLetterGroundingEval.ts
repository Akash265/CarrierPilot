/**
 * Manual cover-letter-grounding scorer. Checks what fake-client unit tests cannot: that a real model, given
 * genuine evidence, (1) cites ids the guard accepts for every paragraph of every fixture, and (2) does not
 * put numbers in a paragraph that appear in none of that paragraph's cited evidence (a reported heuristic for
 * invented metrics, not an assertion). Run when ANTHROPIC_MODEL_FAST or generateCoverLetter's prompt/schema changes.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "cover-letter-fixtures");

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);
  let supported = 0;
  let total = 0;
  let flaggedNumbers = 0;

  for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))) {
    const fixture: GenerateCoverLetterInput = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf-8"));
    try {
      const draft = await generateCoverLetter(client, env, fixture);
      const result = applyCoverLetterGuard(fixture.evidence, draft);
      console.log(`\n${name} (requiresReview=${result.requiresReview}):`);
      for (const p of result.paragraphs) {
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
      }
    } catch (error) {
      console.log(`\n${name}: GENERATION FAILED -- ${(error as Error).message}`);
    }
  }

  console.log(`\nSupported paragraphs: ${supported}/${total} (every fixture id is genuine, so anything below ${total}/${total} is a prompt regression).`);
  console.log(`Numbers not found in cited evidence: ${flaggedNumbers} (should be 0).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
