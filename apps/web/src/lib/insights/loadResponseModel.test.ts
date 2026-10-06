import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";
import { openAdminDb, wipeMatchingData, insertModelHistory } from "../../test/jobsDb";
import { clearResponseModelCache, loadResponseModel } from "./responseModel";

const USER = "00000000-0000-0000-0000-000000000a07";
/** Another user (unused elsewhere in the repo) whose history must never reach USER's model. */
const OTHER = "00000000-0000-0000-0000-000000000a09";
const ENV = { DEFAULT_USER_ID: USER, OUTCOME_UNDECIDED_DAYS: 30, OUTCOME_MODEL_MIN_DECIDED: 30, OUTCOME_MODEL_MIN_PER_CLASS: 8 };
let admin: postgres.Sql;
let db: DbClient;

beforeAll(async () => {
  admin = await openAdminDb();
  db = createDbClient({
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  });
});
beforeEach(async () => {
  clearResponseModelCache();
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await wipeMatchingData(admin, OTHER);
  await closeDbClient(db);
  await admin.end();
});

describe("loadResponseModel", () => {
  it("is insufficient_data for a user with no history", async () => {
    const { summary } = await loadResponseModel(db, ENV);
    expect(summary).toMatchObject({ status: "insufficient_data", decided: 0 });
  });

  it("trains an active model from the user's stored applications", async () => {
    await insertModelHistory(admin, USER, 40);
    const { result, summary } = await loadResponseModel(db, ENV, new Date("2026-10-06T12:00:00Z"));
    expect(summary).toEqual({
      status: "active", decided: 40, responses: 20, nonResponses: 20, minDecided: 30, minPerClass: 8, blendWeight: 0.2,
    });
    expect(result.model!.scaling.keys).toContain("skillsScore");
    expect(result.model!.scaling.keys).not.toContain("salaryScore");
  });

  it("never uses another user's history", async () => {
    await insertModelHistory(admin, OTHER, 40);
    const { summary } = await loadResponseModel(db, ENV, new Date("2026-10-06T12:00:00Z"));
    expect(summary).toMatchObject({ status: "insufficient_data", decided: 0, responses: 0 });

    await insertModelHistory(admin, USER, 40);
    const own = await loadResponseModel(db, ENV, new Date("2026-10-06T12:00:00Z"));
    expect(own.summary).toMatchObject({ status: "active", decided: 40 });
  });
});
