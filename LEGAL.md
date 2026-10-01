# Legal / Data Sourcing Notice

This project ingests job data only from sources the operator has explicit
permission to use: official ATS/job-board APIs (e.g. Greenhouse, Lever,
Ashby), RSS/XML feeds, user-provided file exports, and Apify actors.

Before enabling any data source, the operator must confirm they have
reviewed that source's Terms of Service and are legally permitted to
ingest its data programmatically. This tool ships with no open-ended
HTML scraper and does not sanction using one against a source whose ToS
prohibits it.

This is a personal, single-user tool. It is not designed or licensed for
resale or multi-tenant redistribution of ingested job data.

## Browser autofill

The browser autofill worker (Phase 8) only fills public, hosted job
application forms (Greenhouse, Lever) that you open yourself, on your own
machine, using your own copy of Chrome. It never submits a form — you
always review the filled fields and click Submit yourself — and it never
attempts to detect or solve a CAPTCHA. You are responsible for complying
with each site's terms of service when you choose to use this feature
against it.
