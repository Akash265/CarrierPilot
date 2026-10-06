import type { PortalAdapter } from "./types";

/**
 * The hosted jobs.lever.co/{slug}/{id}/apply form (inspected 2026-10-01; sanitized copy in fixtures/lever-v1-form.html).
 * Standard fields are identified by `name`. The location input is an autocomplete widget backed by a hidden
 * selectedLocation, so it is flagged rather than typed into. There is no cover-letter file input.
 */
export const leverV1: PortalAdapter = {
  portal: "lever",
  version: "lever-v1",
  allowedHosts: ["jobs.lever.co"],
  buildFormUrl: ({ slug, externalId }) =>
    `https://jobs.lever.co/${encodeURIComponent(slug)}/${encodeURIComponent(externalId)}/apply`,
  snapshotConfig: { formSelector: "form#application-form", questionContainer: "li.application-question", questionLabel: ".application-label" },
  requiredCanonicals: ["full_name", "email", "resume"],
  standardFields: [
    { canonical: "resume", match: { names: [/^resume$/] } },
    { canonical: "full_name", match: { names: [/^name$/] } },
    { canonical: "email", match: { names: [/^email$/] } },
    { canonical: "phone", match: { names: [/^phone$/] } },
    { canonical: "location", match: { names: [/^location$/] }, flagReason: "autocomplete_widget" },
    { canonical: "linkedin", match: { names: [/^urls\[LinkedIn\]$/] } },
    { canonical: "github", match: { names: [/^urls\[GitHub\]$/] } },
    { canonical: "website", match: { names: [/^urls\[(?:Portfolio|Other|Twitter)\]$/] } },
  ],
  confirmation: {
    urlPatterns: [/\/thanks(?:\/|$)/],
    textPatterns: [/application submitted/i, /thank you for (?:applying|your application)/i],
  },
};
