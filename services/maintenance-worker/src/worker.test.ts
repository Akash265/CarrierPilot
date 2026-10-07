import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { openTestDb, type TestDb } from "@ai-career/applications/testing";
import type { RetentionStorage } from "@ai-career/applications";
import { createMaintenanceWorker, scheduleRetention } from "./worker";
import { RETENTION_JOB_NAME, RETENTION_SCHEDULER_ID } from "./queue";

const USER = "00000000-0000-0000-0000-0000000009a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `maintenance-test-${randomUUID()}`;
const storage: RetentionStorage = { listObjects: async () => [], removeObject: async () => {} };

let t: TestDb;
let queue: Queue;
let events: QueueEvents;
let worker: Worker;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createMaintenanceWorker({ connection, db: t.db, storage, userId: USER, retentionDays: 30, queueName });
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await t.close();
});

describe("maintenance worker", () => {
  it("runs the retention sweep for a retention job and returns its counts", async () => {
    const job = await queue.add(RETENTION_JOB_NAME, {});
    const result = await job.waitUntilFinished(events, 15_000);
    expect(result).toMatchObject({ status: "completed", purgedApplications: 0 });
  });

  it("fails an unknown job name without retrying", async () => {
    const job = await queue.add("mystery", {}, { attempts: 3 });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(/^unknown_maintenance_job$/);
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
  });

  it("registers the daily retention scheduler idempotently", async () => {
    await scheduleRetention(queue);
    await scheduleRetention(queue);
    const ids = (await queue.getJobSchedulers()).map((s) => s.id ?? s.key);
    expect(ids.filter((id) => id === RETENTION_SCHEDULER_ID)).toHaveLength(1);
  });
});
