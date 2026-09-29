# Phase 7b — Document Export & Storage: Design

Date: 2026-09-24
Status: design approved by user in brainstorming; not yet implemented.
Spec reference: project specification §10 (application package), §10.2 ("Before export, evaluate…"; section/format machine readability), §19 ("documents, generated resumes"), roadmap Phase 7 ("document storage"); Phase 6 design §1 (export deferred to Phase 7); Phase 7a design §1 (7b = export + storage).
Related decisions: D2 (RLS), D6 (never invent), D9 (log hygiene), D44 (`hasUnsafeText`), D59/D60 (resume_optimizations + evidence catalog built from profile tables), D63 (guard is the only authority on applied bullets), D71/D75/D77 (application_pitches shape, supported/user_edited), D79. New decisions are numbered from **D81**.

## 1. Scope

**In scope**
- Export of (a) an **optimized resume** — one `resume_optimizations` version merged into the user's current profile — and (b) a **Hiring Manager Pitch** — one `application_pitches` version — each as **PDF and DOCX**.
- **Stored, versioned documents**: every export is rendered once, uploaded to a private MinIO bucket, and recorded in a new `generated_documents` table; identical inputs reuse the stored file.
- Download of stored documents; a per-job list of past exports; download buttons on the existing Resume Optimization and Pitch panels.

**Out of scope (deliberate)**
- Cover letter and interview preparation (Phase 7c).
- Templates/themes, fonts other than the bundled one, page-design options.
- Retention/auto-deletion (architecture doc §9: 30 days after a terminal application status — Phase 9 owns that; see §3 known gap).
- Attaching documents to applications or portals (Phases 8/9).
- Any LLM call. Export is fully deterministic.

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Resume = every profile bullet; the optimizer's guard-applied rewordings replace their originals and come first in each role, untouched originals follow | Only the optimized selection (tailored/shorter); a per-export choice |
| 2 | Documents are stored in MinIO and recorded in `generated_documents`, de-duplicated by content hash | Render on demand with no storage |
| 3 | Export resume **and** pitch, each as **PDF + DOCX** | Resume only; PDF only |
| 4 | One format-neutral `DocumentModel`, rendered by `docx` (DOCX) and `pdfkit` (PDF) in pure JS with an embedded Unicode font | HTML + headless Chrome; DOCX → PDF via LibreOffice |
| 5 | Street address omitted from the resume header | Include `address_line1` |
| 6 | Export **blocked (409)** if the profile changed since the optimization, or a generated pitch has an unsupported bullet | Allow with a warning |

Each becomes a DECISIONS.md entry (D81 onward) when implemented.

## 3. Data model

### `generated_documents` (RLS-scoped like every table)

```
id                     uuid pk
userId                 uuid
jobId                  uuid, FK jobs(id) cascade
kind                   enum generated_document_kind: resume | pitch
format                 enum generated_document_format: pdf | docx
resumeOptimizationId   uuid, nullable, FK resume_optimizations(id) set null
applicationPitchId     uuid, nullable, FK application_pitches(id) set null
objectKey              text     -- "{userId}/{uuid}.{pdf|docx}" in bucket "generated-documents"; never user-controlled
byteSize               integer  -- CHECK > 0
contentHash            text     -- sha256 of (format, RENDERER_VERSION, stable JSON of the DocumentModel)
rendererVersion        text
downloadFilename       text     -- sanitized, e.g. "Jane Doe - GitLab - Resume.pdf"
createdAt              timestamptz
```

Constraints: CHECK `(kind = 'resume' AND application_pitch_id IS NULL) OR (kind = 'pitch' AND resume_optimization_id IS NULL)` — the source column that does not match `kind` is always null (the matching one may later become null via `ON DELETE SET NULL`, so it is not required non-null at the DB level; the pipeline always sets it at insert). Unique index `(user_id, job_id, kind, format, content_hash)` — de-duplication and the concurrency backstop (§4.4); `job_id` is part of the key (not just an FK) because the `DocumentModel` carries nothing job-specific, so without it an export for job B could return job A's stored row. Plus `generated_documents_job_id_idx` on `(job_id)` for the per-job list query (Postgres does not index FK columns automatically).

