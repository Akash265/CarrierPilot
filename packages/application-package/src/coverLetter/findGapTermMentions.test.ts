import { describe, it, expect } from "vitest";
import { findGapTermMentions } from "./findGapTermMentions";

const GAPS = [
  { term: "Kubernetes", requirementId: "q2" },
  { term: "Go", requirementId: "q3" },
];

describe("findGapTermMentions", () => {
  it("returns, per paragraph and index-aligned, the gap terms a non-opening paragraph mentions (case-insensitive)", () => {
    const paragraphs = [
      { role: "opening" as const, text: "Opening." },
      { role: "company" as const, text: "Acme." },
      { role: "evidence" as const, text: "I ran KUBERNETES clusters." },
      { role: "closing" as const, text: "Thanks." },
    ];
    expect(findGapTermMentions(paragraphs, GAPS)).toEqual([[], [], ["Kubernetes"], []]);
  });

  it("ignores the opening, which may legitimately name the job's requirement", () => {
    const paragraphs = [
      { role: "opening" as const, text: "Your role asks for Kubernetes and Go." },
      { role: "closing" as const, text: "Thanks." },
    ];
    expect(findGapTermMentions(paragraphs, GAPS)).toEqual([[], []]);
  });

  it("uses the boundary-aware match and lists every mentioned term in gap-list order", () => {
    const paragraphs = [
      { role: "opening" as const, text: "Hi." },
      { role: "evidence" as const, text: "I worked at Google." },
      { role: "closing" as const, text: "I write Go and Kubernetes operators." },
    ];
    expect(findGapTermMentions(paragraphs, GAPS)).toEqual([[], [], ["Kubernetes", "Go"]]);
  });

  it("returns an empty list per paragraph when there are no gap terms", () => {
    expect(findGapTermMentions([{ role: "evidence", text: "Kubernetes." }], [])).toEqual([[]]);
  });
});
