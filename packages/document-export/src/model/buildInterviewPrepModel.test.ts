import { describe, it, expect } from "vitest";
import type { StoredInterviewPrepSections } from "@ai-career/application-package";
import { buildInterviewPrepModel } from "./buildInterviewPrepModel";

const g = (supported = true) => ({ supported, unsupportedReason: supported ? null : "x", evidence: [] });
const sections: StoredInterviewPrepSections = {
  likelyQuestions: [
    { question: "Tell me about SQL.", category: "technical", answerOutline: ["Pipeline", "Scale"], ...g() },
    { question: "A conflict?", category: "behavioral", answerOutline: ["Story"], ...g(false) },
  ],
  gapQuestions: [{ question: "Kubernetes?", requirementTerm: "Kubernetes", framing: "Be honest.", ...g() }],
  talkingPoints: [{ text: "Rockets.", ...g() }, { text: "Series B.", ...g(false) }],
  questionsToAsk: [{ question: "Team size?", ...g() }],
};

describe("buildInterviewPrepModel", () => {
  it("renders four headed sections and marks unsupported items as unverified", () => {
    const model = buildInterviewPrepModel({ title: "Backend Engineer", companyName: "GitLab" }, sections, ["Kubernetes"]);
    expect(model.title).toBe("Interview preparation: Backend Engineer at GitLab");
    expect(model.contactLine).toBeNull();
    expect(model.blocks).toEqual([
      { type: "heading", text: "Likely questions" },
      { type: "entry", title: "Tell me about SQL.", subtitle: "Technical", meta: null },
      { type: "bullets", items: ["Pipeline", "Scale"] },
      { type: "entry", title: "A conflict? (unverified)", subtitle: "Behavioral", meta: null },
      { type: "bullets", items: ["Story"] },
      { type: "heading", text: "Required skills not found in your profile" },
      { type: "paragraph", text: "Kubernetes" },
      { type: "entry", title: "Kubernetes?", subtitle: "Missing: Kubernetes", meta: null },
      { type: "paragraph", text: "Be honest." },
      { type: "heading", text: "Company talking points" },
      { type: "bullets", items: ["Rockets.", "Series B. (unverified)"] },
      { type: "heading", text: "Questions to ask" },
      { type: "bullets", items: ["Team size?"] },
    ]);
  });

  it("prints the Missing: subtitle only for a supported gap question", () => {
    const flagged = { ...sections, gapQuestions: [{ question: "SQL?", requirementTerm: "SQL", framing: "F.", ...g(false) }] };
    const model = buildInterviewPrepModel({ title: "T", companyName: "C" }, flagged, ["Kubernetes"]);
    expect(model.blocks).toContainEqual({ type: "entry", title: "SQL? (unverified)", subtitle: null, meta: null });
  });

  it("labels a role-category likely question \"Role\"", () => {
    const withRole = { ...sections, likelyQuestions: [{ question: "Why us?", category: "role" as const, answerOutline: ["Mission"], ...g() }] };
    const model = buildInterviewPrepModel({ title: "T", companyName: "C" }, withRole, []);
    expect(model.blocks[1]).toEqual({ type: "entry", title: "Why us?", subtitle: "Role", meta: null });
  });

  it("says so when there are no gap terms", () => {
    const model = buildInterviewPrepModel({ title: "T", companyName: "C" }, { ...sections, gapQuestions: [] }, []);
    const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === "Required skills not found in your profile");
    expect(model.blocks[i + 1]).toEqual({ type: "paragraph", text: "None: every required term appears in your profile." });
  });
});
