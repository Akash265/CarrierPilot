# Phase 7c — Interview Preparation & Cover Letter: Design

Date: 2026-09-29
Status: design approved by user in brainstorming; implemented (see §10 for deviations).
Spec reference: project specification §10 (Application Generation — "Interview preparation", "Optional legacy cover letter mode, but cover letters are secondary rather than the core value proposition"), §12 ("A traditional cover letter can remain an optional secondary feature for applications that explicitly request one"), §19 (`cover letters`, `interview preparations` tables), roadmap Phase 7 (Application Package).
Related decisions: D2 (RLS), D6 (never invent/estimate), D7/D8 (model tier via env var; deterministic before AI), D20 (per-request random delimiter around untrusted text), D44 (`hasUnsafeText` choke point before jsonb), D57 (catch `Anthropic.APIError` distinctly), D58–D68 (Phase 6 evidence catalog, deterministic guard, advisory-locked versioning), D69–D80 (Phase 7a research + pitch), D81–D88 (Phase 7b export). New decisions are numbered from **D89**.

## 1. Scope

Phase 7 was split into 7a (company research + pitch, done), 7b (export + storage, done) and **7c (this document): interview preparation and the optional cover letter**, built together because both are the Phase 7a pitch pattern at a different size — gather evidence → one structured call → deterministic citation guard → locked version insert.

**In scope**
- **Cover letter** per job: 4–5 grounded paragraphs (opening / company / evidence ×1–2 / closing), each checked by a deterministic citation guard. Versioned; manual Regenerate; user edits saved as a new `user_edited` version; PDF/DOCX export via Phase 7b. Presented in the UI as optional ("only if the application asks for one").
- **Interview preparation pack** per job, read-only and versioned (Regenerate = new version), with four sections:
  1. likely questions (technical / behavioral / role) with answer outlines citing the candidate's own profile evidence;
  2. gap / risk questions for required job terms the profile does not cover (computed deterministically), with honest framing that never claims the missing skill;
  3. company talking points cited to company research;
  4. questions to ask the interviewer.
  Copy + PDF/DOCX export.
- **Shared refactor:** extract the pitch pipeline's generic context-gathering and guard rules so pitch, cover letter and interview prep share them (the "extract when the 3rd lands" note from Phase 3).

**Out of scope (deliberate)**
- Mock-interview chat / answer critique; per-question personal notes (a later phase if wanted).
- Editing interview prep packs.
- A new model tier env var (interview prep reuses `ANTHROPIC_MODEL_RESEARCH`).
- Research auto-refresh, a worker/queue, automatic retry loops (same as 7a).
- Associating a sent document with an application (Phase 9).

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Both features in one phase/spec | Split 7c/7d; build only one |
| 2 | Interview prep = likely Qs + answer outlines, gap Qs, company talking points, questions to ask | Subsets of these |
| 3 | Cover letter = grounded paragraphs, versioned, editable, exportable | Expand-the-latest-pitch (requires a pitch first, inherits its limits); no export |
| 4 | Interview prep is a static, read-only, versioned pack | Per-question notes; mock-interview chat |
| 5 | Extend `packages/application-package`; one shared `applyCitationGuard`; two typed tables | A package per feature (duplication); one generic `application_documents` table with jsonb body (weak typing, per-type rules anyway) |
| 6 | Gap terms computed deterministically from `job_requirements` vs. the profile evidence catalog | LLM match explanation `gaps` (only exists for top-N matches; model-written) |
| 7 | Interview prep uses `ANTHROPIC_MODEL_RESEARCH` (Sonnet 5); cover letter uses `ANTHROPIC_MODEL_FAST` | Fast tier for both; a new dedicated tier env var |

Each becomes a DECISIONS.md entry (D89 onward) when implemented.

## 3. Data model

Both new tables: RLS-scoped (`user_id` defaulting to `current_setting('app.current_user_id')::uuid`), RLS isolation test, one row per version, never updated in place, unique index on `(user_id, job_id, version)`, version allocated under `pg_advisory_xact_lock(hashtext('<table>'), hashtext(userId || ':' || jobId))` — the same pattern as `insertPitchVersion`.

