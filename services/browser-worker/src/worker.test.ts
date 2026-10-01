import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "@ai-career/browser/testing";
import { BROWSER_JOB_NAME, browserJobId, type BrowserJobData } from "@ai-career/browser";
import { createBrowserWorker } from "./worker";
import type { RunSessionResult } from "./runSession";
import { ReleasedWindows } from "./browser";

const USER = "00000000-0000-0000-0000-0000000008a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `browser-test-${randomUUID()}`;

let t: TestDb;
let queue: Queue<BrowserJobData>;
let events: QueueEvents;
let worker: Worker<BrowserJobData, RunSessionResult>;

beforeAll(async () => {
  t = await openTestDb();
  await wipeUser(t.adminSql, USER);
  queue = new Queue<BrowserJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createBrowserWorker({
    connection, queueName, db: t.db, fetchDocument: async () => Buffer.from("x"), browser: { headless: true },
    timeoutMs: 1_000, released: new ReleasedWindows(),
  });
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

describe("browser worker", () => {
  it("hands queued jobs to runSession (a non-queued session is skipped without opening a browser)", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const sessionId = await insertSessionRow(t.adminSql, USER, jobId, { status: "failed" });
    const job = await queue.add(BROWSER_JOB_NAME, { sessionId, userId: USER }, { jobId: browserJobId(sessionId) });
    expect(await job.waitUntilFinished(events)).toBe("skipped");
  });
});
