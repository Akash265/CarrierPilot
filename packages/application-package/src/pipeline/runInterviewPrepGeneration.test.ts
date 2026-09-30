import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";

vi.mock("../research/runCompanyResearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../research/runCompanyResearch")>();
  return { ...actual, runCompanyResearch: vi.fn() };
});
vi.mock("../interviewPrep/generateInterviewPrep", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../interviewPrep/generateInterviewPrep")>();
  return { ...actual, generateInterviewPrep: vi.fn() };
});
vi.mock("@ai-career/resume-optimization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/resume-optimization")>();
  return { ...actual, ensureJobRequirements: vi.fn() };
});
import { runCompanyResearch } from "../research/runCompanyResearch";
import {
  generateInterviewPrep, InterviewPrepGenerationValidationError, type GenerateInterviewPrepInput,
} from "../interviewPrep/generateInterviewPrep";
import { ensureJobRequirements } from "@ai-career/resume-optimization";
import { runInterviewPrepGeneration } from "./runInterviewPrepGeneration";
import type { InterviewPrepDraft } from "../interviewPrep/interviewPrepSchema";

const USER = "00000000-0000-0000-0000-000000000014";
const ENV = { ANTHROPIC_MODEL_FAST: "fast-model", ANTHROPIC_MODEL_RESEARCH: "research-model", COMPANY_RESEARCH_MAX_SEARCHES: 5 };
const CLIENT = {} as Pick<Anthropic, "messages">;
const SQL_ID = "11111111-1111-1111-1111-111111111111";
const K8S_ID = "11111111-1111-1111-1111-111111111112";
let testDb: TestDb;