**Known gap (recorded, not solved here):** a `jobs` delete cascades `generated_documents` rows but leaves their MinIO objects; the future Phase 9 retention job must also sweep orphaned objects.

### Storage

`packages/storage` gains a second bucket `generated-documents` (private; created on first use exactly like `resumes`) with `uploadGeneratedDocument(client, { userId, buffer, extension }) → { objectKey }`, `getGeneratedDocument(client, objectKey) → Readable`, `deleteGeneratedDocument(client, objectKey)`.

## 4. Pipeline

New package `packages/document-export` (pure logic + DB + storage; no BullMQ), depending on `@ai-career/db`, `@ai-career/storage`, `@ai-career/config`, `@ai-career/resume-optimization` (for `buildResumeSnapshot`), `@ai-career/application-package` (types/`StoredPitchBullet`), `docx`, `pdfkit`, `drizzle-orm`, `zod`.

### 4.1 `DocumentModel`

```ts
type DocumentBlock =
  | { type: "heading"; text: string }            // section heading, e.g. "Experience"
  | { type: "entry"; title: string; subtitle: string | null; meta: string | null }  // "Engineer", "Globex · Berlin", "2021 – present"
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] };
interface DocumentModel {
  title: string;            // candidate full name (resume) / "Why I'm a fit for {role} at {company}" (pitch)
  contactLine: string | null;  // "email · phone · linkedin" (only non-empty parts)
  blocks: DocumentBlock[];
}
```

Every string in a model passes `hasUnsafeText` = false or the export fails with `invalid_content` (defense in depth; profile text was validated at confirm time). `storeDocument` runs the model through `normalizeModel` first — stripping/replacing XML-illegal control characters (D86) — and only then checks `hasUnsafeText` and computes the content hash, so both the safety check and the stored file reflect the cleaned text, not the raw model.

### 4.2 `buildResumeModel(profile, appliedBullets)` — pure

Inputs: the profile rows (candidate_profiles, work_experiences + bullets, achievements, projects, certifications, education, skills, each in `display_order`) and the optimization's `selectedBullets` (`AppliedBullet[]`: `sourceFactId`, `sourceType`, `optimizedText`, …) — the guard-applied set only; `rejectedClaims` are never read.

- Title = `fullName`; contact line = email · phone · linkedin (non-empty only). **No street address.**
- **Experience** (heading omitted if no roles): each role → `entry` (title = job title; subtitle = company [· location]; meta = "start – end|present", omitted if both null) + `bullets`: the role's bullets that the optimizer selected, in `selectedBullets` order, using `optimizedText`; then the role's remaining bullets in `display_order`, original text.
- **Projects**: each project → `entry` (title = name; subtitle = url or null) + `paragraph` = optimized description if selected, else original. Selected projects first (optimizer order), then the rest.
- **Achievements**: `bullets` — selected (optimized text, optimizer order) then the rest (original).
- **Education**, **Certifications**: verbatim from the profile, `display_order`; never reworded even if selected.
- **Skills**: one `paragraph` joining names with ", " — selected skills first (optimizer order, profile names, not `optimizedText`), then the rest.
- Empty sections are omitted. A selected bullet whose `sourceFactId` is not in the profile cannot occur (the hash check in §4.4 forbids a changed profile) — if it does, the function throws (bug, not a user error).

### 4.3 `buildPitchModel(profile, job, pitch)` — pure

Title "Why I'm a fit for {job.title} at {job.companyName}"; contact line as above preceded by the name in a first `paragraph`; one `bullets` block with the three bullet texts in order (company, role, candidate). No evidence, no labels.

### 4.4 `exportResume` / `exportPitch` (DB + storage)

