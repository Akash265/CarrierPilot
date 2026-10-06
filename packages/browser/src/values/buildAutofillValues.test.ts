import { describe, it, expect } from "vitest";
import { buildAutofillValues, type AutofillInput } from "./buildAutofillValues";

const input = (over: Partial<AutofillInput> = {}): AutofillInput => ({
  profile: { fullName: "Jane van Doe", email: " jane@example.com ", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin" },
  goal: { visaSponsorshipRequired: false, salaryTargetNormalized: "85000.00", salaryTargetCurrency: "EUR", salaryTargetIsParsed: true },
  attachments: { resume: true, coverLetter: false },
  ...over,
});

describe("buildAutofillValues", () => {
  it("maps profile fields and splits the name on the last whitespace", () => {
    const v = buildAutofillValues(input());
    expect(v.full_name).toEqual({ kind: "text", text: "Jane van Doe", source: "profile.fullName" });
    expect(v.first_name).toEqual({ kind: "text", text: "Jane van", source: "profile.fullName" });
    expect(v.last_name).toEqual({ kind: "text", text: "Doe", source: "profile.fullName" });
    expect(v.email).toEqual({ kind: "text", text: "jane@example.com", source: "profile.email" });
    expect(v.phone?.source).toBe("profile.phoneNumber");
    expect(v.linkedin?.source).toBe("profile.linkedinUrl");
    expect(v.location).toEqual({ kind: "text", text: "Berlin", source: "profile.addressLine1" });
  });

  it("leaves first/last name out for a single-token name and drops blank optional fields", () => {
    const v = buildAutofillValues(input({ profile: { fullName: "Cher", email: "c@example.com", phoneNumber: "  ", linkedinUrl: null, addressLine1: null } }));
    expect(v.full_name?.kind).toBe("text");
    expect(v.first_name).toBeUndefined();
    expect(v.last_name).toBeUndefined();
    expect(v.phone).toBeUndefined();
    expect(v.linkedin).toBeUndefined();
    expect(v.location).toBeUndefined();
  });

  it("offers attachments only when they exist", () => {
    expect(buildAutofillValues(input()).resume).toEqual({ kind: "file", file: "resume", source: "generated_documents.resume" });
    expect(buildAutofillValues(input()).cover_letter).toBeUndefined();
    expect(buildAutofillValues(input({ attachments: { resume: false, coverLetter: true } })).cover_letter?.kind).toBe("file");
  });

  it("answers sponsorship only from a non-null goal flag", () => {
    expect(buildAutofillValues(input()).sponsorship).toEqual({ kind: "boolean", value: false, source: "goal.visaSponsorshipRequired" });
    expect(buildAutofillValues(input({ goal: null })).sponsorship).toBeUndefined();
    const unknown = input();
    unknown.goal!.visaSponsorshipRequired = null;
    expect(buildAutofillValues(unknown).sponsorship).toBeUndefined();
  });

  it("uses the parsed salary target only (never the floor)", () => {
    expect(buildAutofillValues(input()).salary_expectation).toEqual({ kind: "text", text: "85000 EUR", source: "goal.salaryTarget" });
    const unparsed = input();
    unparsed.goal!.salaryTargetIsParsed = false;
    expect(buildAutofillValues(unparsed).salary_expectation).toBeUndefined();
    const noCurrency = input();
    noCurrency.goal!.salaryTargetCurrency = null;
    expect(buildAutofillValues(noCurrency).salary_expectation).toBeUndefined();
  });
});
