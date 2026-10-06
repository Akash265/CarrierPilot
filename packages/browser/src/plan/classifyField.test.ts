import { describe, it, expect } from "vitest";
import { classifyField } from "./classifyField";
import { greenhouseV1, leverV1 } from "../adapters";
import type { SnapshotField } from "../types";

const field = (over: Partial<SnapshotField>): SnapshotField => ({
  key: "f0", control: "text", name: null, id: null, autocomplete: null, label: null, required: false, options: [], ...over,
});

describe("classifyField", () => {
  it("uses the adapter's standard rules first", () => {
    expect(classifyField(field({ id: "first_name", label: "First Name" }), greenhouseV1)).toEqual({ canonical: "first_name", flagReason: null });
    expect(classifyField(field({ name: "location" }), leverV1)).toEqual({ canonical: "location", flagReason: "autocomplete_widget" });
    expect(classifyField(field({ name: "urls[GitHub]" }), leverV1)).toEqual({ canonical: "github", flagReason: null });
  });

  it("falls back to shared label rules", () => {
    const c = (label: string) => classifyField(field({ label }), greenhouseV1)?.canonical ?? null;
    expect(c("LinkedIn Profile")).toBe("linkedin");
    expect(c("Will you now or in the future require sponsorship for a visa?")).toBe("sponsorship");
    expect(c("Are you legally authorized to work in the country for which you are applying?")).toBe("work_authorization");
    expect(c("Are you authorized to work in the US without sponsorship?")).toBe("work_authorization");
    expect(c("Are you a Ruritania citizen?")).toBe("work_authorization");
    expect(c("What are your salary expectations?")).toBe("salary_expectation");
    expect(c("Desired compensation")).toBe("salary_expectation");
    expect(c("Gender")).toBe("eeo");
    expect(c("Are you Hispanic/Latino?")).toBe("eeo");
    expect(c("Veteran Status")).toBe("eeo");
    expect(c("GitHub URL")).toBe("github");
    expect(c("Portfolio URL")).toBe("website");
    expect(c("Why do you want to work at Acme?")).toBeNull();
    expect(c("Have you previously worked at or consulted for Acme?")).toBeNull();
  });

  it("returns null for a field without id/name/label matches", () => {
    expect(classifyField(field({}), leverV1)).toBeNull();
  });

  it("flags a sponsorship question phrased with a polarity marker instead of filling it inverted", () => {
    expect(classifyField(field({ label: "Are you able to work in the UK without the need for visa sponsorship?" }), greenhouseV1)).toEqual({
      canonical: "sponsorship", flagReason: "ambiguous_wording",
    });
    expect(classifyField(field({ label: "Do you NOT require visa sponsorship?" }), greenhouseV1)).toEqual({
      canonical: "sponsorship", flagReason: "ambiguous_wording",
    });
    expect(classifyField(field({ label: "Don't you require visa sponsorship?" }), greenhouseV1)).toEqual({
      canonical: "sponsorship", flagReason: "ambiguous_wording",
    });
  });

  it("still fills the plain 'will you now or in the future require sponsorship' phrasing", () => {
    expect(classifyField(field({ label: "Will you now or in the future require sponsorship for a visa?" }), greenhouseV1)).toEqual({
      canonical: "sponsorship", flagReason: null,
    });
  });

  it("does not classify a 'how did you hear about us' question as linkedin", () => {
    expect(classifyField(field({ label: "How did you hear about us? (LinkedIn, referral, job board, etc.)" }), greenhouseV1)).toBeNull();
    expect(classifyField(field({ label: "LinkedIn Profile" }), greenhouseV1)).toEqual({ canonical: "linkedin", flagReason: null });
  });
});
