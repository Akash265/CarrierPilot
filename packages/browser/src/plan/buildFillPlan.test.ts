import { describe, it, expect } from "vitest";
import { buildFillPlan } from "./buildFillPlan";
import { buildAutofillValues, type AutofillInput } from "../values/buildAutofillValues";
import { greenhouseV1, leverV1 } from "../adapters";
import { snapshotFromHtml, readFixture } from "../testing";
import type { FieldAuditEntry, FormSnapshot, SnapshotField } from "../types";

const INPUT: AutofillInput = {
  profile: { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "https://linkedin.com/in/jane", addressLine1: "Berlin" },
  goal: { visaSponsorshipRequired: false, salaryTargetNormalized: "85000", salaryTargetCurrency: "EUR", salaryTargetIsParsed: true },
  attachments: { resume: true, coverLetter: true },
};
const values = buildAutofillValues(INPUT);
const gh = snapshotFromHtml(readFixture("greenhouse-v1-form.html"), greenhouseV1.snapshotConfig);
const lv = snapshotFromHtml(readFixture("lever-v1-form.html"), leverV1.snapshotConfig);

const auditFor = (audit: FieldAuditEntry[], snap: FormSnapshot, pick: (f: SnapshotField) => boolean) => {
  const key = snap.fields.find(pick)!.key;
  return audit.find((a) => a.key === key)!;
};

describe("buildFillPlan on the Greenhouse fixture", () => {
  const plan = buildFillPlan(gh, greenhouseV1, values);

  it("is healthy and fills exactly the confident fields", () => {
    expect(plan.healthy).toBe(true);
    const filled = plan.audit.filter((a) => a.action === "filled").map((a) => a.canonical).sort();
    expect(filled).toEqual(["cover_letter", "email", "first_name", "last_name", "linkedin", "phone", "resume"]);
    expect(plan.actions).toHaveLength(7);
    expect(plan.actions.find((a) => a.kind === "setInputFiles" && a.file === "resume")).toBeDefined();
  });

  it("flags the sponsorship combobox and required unknown comboboxes", () => {
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622859002")).toMatchObject({
      canonical: "sponsorship", action: "flagged", reason: "unsupported_control",
    });
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622860002")).toMatchObject({ canonical: null, action: "flagged", reason: "unrecognized" });
  });

  it("skips optional EEO and unknown optional fields", () => {
    expect(auditFor(plan.audit, gh, (f) => f.id === "gender")).toMatchObject({ canonical: "eeo", action: "skipped", reason: "intentionally_not_filled" });
    expect(auditFor(plan.audit, gh, (f) => f.id === "question_36622855002")).toMatchObject({ action: "skipped", reason: "unrecognized" });
  });

  it("audits every field exactly once", () => {
    expect(plan.audit.map((a) => a.key).sort()).toEqual(gh.fields.map((f) => f.key).sort());
  });
});

describe("buildFillPlan on the Lever fixture", () => {
  const plan = buildFillPlan(lv, leverV1, values);

  it("is healthy and answers the yes/no sponsorship radio group from the goal", () => {
    expect(plan.healthy).toBe(true);
    const sponsorship = lv.fields.find((f) => f.label?.startsWith("Will you now or in the future require sponsorship"))!;
    const no = sponsorship.options.find((o) => o.label === "No")!;
    expect(plan.actions).toContainEqual({ kind: "check", fieldKey: sponsorship.key, targetKey: no.key });
    expect(auditFor(plan.audit, lv, (f) => f.key === sponsorship.key)).toMatchObject({ action: "filled", valueSource: "goal.visaSponsorshipRequired" });
  });

  it("fills standard fields and flags the location widget and work authorization", () => {
    const filled = plan.audit.filter((a) => a.action === "filled").map((a) => a.canonical).sort();
    expect(filled).toEqual(["email", "full_name", "linkedin", "phone", "resume", "sponsorship"]);
    expect(auditFor(plan.audit, lv, (f) => f.name === "location")).toMatchObject({ action: "flagged", reason: "autocomplete_widget" });
    expect(auditFor(plan.audit, lv, (f) => f.label?.startsWith("Are you legally authorized") ?? false)).toMatchObject({
      canonical: "work_authorization", action: "flagged", reason: "not_auto_filled",
    });
    expect(auditFor(plan.audit, lv, (f) => f.name === "urls[GitHub]")).toMatchObject({ action: "skipped", reason: "not_auto_filled" });
  });
});

