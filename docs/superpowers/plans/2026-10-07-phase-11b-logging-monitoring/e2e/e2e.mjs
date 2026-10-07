// Phase 11b E2E checks. Copy into a scratch directory where `npm install playwright-core` was run, then:
//   REPO=<repo root> BASE_URL=http://localhost:3112 BROKEN_URL=http://localhost:3113 BROKEN_LOG=<that instance's log> \
//   node e2e.mjs [screenshot-dir]
// Expects: web on BASE_URL with HEARTBEAT_INTERVAL_MS=1000 and STATUS_STALE_AFTER_MS=5000 (career_intel_test; the
// stale threshold must exceed the beat interval, D174), a second web instance on BROKEN_URL whose
// DATABASE_URL points at a closed port, its stdout+stderr written to BROKEN_LOG, and no matching worker running. This
// script starts/stops the matching worker itself (one `node --import tsx` process, so its pid is the worker's).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = process.env.REPO;
const BASE = process.env.BASE_URL ?? "http://localhost:3112";
const BROKEN = process.env.BROKEN_URL ?? "http://localhost:3113";
const BROKEN_LOG = process.env.BROKEN_LOG;
const SHOTS = process.argv[2] ?? ".";
if (!REPO || !BROKEN_LOG) throw new Error("set REPO and BROKEN_LOG");

const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
const children = [];
async function finish(code) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  await browser.close();
  process.exit(code);
}
function check(name, ok, detail) {
  console.log(JSON.stringify({ check: name, ok, detail }));
  if (!ok) {
    void finish(1);
    throw new Error(`check failed: ${name}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The repo's .env plus the E2E overrides, so the worker uses the test database. */
function workerEnv() {
  const env = { ...process.env };
  for (const line of readFileSync(path.join(REPO, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
  env.DATABASE_URL = "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
  env.HEARTBEAT_INTERVAL_MS = "1000";
  return env;
}
function startWorker() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: path.join(REPO, "services/matching-worker"), env: workerEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function matchingState() {
  await page.goto(`${BASE}/status`);
  const table = page.getByRole("table", { name: "Workers" });
  await table.waitFor();
  return (await table.getByRole("row").filter({ hasText: "Matching" }).getByRole("cell").nth(1).textContent())?.trim();
}
async function waitForState(want, timeoutMs = 20_000) {
  const start = Date.now();
  let got;
  while (Date.now() - start < timeoutMs) {
    got = await matchingState();
    if (got === want) return got;
    await sleep(1000);
  }
  return got;
}

// 1. A running worker shows as Running.
let worker = startWorker();
check("a started worker shows as Running", (await waitForState("Running")) === "Running");
check("the queues table lists every queue", (await page.getByRole("table", { name: "Queues" }).getByRole("row").count()) === 5);
await page.screenshot({ path: `${SHOTS}/status-running.png`, fullPage: true });

// 2. Killed without a clean stop, it shows as Stale once STATUS_STALE_AFTER_MS (5 s) has passed.
worker.kill("SIGKILL");
await new Promise((r) => worker.once("exit", r));
check("right after a hard kill it is still Running (within the threshold)", (await matchingState()) === "Running");
await sleep(6000);
check("after the threshold a hard-killed worker shows as Stale", (await waitForState("Stale")) === "Stale");
await page.screenshot({ path: `${SHOTS}/status-stale.png`, fullPage: true });

// 3. Restarted, then stopped with SIGTERM: Running, then Stopped.
worker = startWorker();
check("a restarted worker shows as Running again", (await waitForState("Running")) === "Running");
worker.kill("SIGTERM");
const exitCode = await new Promise((r) => worker.once("exit", (code) => r(code)));
check("SIGTERM shuts the worker down cleanly", exitCode === 0, { exitCode });
check("a cleanly stopped worker shows as Stopped", (await waitForState("Stopped")) === "Stopped");

// 4. An escaped route error: 500 with a request id, and a message-free log line on the server.
const res = await fetch(`${BROKEN}/api/insights`);
const body = await res.json();
const requestId = res.headers.get("x-request-id");
check("an escaped route error answers 500", res.status === 500, { status: res.status });
check("the 500 body carries the request id and no detail",
  /^[0-9a-f]{8}$/.test(requestId ?? "") && body.requestId === requestId &&
  body.error === `Something went wrong (request ${requestId}). Details are in the server log.`, body);
await sleep(500);
const lines = readFileSync(BROKEN_LOG, "utf8").split("\n").filter((l) => l.includes(`"requestId":"${requestId}"`));
check("the server logged exactly one line for that request", lines.length === 1, lines);
const line = JSON.parse(lines[0]);
check("the log line names the route and the error's class and code",
  line.event === "request_failed" && line.level === "error" && line.service === "web" && line.route === "/api/insights" &&
  line.method === "GET" && line.path === "/api/insights" && typeof line.error?.name === "string" && line.error.code === "ECONNREFUSED", line);
check("the log line has no error message text", !/connect ECONNREFUSED|5999/.test(lines[0]), lines[0]);

console.log(JSON.stringify({ done: true }));
await finish(0);
