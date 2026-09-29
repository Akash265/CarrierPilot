import { describe, it, expect } from "vitest";
import type { StoredPitchBullet } from "@ai-career/application-package";
import { buildPitchModel } from "./buildPitchModel";

const bullets: StoredPitchBullet[] = [
  { kind: "company", text: "Company text.", supported: true, unsupportedReason: null, evidence: [{ id: "r:1", kind: "research", text: "e", sourceUrl: null }] },
  { kind: "role", text: "Role text.", supported: null, unsupportedReason: null, evidence: [] },
  { kind: "candidate", text: "Candidate text.", supported: true, unsupportedReason: null, evidence: [] },
];

describe("buildPitchModel", () => {
  it("builds a titled one-pager with the name, contact line and the three bullets in order, without evidence", () => {
    const model = buildPitchModel(
      { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: null, linkedinUrl: null },
      { title: "Backend Engineer", companyName: "GitLab" },
      bullets
    );
    expect(model).toEqual({
      title: "Why I'm a fit for Backend Engineer at GitLab",
      contactLine: "jane@example.com",
      blocks: [
        { type: "paragraph", text: "Jane Doe" },
        { type: "bullets", items: ["Company text.", "Role text.", "Candidate text."] },
      ],
    });
  });
});