Evidence snapshot shape (identical to `application_pitches.bullets[].evidence`): `{ id, kind: "research"|"requirement"|"profile", text, sourceUrl?: string }`. Snapshots keep old versions auditable after a research refresh or profile change.

### `cover_letters`

```
id                        uuid pk
userId                    uuid
jobId                     uuid, FK jobs(id) cascade
version                   integer
origin                    enum cover_letter_origin: generated | user_edited
parentCoverLetterId       uuid, nullable, FK cover_letters(id) set null
companyResearchId         uuid, nullable, FK company_research(id) set null
researchStatusSnapshot    company_research_status enum (reused)
researchedAtSnapshot      timestamptz, nullable
paragraphs                jsonb   -- 4..5 ordered items:
                                  -- { role: "opening"|"company"|"evidence"|"closing",
                                  --   text,                               (<= 1200 chars)
                                  --   supported: true|false|null,         (null = user_edited)
                                  --   unsupportedReason: string|null,
                                  --   evidence: [snapshot] }
requiresReview            boolean
sourceProfileContentHash  text, nullable   -- null for user_edited
generationModel           text, nullable   -- null for user_edited
createdAt                 timestamptz
```

Paragraph order is fixed: `opening`, `company`, `evidence` (1 or 2), `closing`. A `user_edited` version copies research fields and each paragraph's `role` + `evidence` from its parent, sets `supported`/`unsupportedReason` to `null`, `requiresReview = false`. The edit body supplies exactly as many paragraphs as the parent has, in the same order.

### `interview_preparations`

```
id                        uuid pk
userId                    uuid
jobId                     uuid, FK jobs(id) cascade
version                   integer
companyResearchId         uuid, nullable, FK company_research(id) set null
researchStatusSnapshot    company_research_status enum
researchedAtSnapshot      timestamptz, nullable
sections                  jsonb:
  likelyQuestions[]   5..8  { question, category: "technical"|"behavioral"|"role",
                              answerOutline: string[] (1..5),
                              supported, unsupportedReason, evidence }
  gapQuestions[]      0..5  { question, requirementTerm, framing,
                              supported, unsupportedReason, evidence }
  talkingPoints[]     3..6  { text, supported, unsupportedReason, evidence }
  questionsToAsk[]    3..5  { question, supported, unsupportedReason, evidence }
gapTermsSnapshot          jsonb  -- string[]: the deterministic missing required terms given to the model
requiresReview            boolean
sourceProfileContentHash  text
generationModel           text
createdAt                 timestamptz
```

Text caps (Zod): question 300, answer-outline line 300, framing 800, talking point / question-to-ask 400.

### `generated_documents` (Phase 7b table) changes

- `generated_document_kind` enum gains `cover_letter`, `interview_prep`.
- New nullable columns `cover_letter_id` (FK cover_letters set null) and `interview_preparation_id` (FK interview_preparations set null).
- CHECK `generated_documents_source_matches_kind` is rewritten so every source column other than the one matching `kind` is null.
- De-dup key `(user_id, job_id, kind, format, content_hash)` unchanged.

## 4. Pipeline

### 4.1 Shared refactor (first; behavior-preserving)

- `pipeline/prepareApplicationContext.ts` — the generic half of today's `runPitchGeneration`: gates (`no_match` 404 / `not_eligible` 400 / `no_profile` 409, profile check **before** research so no paid search happens without a profile), `ensureCompanyResearch`, `ensureJobRequirements`, `buildEvidenceIndex`. Returns `{ job, snapshot, research, requirements, evidence }`. `Anthropic.APIError` / `JobRequirementExtractionValidationError` → `unknown`.
- `guard/applyCitationGuard.ts` — generic per-item rules, each item flagged (never dropped) with a reason if: a cited ID is not in the evidence index; an ID is repeated within the item; the item lacks a required kind. Required kinds per item are expressed as a list of alternatives, e.g. `[["requirement"], ["profile"]]` = needs ≥1 `q:` AND ≥1 `p:`; `[["research","requirement"]]` = needs ≥1 `r:` OR `q:`; `[]` = no requirement (IDs still validated). Returns items with resolved evidence snapshots.
- `runPitchGeneration` and `applyPitchGuard` are rewritten on top of these; **all existing pitch tests pass unchanged** (the proof the refactor preserved behavior). The pitch guard's tests move/extend to `applyCitationGuard`.

