import { describe, it, expect } from "vitest";
import { resolveAutofillTarget, type PostingRef } from "./resolveAutofillTarget";

const ref = (over: Partial<PostingRef> = {}): PostingRef => ({
  sourceKind: "greenhouse", slug: "acme", externalId: "123", status: "open", lastSeenAt: new Date("2026-09-30T00:00:00Z"), ...over,
});

describe("resolveAutofillTarget", () => {
  it("picks the newest open Greenhouse/Lever posting", () => {
    const target = resolveAutofillTarget([
      ref({ externalId: "old", lastSeenAt: new Date("2026-09-01T00:00:00Z") }),
      ref({ sourceKind: "lever", slug: "acme", externalId: "new-id", lastSeenAt: new Date("2026-09-29T00:00:00Z") }),
      ref({ externalId: "closed", status: "closed", lastSeenAt: new Date("2026-09-30T12:00:00Z") }),
    ]);
    expect(target).toMatchObject({ supported: true, formUrl: "https://jobs.lever.co/acme/new-id/apply" });
    if (target.supported) expect(target.adapter.portal).toBe("lever");
  });

  it("is unsupported without an open Greenhouse/Lever posting", () => {
    expect(resolveAutofillTarget([])).toEqual({ supported: false, reason: "no_supported_posting" });
    expect(resolveAutofillTarget([ref({ sourceKind: "upload", slug: null })])).toEqual({ supported: false, reason: "no_supported_posting" });
    expect(resolveAutofillTarget([ref({ status: "closed" })])).toEqual({ supported: false, reason: "no_supported_posting" });
  });

  it("rejects identifiers that are not plain slugs", () => {
    expect(resolveAutofillTarget([ref({ slug: "acme/../evil" })])).toEqual({ supported: false, reason: "invalid_identifiers" });
    expect(resolveAutofillTarget([ref({ externalId: "1?x=y" })])).toEqual({ supported: false, reason: "invalid_identifiers" });
    expect(resolveAutofillTarget([ref({ slug: null })])).toEqual({ supported: false, reason: "invalid_identifiers" });
  });

  it("skips an invalid posting when a valid one exists", () => {
    const target = resolveAutofillTarget([
      ref({ slug: "bad slug", lastSeenAt: new Date("2026-09-30T00:00:00Z") }),
      ref({ externalId: "777", lastSeenAt: new Date("2026-09-01T00:00:00Z") }),
    ]);
    expect(target).toMatchObject({ supported: true, formUrl: "https://job-boards.greenhouse.io/acme/jobs/777" });
  });
});