describe("buildFillPlan rules", () => {
  const f = (over: Partial<SnapshotField>): SnapshotField => ({
    key: "f0", control: "text", name: null, id: null, autocomplete: null, label: null, required: false, options: [], ...over,
  });
  const snap = (fields: SnapshotField[], formFound = true): FormSnapshot => ({ url: "https://x.test", formFound, fields });
  const healthyGh = [
    f({ key: "f1", id: "first_name" }), f({ key: "f2", id: "last_name" }), f({ key: "f3", id: "email" }), f({ key: "f4", id: "resume", control: "file" }),
  ];

  it("fails the health check when a required canonical is missing or the form is absent, and fills nothing", () => {
    const missing = buildFillPlan(snap(healthyGh.slice(0, 3)), greenhouseV1, values);
    expect(missing).toMatchObject({ healthy: false, missingForHealth: ["resume"], actions: [] });
    expect(missing.audit.every((a) => a.action === "skipped" && a.reason === "health_check_failed")).toBe(true);
    expect(buildFillPlan(snap([], false), greenhouseV1, values)).toMatchObject({ healthy: false, actions: [] });
  });

  it("flags ambiguous matches instead of guessing", () => {
    const plan = buildFillPlan(snap([...healthyGh, f({ key: "f5", label: "LinkedIn" }), f({ key: "f6", label: "LinkedIn profile URL" })]), greenhouseV1, values);
    expect(plan.audit.filter((a) => a.canonical === "linkedin").map((a) => a.reason)).toEqual(["ambiguous_match", "ambiguous_match"]);
  });

  it("flags a missing resume export even though the field is optional", () => {
    const noResume = buildAutofillValues({ ...INPUT, attachments: { resume: false, coverLetter: false } });
    const plan = buildFillPlan(snap(healthyGh), greenhouseV1, noResume);
    expect(plan.audit.find((a) => a.canonical === "resume")).toMatchObject({ action: "flagged", reason: "no_resume_export" });
  });

  it("uses a select's Yes/No option value and flags unrecognized options", () => {
    const yesNo = f({ key: "f7", control: "select", label: "Do you require visa sponsorship?", options: [
      { key: "f7", label: "Select...", value: "" }, { key: "f7", label: "Yes", value: "1" }, { key: "f7", label: "No", value: "0" },
    ] });
    const plan = buildFillPlan(snap([...healthyGh, yesNo]), greenhouseV1, values);
    expect(plan.actions).toContainEqual({ kind: "selectOption", fieldKey: "f7", targetKey: "f7", optionValue: "0" });
    const odd = f({ key: "f8", control: "radio_group", required: true, label: "Will you require sponsorship?", options: [
      { key: "f9", label: "Maybe", value: "m" }, { key: "f10", label: "Later", value: "l" },
    ] });
    expect(buildFillPlan(snap([...healthyGh, odd]), greenhouseV1, values).audit.find((a) => a.key === "f8")).toMatchObject({
      action: "flagged", reason: "unrecognized_options",
    });
  });

  it("never puts a value into the audit", () => {
    const serialized = JSON.stringify([buildFillPlan(gh, greenhouseV1, values).audit, buildFillPlan(lv, leverV1, values).audit]);
    for (const secret of ["jane@example.com", "Jane", "Doe", "+49 30 1234", "linkedin.com/in/jane", "85000"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("always flags unfilled sponsorship questions even when optional", () => {
    const noGoal = buildAutofillValues({ ...INPUT, goal: null });
    const sponsorshipRadio = f({ key: "f_sp", control: "radio_group", required: false, label: "Will you require sponsorship?", options: [
      { key: "f_sp_y", label: "Yes", value: "1" }, { key: "f_sp_n", label: "No", value: "0" },
    ] });
    const plan = buildFillPlan(snap([...healthyGh, sponsorshipRadio]), greenhouseV1, noGoal);
    expect(plan.audit.find((a) => a.key === "f_sp")).toMatchObject({ canonical: "sponsorship", action: "flagged", reason: "no_value" });
  });

  it("always flags unfilled salary_expectation questions even when optional", () => {
    const noSalary = buildAutofillValues({ ...INPUT, goal: null });
    const salaryText = f({ key: "f_sal", control: "text", required: false, label: "What are your salary expectations?" });
    const plan = buildFillPlan(snap([...healthyGh, salaryText]), greenhouseV1, noSalary);
    expect(plan.audit.find((a) => a.key === "f_sal")).toMatchObject({ canonical: "salary_expectation", action: "flagged", reason: "no_value" });
  });

  it("always flags salary_expectation with unsupported control even when optional", () => {
    const salaryCombo = f({ key: "f_sal_combo", control: "combobox", required: false, label: "What are your salary expectations?" });
    const plan = buildFillPlan(snap([...healthyGh, salaryCombo]), greenhouseV1, values);
    expect(plan.audit.find((a) => a.key === "f_sal_combo")).toMatchObject({ canonical: "salary_expectation", action: "flagged", reason: "unsupported_control" });
  });

  it("flags a polarity-worded sponsorship question instead of filling it inverted", () => {
    const negated = f({ key: "f_neg", control: "radio_group", required: true, label: "Are you able to work in the UK without the need for visa sponsorship?", options: [
      { key: "f_neg_y", label: "Yes", value: "1" }, { key: "f_neg_n", label: "No", value: "0" },
    ] });
    const plan = buildFillPlan(snap([...healthyGh, negated]), greenhouseV1, values);
    expect(plan.audit.find((a) => a.key === "f_neg")).toMatchObject({ canonical: "sponsorship", action: "flagged", reason: "ambiguous_wording" });
    expect(plan.actions.find((a) => a.fieldKey === "f_neg")).toBeUndefined();
  });

  it("regression: the Lever fixture's plain sponsorship question is still filled", () => {
    const plan = buildFillPlan(lv, leverV1, values);
    const sponsorship = lv.fields.find((f2) => f2.label?.startsWith("Will you now or in the future require sponsorship"))!;
    expect(auditFor(plan.audit, lv, (f2) => f2.key === sponsorship.key)).toMatchObject({ action: "filled" });
  });

  it("still skips optional unrecognized fields", () => {
    const unknown = f({ key: "f_unknown", control: "text", required: false, label: "Some random question" });
    const plan = buildFillPlan(snap([...healthyGh, unknown]), greenhouseV1, values);
    expect(plan.audit.find((a) => a.key === "f_unknown")).toMatchObject({ action: "skipped", reason: "unrecognized" });
  });
});
