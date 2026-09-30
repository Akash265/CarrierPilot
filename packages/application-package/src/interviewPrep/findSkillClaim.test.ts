import { describe, it, expect } from "vitest";
import { findSkillClaim } from "./findSkillClaim";

describe("findSkillClaim", () => {
  it("flags a second-person claim followed by the term in the same sentence", () => {
    expect(findSkillClaim("Lead with it. You already know Kubernetes well from past work.", "Kubernetes")).toBe(
      "You already know Kubernetes well from past work."
    );
    expect(findSkillClaim("Your experience with Kubernetes is actually deep.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("You've run Kubernetes clusters before.", "Kubernetes")).not.toBeNull();
  });

  it("flags a first-person claim and the strength pattern", () => {
    expect(findSkillClaim('Say "I have shipped Kubernetes operators".', "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("This is actually a strength: Apache Spark is close to what you use.", "Apache Spark")).not.toBeNull();
  });

  it("handles a typographic apostrophe", () => {
    expect(findSkillClaim("You’ve used Kubernetes daily.", "Kubernetes")).not.toBeNull();
  });

  it("does not flag honest framing that negates the skill", () => {
    expect(findSkillClaim("You haven't used Kubernetes; mention your Docker work.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("Kubernetes isn't a tool you've used, so explain how you would ramp up on Kubernetes.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("Be upfront that this isn't a language you've used professionally yet; you would learn Go on the job.", "Go")).toBeNull();
    expect(findSkillClaim("You've never used Kubernetes, so say so.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("You have not worked with Kubernetes.", "Kubernetes")).toBeNull();
  });

  it("does not flag a conditional framing (if / whether / unless / in case earlier in the clause)", () => {
    expect(findSkillClaim("If you've used Kubernetes, mention it.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("Whether or not you have Kubernetes experience, show how you learn.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("Unless you have run Kubernetes in production, focus on Docker.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("In case you have touched Kubernetes, say where.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("Ask whether they have Kubernetes clusters.", "Kubernetes")).toBeNull();
  });

  it("still flags a plain claim, and a claim in a later clause after a conditional one", () => {
    expect(findSkillClaim("You have used Kubernetes.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("If they ask, you have run Kubernetes clusters.", "Kubernetes")).not.toBeNull();
  });

  it("flags third-person claims with the same negation and conditional handling", () => {
    expect(findSkillClaim("The candidate has solid Kubernetes experience.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("They have run Kubernetes clusters.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("The candidate's experience with Kubernetes is deep.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("The candidate’s background in Kubernetes is strong.", "Kubernetes")).not.toBeNull();
    expect(findSkillClaim("The candidate has no Kubernetes experience.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("They have not used Kubernetes.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("If the candidate has Kubernetes exposure, mention it.", "Kubernetes")).toBeNull();
  });

  it("requires the term after the claim pattern, in the same sentence, with a boundary-aware match", () => {
    expect(findSkillClaim("Kubernetes is new to you. You have strong Docker skills.", "Kubernetes")).toBeNull();
    expect(findSkillClaim("You have worked at Google.", "Go")).toBeNull();
    expect(findSkillClaim("You have Docker experience. Kubernetes is next.", "Kubernetes")).toBeNull();
  });
});
