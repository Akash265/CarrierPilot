import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateInterviewPrep, InterviewPrepGenerationValidationError, type GenerateInterviewPrepInput } from "./generateInterviewPrep";

const ENV = { ANTHROPIC_MODEL_RESEARCH: "research-model" };
const INPUT: GenerateInterviewPrepInput = {
  jobTitle: "Data Engineer",
  companyName: "Acme",
  evidence: [
    { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
    { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
    { id: "q:q2", kind: "requirement", text: "[required] Kubernetes", sourceUrl: null },
    { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
  ],
  gapTerms: [{ term: "Kubernetes", requirementId: "q2" }],
};
const likely = (i: number) => ({ question: `Q${i}?`, category: "technical", answerOutline: ["Point"], evidenceIds: ["q:q1", "p:b1"] });
const VALID = {
  likelyQuestions: [1, 2, 3, 4, 5].map(likely),
  gapQuestions: [{ question: "Kubernetes?", requirementTerm: "Kubernetes", framing: "Adjacent experience.", evidenceIds: ["q:q2"] }],
  talkingPoints: [1, 2, 3].map((i) => ({ text: `T${i}`, evidenceIds: ["r:f1"] })),
  questionsToAsk: [1, 2, 3].map((i) => ({ question: `A${i}?`, evidenceIds: ["r:f1"] })),
  requiresReview: false,
};

function clientWith(input: unknown, hasToolUse = true) {
  const create = vi.fn().mockResolvedValue({
    content: hasToolUse ? [{ type: "tool_use", id: "t1", name: "record_interview_prep", input }] : [{ type: "text", text: "no", citations: null }],
  });
  return { client: { messages: { create } as unknown as Anthropic["messages"] }, create };
}

describe("generateInterviewPrep", () => {
  it("uses the research-tier model with a forced tool call and returns the validated draft", async () => {
    const { client, create } = clientWith(VALID);
    const draft = await generateInterviewPrep(client, ENV, INPUT);
    expect(draft.likelyQuestions).toHaveLength(5);
    const call = create.mock.calls[0][0];
    expect(call.model).toBe("research-model");
    expect(call.tool_choice).toEqual({ type: "tool", name: "record_interview_prep" });
  });

  it("wraps job, evidence and gap terms in three random delimiters, giving each gap term its q: id", async () => {
    const { client, create } = clientWith(VALID);
    await generateInterviewPrep(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    const content = call.messages[0].content as string;
    const tags = [...content.matchAll(/<(interview_prep_(?:job|evidence|gaps)_[0-9a-f]{16})>/g)].map((m) => m[1]);
    expect(tags).toHaveLength(3);
    for (const tag of tags) expect(call.system).toContain(tag);
    expect(content).toContain('{"term":"Kubernetes","requirementId":"q:q2"}');
    expect(call.system).toMatch(/never claim/i);
  });

  it("instructs the model that likely questions must not target a gap term", async () => {
    const { client, create } = clientWith(VALID);
    await generateInterviewPrep(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(call.system).toMatch(/likely questions must not target any term listed in the gaps block/i);
  });

  it("instructs the model that a gap question's evidenceIds must include its own requirementId, and says so in the tool schema too", async () => {
    const { client, create } = clientWith(VALID);
    await generateInterviewPrep(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(call.system).toMatch(/evidenceIds MUST include that term's requirementId/i);
    const gapEvidenceIdsSchema = call.tools[0].input_schema.properties.gapQuestions.items.properties.evidenceIds;
    expect(gapEvidenceIdsSchema.description).toMatch(/must include this term's requirementid/i);
  });

  it("instructs the model that talking points must not speculate about the company", async () => {
    const { client, create } = clientWith(VALID);
    await generateInterviewPrep(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(call.system).toMatch(/never speculate about the company/i);
    expect(call.system).toMatch(/at least 3, up to 6/i);
  });

  it("throws InterviewPrepGenerationValidationError without a tool_use block or on schema failure", async () => {
    await expect(generateInterviewPrep(clientWith(VALID, false).client, ENV, INPUT)).rejects.toThrow(InterviewPrepGenerationValidationError);
    await expect(generateInterviewPrep(clientWith({ ...VALID, likelyQuestions: [] }).client, ENV, INPUT)).rejects.toThrow(InterviewPrepGenerationValidationError);
  });
});