function groundedDraft(input: GenerateInterviewPrepInput): InterviewPrepDraft {
  const first = (kind: string) => input.evidence.find((e) => e.kind === kind)!.id;
  const firstRequirement = () => input.evidence.find((e) => e.kind === "requirement" && e.text.includes("SQL"))!.id;
  const likely = () => ({ question: "Q?", category: "technical" as const, answerOutline: ["A"], evidenceIds: [firstRequirement(), first("profile")] });
  return {
    likelyQuestions: [likely(), likely(), likely(), likely(), likely()],
    gapQuestions: input.gapTerms.map((g) => ({ question: `${g.term}?`, requirementTerm: g.term, framing: "Honest.", evidenceIds: [`q:${g.requirementId}`] })),
    talkingPoints: [1, 2, 3].map(() => ({ text: "T", evidenceIds: [first("research")] })),
    questionsToAsk: [1, 2, 3].map(() => ({ question: "A?", evidenceIds: [first("research")] })),
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
  vi.mocked(generateInterviewPrep).mockReset();
  vi.mocked(ensureJobRequirements).mockReset();
  vi.mocked(runCompanyResearch).mockResolvedValue({
    status: "ok", errorCode: null, researchModel: "research-model", searchCount: 1,
    webFacts: [{ sourceKind: "web", factText: "Acme builds rockets.", sourceUrl: "https://acme.example", sourceTitle: "Acme", citedText: "x" }],
  });
  vi.mocked(ensureJobRequirements).mockResolvedValue([
    { id: SQL_ID, termText: "SQL", requirementLevel: "required" },
    { id: K8S_ID, termText: "Kubernetes", requirementLevel: "required" },
  ] as never);
  vi.mocked(generateInterviewPrep).mockImplementation(async (_c, _e, input) => groundedDraft(input));
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

const run = (jobId: string) => runInterviewPrepGeneration(testDb.db, { userId: USER, jobId, anthropicClient: CLIENT, env: ENV });

describe("runInterviewPrepGeneration", () => {
  it("maps the gates like the pitch, checking the profile before any paid research", async () => {
    await expect(run(await seed({ match: false }))).rejects.toMatchObject({ errorClass: "no_match" });
    await wipeUser(testDb.adminSql, USER);
    await expect(run(await seed({ eligible: false }))).rejects.toMatchObject({ errorClass: "not_eligible" });
    await wipeUser(testDb.adminSql, USER);
    await expect(run(await seed({ profile: false }))).rejects.toMatchObject({ errorClass: "no_profile" });
    expect(runCompanyResearch).not.toHaveBeenCalled();
  });

  it("passes only uncovered required terms as gap terms and snapshots them", async () => {
    const jobId = await seed();
    const { interviewPrep, research } = await run(jobId);
    const input = vi.mocked(generateInterviewPrep).mock.calls[0][2];
    expect(input.gapTerms).toEqual([{ term: "Kubernetes", requirementId: K8S_ID }]);
    expect(interviewPrep).toMatchObject({
      jobId, version: 1, requiresReview: false, gapTermsSnapshot: ["Kubernetes"],
      companyResearchId: research.research.id, researchStatusSnapshot: "ok", generationModel: "research-model",
    });
    const sections = interviewPrep.sections as { gapQuestions: { supported: boolean; requirementTerm: string }[] };
    expect(sections.gapQuestions).toMatchObject([{ requirementTerm: "Kubernetes", supported: true }]);
  });

  it("gives the model at most MAX_GAP_TERMS gap terms but snapshots every missing required term", async () => {
    const terms = ["Airflow", "Kafka", "Kubernetes", "Rust", "Scala", "Snowflake", "Terraform"];
    vi.mocked(ensureJobRequirements).mockResolvedValue([
      { id: SQL_ID, termText: "SQL", requirementLevel: "required" },
      ...terms.map((termText, i) => ({ id: `22222222-2222-2222-2222-22222222222${i}`, termText, requirementLevel: "required" })),
    ] as never);
    const { interviewPrep } = await run(await seed());
    const input = vi.mocked(generateInterviewPrep).mock.calls[0][2];
    expect(input.gapTerms.map((g) => g.term)).toEqual(terms.slice(0, 5));
    expect(interviewPrep.gapTermsSnapshot).toEqual(terms);
    expect(interviewPrep.requiresReview).toBe(false);
  });

  it("maps Anthropic.APIError and InterviewPrepGenerationValidationError to unknown; rethrows anything else", async () => {
    const jobId = await seed();
    vi.mocked(generateInterviewPrep).mockRejectedValueOnce(new Anthropic.APIError(500, {}, "boom", undefined));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(generateInterviewPrep).mockRejectedValueOnce(new InterviewPrepGenerationValidationError("bad"));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(generateInterviewPrep).mockRejectedValueOnce(new TypeError("bug"));
    await expect(run(jobId)).rejects.toThrow(TypeError);
  });

  it("refuses to store model text containing a lone surrogate", async () => {
    vi.mocked(generateInterviewPrep).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.likelyQuestions[0] = { ...d.likelyQuestions[0], answerOutline: ["Bad \uD800"] };
      return d;
    });
    await expect(run(await seed())).rejects.toMatchObject({ errorClass: "unknown" });
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM interview_preparations WHERE user_id = ${USER}`;
    expect(n).toBe(0);
  });

  it("refuses to store a gap term containing a lone surrogate", async () => {
    vi.mocked(ensureJobRequirements).mockResolvedValue([
      { id: SQL_ID, termText: "SQL", requirementLevel: "required" },
      { id: K8S_ID, termText: "Kube\uD800rnetes", requirementLevel: "required" },
    ] as never);
    // A draft that never echoes the term, so only the snapshot carries the unsafe text.
    vi.mocked(generateInterviewPrep).mockImplementation(async (_c, _e, input) => ({ ...groundedDraft(input), gapQuestions: [] }));
    await expect(run(await seed())).rejects.toMatchObject({ errorClass: "unknown" });
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM interview_preparations WHERE user_id = ${USER}`;
    expect(n).toBe(0);
  });

  it("allocates versions 1 and 2 to two concurrent runs", async () => {
    const jobId = await seed();
    const [a, b] = await Promise.all([run(jobId), run(jobId)]);
    expect([a.interviewPrep.version, b.interviewPrep.version].sort()).toEqual([1, 2]);
  });
});