### 4.2 Cover letter

```
POST /api/cover-letters/[jobId]/run
  └─ runCoverLetterGeneration(db, { userId, jobId, anthropicClient, env })
       ctx    = prepareApplicationContext(...)
       draft  = generateCoverLetter(client, env, { jobTitle, companyName, evidence })
                  ANTHROPIC_MODEL_FAST, tool-use structured output, Zod-validated,
                  untrusted evidence inside a D20 delimiter; malformed → CoverLetterGenerationValidationError
       result = applyCitationGuard(evidence, paragraphs, rules):
                  opening → ≥1 q:   company → ≥1 r:   evidence → ≥1 p:   closing → none
       requiresReview = anySupportedFalse || draft.requiresReview
       hasUnsafeText(result) → unknown
       insertCoverLetterVersion (advisory lock)
```

When research is `failed`/`no_results`, only internal `r:` facts exist; the company paragraph cites those (same degradation as the pitch).

### 4.3 Interview preparation

```
POST /api/interview-preps/[jobId]/run
  └─ runInterviewPrepGeneration(db, { userId, jobId, anthropicClient, env })
       ctx      = prepareApplicationContext(...)
       gapTerms = computeGapTerms(ctx.requirements, ctx.snapshot.catalog)      ── pure
       draft    = generateInterviewPrep(client, env, { jobTitle, companyName, evidence, gapTerms })
                    ANTHROPIC_MODEL_RESEARCH, tool-use structured output, Zod-validated, D20 delimiter;
                    malformed → InterviewPrepGenerationValidationError
       result   = applyCitationGuard per section + applyGapRules
                    likelyQuestions → ≥1 q: AND ≥1 p:
                    gapQuestions    → ≥1 q:  (+ gap rules below)
                    talkingPoints   → ≥1 r:
                    questionsToAsk  → ≥1 r: OR q:
       hasUnsafeText(result) → unknown
       insertInterviewPrepVersion (advisory lock), gapTermsSnapshot = gapTerms
```

**`computeGapTerms` (pure):** `required`-level requirement terms (non-blank) whose text is not contained — case-insensitive plain substring, the same rule `scoreKeywordCoverage` uses — in the concatenated text of the profile evidence catalog (`context: text` entries). De-duplicated case-insensitively, stable order (requirement order), capped at 5. Returns `{ term, requirementId }[]`.

**Gap rules (pure, in addition to the citation guard):** a gap question is flagged unsupported if its `requirementTerm` is not one of the supplied gap terms (case-insensitive), if another gap question already used that term, if it does not cite that term's own `q:` ID, or if it cites any `p:` whose snapshot text contains the missing term (that would present the missing skill as held). The model is told it may cite related `p:` facts to show adjacent experience.

## 5. Error handling

| Condition | Result |
|---|---|
| Invalid `jobId` (not a UUID) / no `job_matches` row | 404 |
| Match not eligible | 400 |
| Empty evidence catalog | 409 "Confirm your profile first" |
| Research failed / no results | stored; generation proceeds on internal facts; UI notes it |
| `Anthropic.APIError`, requirement-extraction or generation validation error, unsafe text | 502 "…generation failed. Try again." |
| Cover letter edit body invalid (bad JSON, unknown `baseVersionId`, wrong paragraph count, empty, > 1200 chars, `hasUnsafeText`) | 400 |
| Anything else | rethrown (500) |

No cover letter, interview prep, profile, requirement or research text is logged.

## 6. API

