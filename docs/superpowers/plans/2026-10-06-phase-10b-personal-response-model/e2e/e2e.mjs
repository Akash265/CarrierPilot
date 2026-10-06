// Phase 10b E2E browser checks (Task 10). Copy into a scratch directory where `npm install playwright-core` was run,
// then: BASE_URL=http://localhost:3031 node e2e.mjs [screenshot-path]. Exits non-zero on the first failed check.
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3031";
const SHOT = process.argv[2] ?? "insights.png";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(JSON.stringify({ check: name, ok, detail }));
  if (!ok) {
    browser.close().finally(() => process.exit(1));
    throw new Error(`check failed: ${name}`);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const titles = () => page.locator('ul[aria-label="Matches"] > li a').allTextContents();
const note = () => page.getByText(/^Ranked with your history \(weight \d+%\)$/);
const toggle = () => page.getByRole("checkbox", { name: "Rank with my history" });

await page.goto(`${BASE}/matches`);
await page.getByText("Strong Skills Role").waitFor();
check("default order is the match score", same(await titles(), ["Weak Skills Role", "Strong Skills Role"]), await titles());
const lines = await page.getByText(/^Your history: likely response \d+% \(\d+–\d+%\)$/).allTextContents();
check("every match shows its likely response with a range", lines.length === 2, lines);
check("the toggle is enabled once the model is active", await toggle().isEnabled());

await toggle().check();
await note().waitFor();
check("turning it on ranks with history and says so", (await note().textContent()) === "Ranked with your history (weight 20%)", await note().textContent());
check("personal order puts the strong-skills job first", same(await titles(), ["Strong Skills Role", "Weak Skills Role"]), await titles());

await page.reload();
await note().waitFor();
check("the choice survives a reload", await toggle().isChecked());
check("after reload the list is still ranked with history", same(await titles(), ["Strong Skills Role", "Weak Skills Role"]), await titles());

await page.getByRole("link", { name: "Strong Skills Role" }).click();
const history = page.getByRole("region", { name: "Your history" });
await history.waitFor();
const historyText = (await history.textContent()).replace(/\s+/g, " ");
check("the detail page explains the prediction", /likely response \d+% \(\d+–\d+%\)/.test(historyText) && historyText.includes("Raises: Skills")
  && historyText.includes("not a cause or a guarantee"), historyText);

await page.goto(`${BASE}/insights`);
const model = page.getByRole("region", { name: "Your response model" });
await model.waitFor();
const modelText = (await model.textContent()).replace(/\s+/g, " ");
check("insights explains the active model", modelText.includes("Predicts responses better than your average: yes")
  && modelText.includes("Skills: a higher score has gone with more responses")
  && modelText.includes('Turning on "Rank with my history" on Matches blends this model in at 20% of the ranking.'), modelText);
await page.screenshot({ path: SHOT, fullPage: true });

await page.goto(`${BASE}/matches`);
await note().waitFor();
await toggle().uncheck();
await note().waitFor({ state: "detached" });
await page.waitForFunction(() => document.querySelectorAll('ul[aria-label="Matches"] > li').length === 2);
check("turning it off restores the match-score order", same(await titles(), ["Weak Skills Role", "Strong Skills Role"]), await titles());
check("turning it off is remembered", (await page.evaluate(() => localStorage.getItem("careerpilot.rankWithHistory"))) === "0");

console.log(JSON.stringify({ passed: results.length }));
await browser.close();