```
exportResume(db, storage, { userId, jobId, optimizationId, format })
  1. load job (404 job_not_found), optimization where id = optimizationId AND job_id = jobId (400 source_mismatch)
  2. steps 2-3 run inside one withUserContext(..., { isolationLevel: "repeatable read" }) transaction:
     snapshot = buildResumeSnapshot(tx); if snapshot.contentHash !== optimization.sourceProfileContentHash
       → 409 profile_changed ("Your profile changed since this optimization. Regenerate it first.")
     (repeatable read: without it, a profile edit committing between buildResumeSnapshot's 7 SELECTs
     and loadResumeProfile's 8 could hash the old rows but render the new ones)
  3. load profile rows (same transaction); no candidate_profiles row → 409 no_profile
  4. model = buildResumeModel(...); contentHash = sha256(format + RENDERER_VERSION + stableStringify(model))
     (stableStringify = JSON with object keys sorted recursively; arrays keep order)
  5. existing row with (job_id, kind, format, contentHash) → return it (no render, no upload)
  6. buffer = render(model, format); objectKey = upload(buffer)          ── outside any transaction
  7. INSERT … ON CONFLICT (user_id, job_id, kind, format, content_hash) DO NOTHING RETURNING *
       nothing returned → a concurrent identical export won: delete our just-uploaded object, re-read and return theirs

exportPitch(db, storage, { userId, jobId, pitchId, format })
  1. job (404), pitch where id = pitchId AND job_id = jobId (400 source_mismatch)
  2. pitch.origin = "generated" AND any bullet supported === false
       → 409 pitch_unsupported   (a pitch whose requiresReview comes only from the model's own
         self-report, with every bullet supported, is exportable; user_edited versions always are) ("This pitch has an unsupported bullet. Edit or regenerate it first.")
  3. profile (409 no_profile); model = buildPitchModel(...); steps 4-7 as above
```

`downloadFilename` = sanitize(`{fullName} - {companyName} - {Resume|Pitch}.{ext}`): NFKD-normalize, strip diacritics, keep `[A-Za-z0-9 .,_-]`, collapse whitespace, trim to 120 chars, fallback "document".

Errors: a typed `DocumentExportError(errorClass)` for job_not_found / source_mismatch / profile_changed / pitch_unsupported / no_profile / invalid_content; a storage failure (MinIO error) → `storage_unavailable`; anything else rethrown.

### 4.5 Renderers

- `RENDERER_VERSION = "1"`; bump it whenever output for the same model changes.
- **Fonts:** Noto Sans Regular + Bold (SIL OFL 1.1) from the pinned devDependency `@expo-google-fonts/noto-sans@0.4.2`, embedded by a checked-in script `packages/document-export/scripts/embed-fonts.mjs` into a generated module `src/render/fonts.generated.ts` (base64) plus `assets/OFL.txt`; the generated module is committed and excluded from lint. No runtime filesystem access for fonts (works under any bundler).
- **PDF (`pdfkit`)**: A4, 50pt margins, single column; title 18pt bold, contact 10pt, headings 12pt bold with a rule, entries bold title + regular subtitle/meta, bullets as real text with "•" + hanging indent; automatic page breaks; document info Title set, `Producer` fixed; no images, no tables.
- **DOCX (`docx`)**: same structure using real Word heading styles (Heading 1/2) and a real bulleted numbering definition, single section, no tables/text boxes/headers-footers.
- `pdfkit` loads its built-in font metrics from disk; `apps/web/next.config.ts` adds `pdfkit` to `serverExternalPackages` (and `apps/web` depends on `pdfkit` directly so it resolves). This must be verified with `next build` + `next start` and a real PDF download (§8).

## 5. API

| Route | Behavior |
|---|---|
| `POST /api/documents` | body `{ kind: "resume" \| "pitch", jobId: uuid, sourceId: uuid, format: "pdf" \| "docx" }` (strict Zod) → 201 `{ document: DocumentView }` (also when an identical file already existed) |
| `GET /api/documents?jobId=` | `{ documents: DocumentView[] }` newest first; 404 for a non-UUID jobId |
| `GET /api/documents/[id]/download` | streams the object: `Content-Type` (application/pdf or the DOCX MIME type), `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`; 404 unknown id |