| Route | Behavior |
|---|---|
| `GET /api/cover-letters/[jobId]` | `{ versions: CoverLetterView[] (newest first), research: ResearchView \| null }` |
| `POST /api/cover-letters/[jobId]/run` | new generated version → 201 `{ coverLetter, research }` |
| `POST /api/cover-letters/[jobId]/edit` | body `{ baseVersionId, paragraphs: string[] }` → 201 new `user_edited` version |
| `GET /api/interview-preps/[jobId]` | `{ versions: InterviewPrepView[] (newest first), research: ResearchView \| null }` |
| `POST /api/interview-preps/[jobId]/run` | new version → 201 `{ interviewPrep, research }` |
| `POST /api/documents` (existing) | accepts `kind: "cover_letter" \| "interview_prep"` with the matching source id |

Research refresh stays at `POST /api/application-pitches/[jobId]/research/refresh` (research is per company and shared). Serializers under `apps/web/src/lib/coverLetter/` and `apps/web/src/lib/interviewPrep/` re-validate source URLs as `http(s)` (same as `serializePitch`).

**Export models** (`packages/document-export/src/model/`): `buildCoverLetterModel` (title, contact line, paragraph blocks) and `buildInterviewPrepModel` (heading per section; entries/bullets per item; answer outlines as bullets). Both go through the existing `assertSafeModel` / `normalizeModel` / content-hash path. `DocumentKind` gains the two kinds; export pipelines `exportCoverLetter` / `exportInterviewPrep` mirror `exportPitch`.

## 7. UI

Two new panels on `/matches/[jobId]`, below `PitchPanel`:

- **`CoverLetterPanel`** — note "Optional — use only if the application asks for a cover letter"; Generate / Regenerate; version selector ("v3 · edited"); paragraphs with expandable evidence; review banner naming unsupported paragraphs and why; edit mode (one textarea per paragraph) → Save creates a version; Copy (plain text); `DownloadButtons` for PDF/DOCX; research-unavailable note when applicable.
- **`InterviewPrepPanel`** — Generate / Regenerate; version selector; four collapsible sections; per-item evidence and unsupported flag with reason; gap section headed "Required skills not found in your profile" listing `gapTermsSnapshot` (and "None — every required term appears in your profile" when empty); Copy; `DownloadButtons`; loading text noting it can take up to a minute.
- External links only for `http(s)`, `target="_blank" rel="noopener noreferrer nofollow"`.

## 8. Testing

