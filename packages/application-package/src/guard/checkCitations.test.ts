import { describe, it, expect } from "vitest";
import { checkCitations, indexEvidence, toGuarded } from "./checkCitations";
import type { PitchEvidenceItem } from "../pitch/buildEvidenceIndex";

const EVIDENCE: PitchEvidenceItem[] = [
  { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
  { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
  { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
];
const lookup = indexEvidence(EVIDENCE);

describe("checkCitations", () => {
  it("passes when every group is satisfied and snapshots evidence in citation order", () => {
    const r = checkCitations(lookup, ["p:b1", "q:q1"], [["requirement"], ["profile"]]);
    expect(r.reasons).toEqual([]);
    expect(r.evidence.map((e) => e.id)).toEqual(["p:b1", "q:q1"]);
    expect(r.evidence[0]).toEqual({ id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null });
  });

  it("requires every group (AND across groups)", () => {
    const r = checkCitations(lookup, ["q:q1"], [["requirement"], ["profile"]]);
    expect(r.reasons).toEqual(["cites no profile evidence"]);
  });

  it("accepts any kind inside one group (OR within a group) and names all alternatives when missing", () => {
    expect(checkCitations(lookup, ["q:q1"], [["research", "requirement"]]).reasons).toEqual([]);
    expect(checkCitations(lookup, ["p:b1"], [["research", "requirement"]]).reasons).toEqual([
      "cites no company research or job requirement",
    ]);
  });

  it("with an empty requirement only validates ids", () => {
    expect(checkCitations(lookup, [], []).reasons).toEqual([]);
    expect(checkCitations(lookup, ["x:1"], []).reasons).toEqual(['evidence id "x:1" does not exist']);
  });

  it("flags unknown and repeated ids, keeping valid citations once", () => {
    const r = checkCitations(lookup, ["r:f1", "r:f1", "r:ghost"], [["research"]]);
    expect(r.reasons).toEqual(['evidence id "r:f1" is cited more than once', 'evidence id "r:ghost" does not exist']);
    expect(r.evidence.map((e) => e.id)).toEqual(["r:f1"]);
  });

  it("toGuarded joins reasons and sets supported", () => {
    expect(toGuarded({ reasons: [], evidence: [] })).toEqual({ supported: true, unsupportedReason: null, evidence: [] });
    expect(toGuarded({ reasons: ["a", "b"], evidence: [] })).toEqual({ supported: false, unsupportedReason: "a; b", evidence: [] });
  });

  it("caps a very long model-supplied id inside a reason", () => {
    const r = checkCitations(lookup, ["r:" + "x".repeat(500)], []);
    expect(r.reasons[0].length).toBeLessThan(100);
  });
});
