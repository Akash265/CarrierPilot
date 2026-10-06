import { describe, it, expect } from "vitest";
import { detectSubmission } from "./detectSubmission";
import { greenhouseV1, leverV1 } from "../adapters";

const GH_FORM = "https://job-boards.greenhouse.io/acme/jobs/123";
const LV_FORM = "https://jobs.lever.co/acme/abc/apply";

describe("detectSubmission", () => {
  it("detects the Greenhouse confirmation URL", () => {
    expect(detectSubmission(greenhouseV1, { url: `${GH_FORM}/confirmation`, text: "", formUrl: GH_FORM })).toBe(true);
  });

  it("detects the Lever thanks URL", () => {
    expect(detectSubmission(leverV1, { url: "https://jobs.lever.co/acme/abc/thanks", text: "", formUrl: LV_FORM })).toBe(true);
  });

  it("detects thanks text only away from the form URL", () => {
    const text = "Thank you for applying to Acme!";
    expect(detectSubmission(greenhouseV1, { url: `${GH_FORM}?step=done`, text, formUrl: GH_FORM })).toBe(true);
    expect(detectSubmission(greenhouseV1, { url: GH_FORM, text, formUrl: GH_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "https://jobs.lever.co/acme/abc", text: "Application submitted!", formUrl: LV_FORM })).toBe(true);
  });

  it("ignores other hosts, the form itself and unparsable URLs", () => {
    expect(detectSubmission(greenhouseV1, { url: "https://evil.example/confirmation", text: "Thank you for applying", formUrl: GH_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: LV_FORM, text: "Submit your application", formUrl: LV_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "about:blank", text: "", formUrl: LV_FORM })).toBe(false);
    expect(detectSubmission(leverV1, { url: "not a url", text: "", formUrl: LV_FORM })).toBe(false);
  });

  it("works for a local fixture host (tests serve forms from 127.0.0.1)", () => {
    const form = "http://127.0.0.1:4555/greenhouse";
    expect(detectSubmission(greenhouseV1, { url: "http://127.0.0.1:4555/greenhouse/confirmation", text: "", formUrl: form })).toBe(true);
  });
});
