import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";

vi.mock("../research/runCompanyResearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../research/runCompanyResearch")>();
  return { ...actual, runCompanyResearch: vi.fn() };
});
vi.mock("../coverLetter/generateCoverLetter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../coverLetter/generateCoverLetter")>();
  return { ...actual, generateCoverLetter: vi.fn() };
});
vi.mock("@ai-career/resume-optimization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/resume-optimization")>();
  return { ...actual, ensureJobRequirements: vi.fn() };
});
import { runCompanyResearch } from "../research/runCompanyResearch";
import { generateCoverLetter, CoverLetterGenerationValidationError, type GenerateCoverLetterInput } from "../coverLetter/generateCoverLetter";
import { ensureJobRequirements } from "@ai-career/resume-optimization";
import { runCoverLetterGeneration } from "./runCoverLetterGeneration";
import type { CoverLetterDraft } from "../coverLetter/coverLetterSchema";

const USER = "00000000-0000-0000-0000-000000000012";
const ENV = { ANTHROPIC_MODEL_FAST: "fast-model", ANTHROPIC_MODEL_RESEARCH: "research-model", COMPANY_RESEARCH_MAX_SEARCHES: 5 };
const CLIENT = {} as Pick<Anthropic, "messages">;
let testDb: TestDb;

function groundedDraft(input: GenerateCoverLetterInput): CoverLetterDraft {
  const first = (kind: string) => input.evidence.filter((e) => e.kind === kind).slice(0, 1).map((e) => e.id);
  return {
    paragraphs: [
      { role: "opening", text: "Opening.", evidenceIds: first("requirement") },
      { role: "company", text: "Company.", evidenceIds: first("research") },
      { role: "evidence", text: "Evidence.", evidenceIds: first("profile") },
      { role: "closing", text: "Closing.", evidenceIds: [] },
    ],
    requiresReview: false,
  };
}

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(async () => {
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(async () => {
  vi.mocked(runCompanyResearch).mockReset();
  vi.mocked(generateCoverLetter).mockReset();
  vi.mocked(ensureJobRequirements).mockReset();
  vi.mocked(runCompanyResearch).mockResolvedValue({
    status: "ok", errorCode: null, researchModel: "research-model", searchCount: 1,
    webFacts: [{ sourceKind: "web", factText: "Acme builds rockets.", sourceUrl: "https://acme.example", sourceTitle: "Acme", citedText: "x" }],
  });
  vi.mocked(ensureJobRequirements).mockResolvedValue([
    { id: "11111111-1111-1111-1111-111111111111", termText: "SQL", requirementLevel: "required" },
  ] as never);
  vi.mocked(generateCoverLetter).mockImplementation(async (_c, _e, input) => groundedDraft(input));
  await wipeUser(testDb.adminSql, USER);
});

async function seed(opts: { match?: boolean; eligible?: boolean; profile?: boolean } = {}): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Data Engineer', 'data engineer', 'We use SQL.', 'hash-1', now(), now()) RETURNING id`;
  if (opts.match !== false) {
    await testDb.adminSql`
      INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
      VALUES (${USER}, ${job.id}, ${goal.id}, ${opts.eligible ?? true}, now())`;
  }
  if (opts.profile !== false) {
    const [exp] = await testDb.adminSql`
      INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${USER}, 'Globex', 'Engineer', 0) RETURNING id`;
    await testDb.adminSql`
      INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
      VALUES (${USER}, ${exp.id}, 'Built a SQL pipeline', 0)`;
  }
  return job.id as string;
}

const run = (jobId: string) => runCoverLetterGeneration(testDb.db, { userId: USER, jobId, anthropicClient: CLIENT, env: ENV });

describe("runCoverLetterGeneration", () => {
  it("maps the gates to no_match / not_eligible / no_profile, the last before any paid research", async () => {
    await expect(run(await seed({ match: false }))).rejects.toMatchObject({ errorClass: "no_match" });
    await wipeUser(testDb.adminSql, USER);
    await expect(run(await seed({ eligible: false }))).rejects.toMatchObject({ errorClass: "not_eligible" });
    await wipeUser(testDb.adminSql, USER);
    await expect(run(await seed({ profile: false }))).rejects.toMatchObject({ errorClass: "no_profile" });
    expect(runCompanyResearch).not.toHaveBeenCalled();
  });

  it("persists a guarded, generated version 1 with research snapshot fields", async () => {
    const jobId = await seed();
    const { coverLetter, research } = await run(jobId);
    expect(coverLetter).toMatchObject({
      jobId, version: 1, origin: "generated", parentCoverLetterId: null, requiresReview: false,
      companyResearchId: research.research.id, researchStatusSnapshot: "ok", generationModel: "fast-model",
    });
    expect(coverLetter.sourceProfileContentHash).toMatch(/^[0-9a-f]+$/);
    const paragraphs = coverLetter.paragraphs as { role: string; supported: boolean; evidence: { kind: string }[] }[];
    expect(paragraphs.map((p) => [p.role, p.supported])).toEqual([["opening", true], ["company", true], ["evidence", true], ["closing", true]]);
    expect(paragraphs[1].evidence[0].kind).toBe("research");
  });

  it("stores a guard failure as supported=false with requiresReview=true", async () => {
    vi.mocked(generateCoverLetter).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.paragraphs[2] = { ...d.paragraphs[2], evidenceIds: [] };
      return d;
    });
    const { coverLetter } = await run(await seed());
    expect((coverLetter.paragraphs as { supported: boolean }[])[2].supported).toBe(false);
    expect(coverLetter.requiresReview).toBe(true);
  });

  it("sets requiresReview but keeps paragraphs supported when a non-opening paragraph mentions a missing required term", async () => {
    vi.mocked(ensureJobRequirements).mockResolvedValue([
      { id: "11111111-1111-1111-1111-111111111111", termText: "SQL", requirementLevel: "required" },
      { id: "11111111-1111-1111-1111-111111111112", termText: "Kubernetes", requirementLevel: "required" },
    ] as never);
    vi.mocked(generateCoverLetter).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.paragraphs[2] = { ...d.paragraphs[2], text: "I run Kubernetes clusters every day." };
      return d;
    });
    const { coverLetter } = await run(await seed());
    expect(coverLetter.requiresReview).toBe(true);
    expect((coverLetter.paragraphs as { supported: boolean }[]).every((p) => p.supported)).toBe(true);
  });

  it("does not set requiresReview when only the opening names a missing required term", async () => {
    vi.mocked(ensureJobRequirements).mockResolvedValue([
      { id: "11111111-1111-1111-1111-111111111111", termText: "SQL", requirementLevel: "required" },
      { id: "11111111-1111-1111-1111-111111111112", termText: "Kubernetes", requirementLevel: "required" },
    ] as never);
    vi.mocked(generateCoverLetter).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.paragraphs[0] = { ...d.paragraphs[0], text: "The role asks for SQL and Kubernetes." };
      return d;
    });
    const { coverLetter } = await run(await seed());
    expect(coverLetter.requiresReview).toBe(false);
  });

  it("maps Anthropic.APIError and CoverLetterGenerationValidationError to unknown; rethrows anything else", async () => {
    const jobId = await seed();
    vi.mocked(generateCoverLetter).mockRejectedValueOnce(new Anthropic.APIError(429, {}, "rate limited", undefined));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(generateCoverLetter).mockRejectedValueOnce(new CoverLetterGenerationValidationError("bad"));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(generateCoverLetter).mockRejectedValueOnce(new TypeError("bug"));
    await expect(run(jobId)).rejects.toThrow(TypeError);
  });

  it("refuses to store paragraph text containing a lone surrogate", async () => {
    vi.mocked(generateCoverLetter).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.paragraphs[0] = { ...d.paragraphs[0], text: "Bad \uD800 text" };
      return d;
    });
    await expect(run(await seed())).rejects.toMatchObject({ errorClass: "unknown" });
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM cover_letters WHERE user_id = ${USER}`;
    expect(n).toBe(0);
  });

  it("allocates versions 1 and 2 to two concurrent runs", async () => {
    const jobId = await seed();
    const [a, b] = await Promise.all([run(jobId), run(jobId)]);
    expect([a.coverLetter.version, b.coverLetter.version].sort()).toEqual([1, 2]);
  });
});
