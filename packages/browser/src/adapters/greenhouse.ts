import type { PortalAdapter } from "./types";

/**
 * The hosted job-boards.greenhouse.io form (inspected 2026-10-01; sanitized copy in fixtures/greenhouse-v1-form.html).
 * Standard fields have stable ids. Yes/no questions, country and EEO are react-select comboboxes, which are never
 * filled (choosing an option needs a click), so they always end up flagged or skipped.
 */
export const greenhouseV1: PortalAdapter = {
  portal: "greenhouse",
  version: "greenhouse-v1",
  allowedHosts: ["job-boards.greenhouse.io", "boards.greenhouse.io"],
  buildFormUrl: ({ slug, externalId }) =>
    `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(externalId)}`,
  snapshotConfig: { formSelector: "form#application-form", questionContainer: ".field-wrapper", questionLabel: "label" },
  requiredCanonicals: ["first_name", "last_name", "email", "resume"],
  standardFields: [
    { canonical: "first_name", match: { ids: [/^first_name$/] } },
    { canonical: "last_name", match: { ids: [/^last_name$/] } },
    { canonical: "email", match: { ids: [/^email$/] } },
    { canonical: "phone", match: { ids: [/^phone$/] } },
    { canonical: "resume", match: { ids: [/^resume$/] } },
    { canonical: "cover_letter", match: { ids: [/^cover_letter$/] } },
  ],
  confirmation: {
    urlPatterns: [/\/confirmation(?:\/|$)/],
    textPatterns: [/thank you for applying/i, /application (?:has been )?(?:received|submitted)/i],
  },
};
