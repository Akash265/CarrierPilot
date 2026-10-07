import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, Worker, UnrecoverableError } from "bullmq";
import { readQueueStatus } from "./status";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const codeQueue = `test-queue-${randomUUID()}`;
const messageQueue = `test-queue-${randomUUID()}`;
const emptyQueue = `test-queue-${randomUUID()}`;
const queues: Queue[] = [];

afterAll(async () => {
  for (const q of queues) {
    await q.obliterate({ force: true });
    await q.close();
  }
  await connection.quit();
});

async function failOne(name: string, error: Error) {
  const queue = new Queue(name, { connection });
  queues.push(queue);
  const job = await queue.add("job", {}, { attempts: 1, removeOnFail: false });
  const worker = new Worker(name, async () => { throw error; }, { connection });
  await new Promise<void>((resolve) => worker.on("failed", () => resolve()));
  await worker.close();
  return { queue, job };
}

describe("readQueueStatus", () => {
  it("counts jobs by state and shows the last failure's code when it is one of ours", async () => {
    const { queue } = await failOne(codeQueue, new UnrecoverableError("no_active_goal"));
    await queue.add("waiting", {});
    await queue.add("later", {}, { delay: 60_000 });

    const [status] = await readQueueStatus(connection, [codeQueue]);
    expect(status).toMatchObject({ queue: codeQueue, waiting: 1, active: 0, delayed: 1, failed: 1, lastFailedCode: "no_active_goal" });
    expect(Date.parse(status.lastFailedAt!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("withholds a failure reason that is a raw message", async () => {
    await failOne(messageQueue, new Error("insert failed for Jane Doe SENTINEL"));
    const [status] = await readQueueStatus(connection, [messageQueue]);
    expect(status).toMatchObject({ failed: 1, lastFailedCode: null });
    expect(status.lastFailedAt).not.toBeNull();
    expect(JSON.stringify(status)).not.toContain("SENTINEL");
  });

  it("reports an empty queue with zero counts and no failure", async () => {
    const [status] = await readQueueStatus(connection, [emptyQueue]);
    expect(status).toEqual({ queue: emptyQueue, waiting: 0, active: 0, delayed: 0, failed: 0, lastFailedAt: null, lastFailedCode: null });
  });
});
