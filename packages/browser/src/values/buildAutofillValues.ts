import type { AutofillValues } from "../types";

export interface AutofillInput {
  profile: { fullName: string; email: string; phoneNumber: string | null; linkedinUrl: string | null; addressLine1: string | null };
  /** The active career goal's constraints, or null when there is none. */
  goal: {
    visaSponsorshipRequired: boolean | null;
    salaryTargetNormalized: string | null;
    salaryTargetCurrency: string | null;
    salaryTargetIsParsed: boolean;
  } | null;
  /** Whether a generated PDF exists (and was downloaded) for this job. */
  attachments: { resume: boolean; coverLetter: boolean };
}

const present = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * Design §4.3. Deterministic: every value comes from confirmed profile/goal data and carries its source label.
 * A missing value is simply absent -- buildFillPlan turns that into a skipped/flagged audit entry.
 */
export function buildAutofillValues(input: AutofillInput): AutofillValues {
  const values: AutofillValues = {};
  const text = (s: string | null, source: string) => (s === null ? undefined : { kind: "text" as const, text: s, source });

  const tokens = input.profile.fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) values.full_name = text(tokens.join(" "), "profile.fullName");
  if (tokens.length >= 2) {
    values.first_name = text(tokens.slice(0, -1).join(" "), "profile.fullName");
    values.last_name = text(tokens[tokens.length - 1], "profile.fullName");
  }
  values.email = text(present(input.profile.email), "profile.email");
  values.phone = text(present(input.profile.phoneNumber), "profile.phoneNumber");
  values.linkedin = text(present(input.profile.linkedinUrl), "profile.linkedinUrl");
  values.location = text(present(input.profile.addressLine1), "profile.addressLine1");

  if (input.attachments.resume) values.resume = { kind: "file", file: "resume", source: "generated_documents.resume" };
  if (input.attachments.coverLetter) values.cover_letter = { kind: "file", file: "cover_letter", source: "generated_documents.cover_letter" };

  const goal = input.goal;
  if (goal && goal.visaSponsorshipRequired !== null) {
    values.sponsorship = { kind: "boolean", value: goal.visaSponsorshipRequired, source: "goal.visaSponsorshipRequired" };
  }
  if (goal && goal.salaryTargetIsParsed && goal.salaryTargetNormalized !== null && present(goal.salaryTargetCurrency)) {
    const amount = Number(goal.salaryTargetNormalized);
    if (Number.isFinite(amount) && amount > 0) {
      values.salary_expectation = text(`${Math.round(amount)} ${goal.salaryTargetCurrency!.trim()}`, "goal.salaryTarget");
    }
  }

  for (const key of Object.keys(values) as (keyof AutofillValues)[]) if (values[key] === undefined) delete values[key];
  return values;
}