`DocumentView = { id, kind, format, sourceVersion (optimization/pitch version number or null), downloadFilename, byteSize, createdAt, downloadUrl }`.

Status codes: 400 invalid body / bad JSON / source_mismatch; 404 non-UUID or unknown job/document; 409 profile_changed / pitch_unsupported / no_profile; 502 storage_unavailable; 500 invalid_content (a bug). Error bodies carry fixed messages only. Logs never include document content.

## 6. UI

- `ResumeOptimizationPanel`: "Download PDF" / "Download DOCX" for the selected version.
- `PitchPanel`: the same for the selected version (disabled while editing).
- Click → `POST /api/documents` → on 201 navigate to `downloadUrl` (browser download); on error show the server message inline (e.g. the 409 texts).
- A "Documents" list (new small `DocumentsList` component) under the panels on `/matches/[jobId]`: kind, format, source version, time, download link. Refreshes after each export.

## 7. Error handling & security summary

- Object keys are generated (`{userId}/{uuid}.{ext}`); the user-visible name only appears in `Content-Disposition`, sanitized.
- Download route looks the row up under RLS before reading storage, so one user can never fetch another's object even with a known id.
- Profile changes after an optimization block resume export (no mixing old wording into a new profile); unsupported generated pitch bullets block pitch export.
- `hasUnsafeText` on every model string, run after `normalizeModel` has already stripped/replaced XML-illegal control characters (D86) — so the check and the stored/hashed content agree.
- Storage upload happens outside the DB transaction; an insert that loses a race deletes its own orphaned upload.

## 8. Testing

- **Unit:** `buildResumeModel` — one test per §4.2 rule (optimized-first + untouched kept, rejected never used, projects/achievements rule, education/certs verbatim even if selected, skills order and names, empty sections omitted, no street address, contact line assembly); `buildPitchModel`; filename sanitizer (diacritics, slashes, quotes, control chars, length, empty → "document"); `stableStringify`/hash stability.
- **Renderer round-trip (machine readability):** render a fixture model to PDF and DOCX; extract text with `extractText` from `@ai-career/ai` (the Phase 2 wrapper around `pdf-parse` / `mammoth`, which already handles pdf-parse's import quirk; devDependency only); assert every title/heading/entry/bullet string appears and in model order; cases: Unicode name ("José Núñez", "Łukasz Żółć"), a long resume that spans ≥ 3 pages, empty optional sections.
- **Storage:** upload/get/delete against the real MinIO from Docker Compose (same as `resumeStorage.test.ts`).
- **DB integration:** export pipelines — success paths, profile_changed, pitch_unsupported (generated) vs allowed (user_edited), source_mismatch, dedupe (second identical export returns same row, no second upload), concurrent identical exports → one row, loser's object deleted; RLS isolation test for `generated_documents`.
- **Routes:** every status code; download headers (type, disposition with non-ASCII filename, nosniff, no-store); cross-user id → 404.
- **Components:** download buttons (POST then navigate), 409 message shown, DocumentsList.
- **E2E (real app):** `next build` + `next start`, generate a resume and pitch export in both formats through the UI against the test DB with a synthetic user (as Phase 7a), download each, and extract its text — this is the check for the `pdfkit` bundling risk.
- Global constraints as in Phase 7a: repo-wide test-user-id grep; migration advisory lock 7420001 in any new DB test harness; prior-phase parity (RLS test, typed errors, DECISIONS/FLOW/architecture/README).

## 9. Risks

- **pdfkit under Next's bundler** (runtime `ENOENT` on its `.afm` data) — mitigated by `serverExternalPackages` + an E2E download; fallback is rendering in a small Node-only helper module outside the bundle.
- **Repo size**: the generated base64 font module is ~1.7 MB of text — accepted for bundler-proof loading.
- **Orphaned objects** after job deletion — known gap until Phase 9 retention.
- **Visual quality** is intentionally plain; ATS readability is the priority.
