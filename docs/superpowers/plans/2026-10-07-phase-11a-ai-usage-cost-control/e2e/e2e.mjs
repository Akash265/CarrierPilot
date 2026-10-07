// Phase 11a E2E browser checks. Copy into a scratch directory where `npm install playwright-core` was run, then:
//   BASE_URL=http://localhost:3111 CAPTURE_FILE=langfuse.jsonl node e2e.mjs [screenshot-dir]
// Expects: web + matching worker running as user ...0b06 against career_intel_test with ANTHROPIC_BASE_URL at the fake
// Anthropic (FAKE_INPUT_TOKENS=200000, FAKE_OUTPUT_TOKENS=20000 -> $0.30 per Haiku call), AI_MONTHLY_BUDGET_USD=0.70,
// an invalid VOYAGE_API_KEY, and LANGFUSE_* pointing at fakeLangfuse.mjs. Exits non-zero on the first failed check.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3111";
const SHOTS = process.argv[2] ?? ".";
const SENTINEL = "SENTINEL-E2E-GOAL";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
function check(name, ok, detail) {
  console.log(JSON.stringify({ check: name, ok, detail }));
  if (!ok) {
    browser.close().finally(() => process.exit(1));
    throw new Error(`check failed: ${name}`);
  }
}
const usage = async () => (await page.request.get(`${BASE}/api/usage`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}
async function parseGoal(text) {
  await page.goto(`${BASE}/career-goal`);
  const edit = page.getByRole("button", { name: "Edit Goal" });
  await edit.waitFor();
  await edit.click();
  await page.getByLabel("Describe the roles you're looking for").fill(text);
  await page.getByRole("button", { name: "Understand my goal" }).click();
}

// 1. Nothing spent yet.
await page.goto(`${BASE}/usage`);
await page.getByText("No AI calls yet this month.").waitFor();
check("usage page starts empty against the ceiling", await page.getByText("$0.00 of $0.70 this month").isVisible());
check("costs are labelled as estimates", await page.getByText("Costs are estimates from a built-in price table, not your Anthropic or Voyage invoice.").isVisible());
await page.goto(BASE);
const usageLink = page.getByRole("link", { name: "8. AI usage — estimated spend against your monthly budget" });
await usageLink.waitFor();
await sleep(1000);
check("home links to AI usage with no badge under the threshold", (await page.getByText(/AI budget/).count()) === 0);

// 2. One goal parse through the tracked client.
await parseGoal(`Data engineering roles in Berlin ${SENTINEL}`);
await page.getByRole("button", { name: /confirm/i }).first().waitFor();
let u = await usage();
check("a parse records one priced career_goal_parse call", u.spentUsd === 0.3 && u.byOperation[0]?.operation === "career_goal_parse", u.byOperation);
await page.goto(`${BASE}/usage`);
await page.getByRole("table", { name: "By feature" }).waitFor();
check("usage page shows the parse by feature with its cost", await page.getByRole("row", { name: /Career goal parsing 1 0 0 200,000 20,000 0 \$0\.30/ }).isVisible());

// 3. Matching through the worker: explanation (priced) + embeddings (Voyage rejects the invalid key -> recorded failures).
await page.goto(`${BASE}/matches`);
await page.getByRole("button", { name: "Find Matches" }).click();
u = await waitFor(async () => {
  const s = await usage();
  return s.byOperation.some((o) => o.operation === "match_explanation") ? s : null;
}, "the worker's match explanation");
check("the worker records its explanation under match_explanation", u.byOperation.find((o) => o.operation === "match_explanation").costUsd === 0.3, u.byOperation);
check("failed Voyage calls are recorded with a status code", u.recentFailures.some((f) => f.errorCode === "voyage:401"), u.recentFailures);
check("spend is now in the warn band", u.state === "warn" && u.spentUsd === 0.6, { state: u.state, spent: u.spentUsd });
await page.goto(BASE);
await page.getByText("85% of AI budget").waitFor();
check("home badges the usage link at the floored percentage", true);
await page.goto(`${BASE}/usage`);
await page.getByText("Over 80% of your monthly AI budget.").waitFor();
await page.screenshot({ path: `${SHOTS}/usage-warn.png`, fullPage: true });

// 4. A second parse goes over; a third is blocked before reaching the provider.
await parseGoal("Analytics engineering roles, remote");
await page.getByRole("button", { name: /confirm/i }).first().waitFor();
u = await usage();
check("the second parse takes spend over the ceiling", u.state === "over" && u.spentUsd === 0.9, { state: u.state, spent: u.spentUsd });
await parseGoal("Data platform roles in Munich");
const message = page.getByText(/^Monthly AI budget reached \(\$0\.90 of \$0\.70\)\. Raise AI_MONTHLY_BUDGET_USD or wait until \d{4}-\d{2}-01 \(UTC\)\.$/);
await message.waitFor();
check("a blocked parse shows the budget message in the goal form", await message.isVisible());
u = await usage();
check("the blocked call is recorded at zero cost", u.spentUsd === 0.9 && u.recentFailures[0].outcome === "blocked" && u.recentFailures[0].errorCode === "budget_exceeded", u.recentFailures[0]);
await page.goto(BASE);
await page.getByText("AI budget reached").waitFor();
check("home badges the usage link when the budget is reached", true);
await page.goto(`${BASE}/usage`);
// Filtered by text: Next.js renders its own (empty) role="alert" route announcer on every page.
const blockedAlert = page.getByRole("alert").filter({ hasText: /^Monthly AI budget reached\. New AI calls are blocked until \d{4}-\d{2}-01 \(UTC\)/ });
await blockedAlert.waitFor();
check("usage page says new calls are blocked", await blockedAlert.isVisible());
await page.screenshot({ path: `${SHOTS}/usage-over.png`, fullPage: true });

// 5. Langfuse export: one span per recorded call (web + worker), auth + v4 header, never any content.
await sleep(2000);
const lines = readFileSync(process.env.CAPTURE_FILE ?? "langfuse.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const callCount = u.byOperation.reduce((n, o) => n + o.calls + o.blocked, 0);
check("one OTLP export per recorded call", lines.length === callCount, { exports: lines.length, calls: callCount });
check("every export goes to the OTLP path with basic auth and the v4 header",
  lines.every((l) => l.path === "/api/public/otel/v1/traces" && l.authorization?.startsWith("Basic ") && l.ingestionVersion === "4" && l.contentType === "application/json"));
check("no export contains the goal text", lines.every((l) => !l.body.includes(SENTINEL) && !l.body.includes("Berlin")));
const spans = lines.map((l) => JSON.parse(l.body).resourceSpans[0].scopeSpans[0].spans[0]);
check("spans are named by operation and typed as generations",
  spans.every((s) => s.attributes.some((a) => a.key === "langfuse.observation.type" && a.value.stringValue === "generation")),
  [...new Set(spans.map((s) => s.name))]);

await browser.close();
console.log(JSON.stringify({ done: true }));