**Unit (pure):** `applyCitationGuard` (each rule, alternatives, all-good, with the pitch's former guard cases); `computeGapTerms` (case, blanks, dedupe, cap, preferred ignored, empty catalog text); gap rules (each); cover letter + interview prep Zod schemas (counts, order, caps); edit-body validation; `buildCoverLetterModel` / `buildInterviewPrepModel`.

**DB integration (test Postgres, fake Anthropic client):** both pipelines — each error class, research degradation, concurrent runs → versions 1 and 2; cover letter edit versioning; **RLS isolation test for `cover_letters` and `interview_preparations`**; `generated_documents` CHECK for the new kinds; export pipelines de-dup.

**Routes:** every status code in §5/§6. **Components:** both panels' states (empty, generated, requires-review, edited [cover letter], research unavailable, no gap terms, non-http URL not linked, download).

**Evals (manual, real API key, cost money):** `eval:cover-letter-grounding` and `eval:interview-prep-grounding`, ~3 fixtures each (profile + job + research facts): guard-rejection rate, required-kind coverage per item, and for interview prep "no gap framing cites a profile fact containing the missing term". Results recorded in DECISIONS.md.

**Global constraints for the plan:**
- Every new test user ID grepped against the **whole repo** before use.
- Prior-phase parity: RLS isolation test; `Anthropic.APIError` mapped; advisory-locked versions; `hasUnsafeText` before jsonb; D20 delimiter; DECISIONS.md (D89+), FLOW.md (new §11), `docs/architecture.md` (new section + status line), README status.
- After `EnterWorktree`, rebase onto local `main` first.
- Sequence commits in the one worktree (parallel reviews are fine; parallel implementers are not — 7b lesson).
- Real-browser E2E on the test DB with a synthetic user (dev DB is empty), then a second independent whole-branch review before merge.

## 9. Risks

- **Refactor regressions in the pitch:** mitigated by landing the refactor alone first with the unchanged pitch test suite as the gate.
- **Substring gap detection is crude:** a term phrased differently in the profile ("Postgres" vs "PostgreSQL") is reported as a gap. Accepted and shown transparently (the UI lists the terms); the same rule already drives the ATS scorecard. Synonym handling is a later improvement.
- **Interview prep cost/latency:** Sonnet-tier call with a large output, synchronous; up to ~60s. Accepted for a single-user local app, same as 7a.
- **Guard can't judge semantic faithfulness:** it checks citations, not that an answer outline says only what the cited facts say. Mitigated by the evals' reporting and by showing evidence next to each item.

## 10. Post-implementation notes

Implemented on branch `worktree-phase-7c-interview-prep-cover-letter`. Deviations from this design, each recorded in DECISIONS.md:

- **No generic `applyCitationGuard` (§4.1).** The shared piece is `guard/checkCitations.ts` (`checkCitations(lookup, evidenceIds, requirement)` with requirement groups as described); each document keeps a thin guard of its own (`applyPitchGuard`, `applyCoverLetterGuard`, `applyInterviewPrepGuard`). The shared error class is `ApplicationGenerationError`; `PitchGenerationError` is kept as an alias, but `.name` changed (log text only). D89.
- **Gap matching is boundary-aware, not plain substring (§4.3, §9).** `containsTerm` requires no `[a-z0-9]` character immediately before/after the term, so "Go" is not hidden by "Google". The gap list can therefore differ slightly from `scoreKeywordCoverage`. Terms are sorted by term then id (not "requirement order": `job_requirements` has no order column). D92, D95.
- **Gap-rule reachability (§4.3).** "Cites a `p:` whose text contains the missing term" cannot fire with consistent inputs (gap detection and the `p:` snapshots use the same text and matcher); it is defense in depth. The real "claims the skill" risk is measured by the eval heuristic, not enforced. A gap term is reserved only once a question cites that term's own `q:` id; the canonical term spelling is stored. D92.
- **Likely questions may not target gap terms.** A likely question citing a gap term's `q:` id or mentioning a gap term is flagged ("use a gap question"). D96.
- **`role` likely questions** need ≥1 `p:` AND ≥1 (`r:` or `q:`); technical/behavioral keep `q:` AND `p:`. D97.
- **Prompt fixes from the evals.** Gap questions MUST include their `q:` id; talking points "at least 3", restating facts without speculation when research is sparse. D98.
- **Export (§6).** The `generated_documents` CHECK compares `kind::text` (drizzle's migrator runs all migrations in one transaction; Postgres forbids using an enum value added in the same transaction). A generated cover letter with an unsupported paragraph is refused (409 `cover_letter_unsupported`); an interview prep pack always exports, marking unsupported items "(unverified)". D93.
- **Alias limitation confirmed by eval fixture 4.** "Spark" in the profile vs a required "Apache Spark" is reported as a gap; the model may write a supported framing telling the user it is actually a strength. D92, D94.
- **Dev DB not migrated on the branch;** migrations `0022`/`0023` are applied after merge. D99.
- **Eval results:** cover letter 13/13 paragraphs supported, 0 uncited numbers; interview prep 61/63 items supported, gap terms answered 10/10 (supported 10/10). D94.
- **Eval script names (§8).** The scripts are `eval:cover-letter` and `eval:interview-prep` (not `…-grounding`).
- **Final-review fix wave.** Gap detection is uncapped; only the first 5 terms go to the model, the likely-question check and the stored snapshot use all of them (D100). A cover letter whose non-opening paragraph names a missing required term is marked for review (D101). The "framing claims the missing skill" heuristic is enforced by the guard, negation-aware, and shared with the eval (D102) — this reverses "measured, not enforced" above. Re-run evals: cover letter 17/17 over 4 fixtures; interview prep 59/61, 10/10 gap terms, 0 claim flags (D103). Phrase-shaped required terms are a false-gap class like aliases (D92).
