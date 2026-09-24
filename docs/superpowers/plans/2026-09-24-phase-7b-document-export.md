# Phase 7b — Document Export & Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export an optimized resume and a Hiring Manager Pitch as ATS-readable PDF and DOCX files, stored versioned in MinIO and downloadable from the job match page.

**Architecture:** A new package `packages/document-export` builds a format-neutral `DocumentModel` with pure functions (`buildResumeModel`, `buildPitchModel`), renders it with `pdfkit` (PDF, embedded Noto Sans) and `docx` (DOCX), and runs `exportResume`/`exportPitch` pipelines that enforce the two blocking rules, de-duplicate by content hash, upload to a new MinIO bucket and record rows in a new RLS table `generated_documents`. Three synchronous Next.js routes and small UI additions expose it.

**Tech Stack:** TypeScript, Drizzle ORM + PostgreSQL (RLS), MinIO (`minio` client), `pdfkit` 0.20, `docx` 9.7, Zod, Next.js App Router, React, Vitest + Testing Library; `pdf-parse`/`mammoth` via `@ai-career/ai`'s `extractText` for round-trip tests.

**Spec:** `docs/superpowers/specs/2026-09-24-phase-7b-document-export-design.md` — this plan argues from that spec; read both.

## Global Constraints

- RLS on the new table: `user_id uuid NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, `ENABLE ROW LEVEL SECURITY`, `user_isolation` policy (spec §3, D2).
- Documents contain only text already stored in the profile or in the chosen optimization/pitch version; never an LLM call; never `rejectedClaims` (spec §1, §4.2).
- Resume header never includes the street address (spec decision 5).
- Export is blocked with 409 when the profile content hash differs from the optimization's `sourceProfileContentHash`, and when a `generated` pitch has any bullet with `supported === false` (spec decision 6, §4.4).
- MinIO object keys are `{userId}/{uuid}.{pdf|docx}` in bucket `generated-documents`; a user-supplied name never appears in a key (spec §7).
- Every string in a `DocumentModel` passes `hasUnsafeText` (imported only via `@ai-career/ingestion/text`), else `invalid_content` (spec §4.1).
- `RENDERER_VERSION = "1"`; `contentHash = sha256(format + "\n" + RENDERER_VERSION + "\n" + stableStringify(model))`.
- Upload happens outside any DB transaction; an insert that loses the `(user_id, kind, format, content_hash)` race deletes its own upload (spec §4.4).
- Download responses: correct `Content-Type`, `Content-Disposition: attachment` with ASCII `filename` + RFC 5987 `filename*`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` (spec §5).
- No document content in logs.
- **Test user IDs:** the ids below were unused on 2026-09-24 (`…d8 …d9 …da …dc …dd …de …df`); grep the whole repo (`grep -rn "<id>" packages apps services`) before creating each test file.
- **DECISIONS.md numbering:** new entries start at D81; check `grep -o "^### D[0-9]*" DECISIONS.md | tail -1` first.
- **Worktree:** after `EnterWorktree`, run `git rebase main` immediately.
- **Test commands:** Docker services up (`docker compose -f infra/docker-compose.yml up -d`: postgres, redis, minio). Package tests `pnpm --filter <pkg> test`; full suite `pnpm turbo run test --force --env-mode=loose`; in a fresh worktree run `pnpm --filter web build` before `tsc` in apps/web.
- **Every new DB test harness** migrates under `pg_advisory_lock(7420001)` (the flake fixed in Phase 7a R7).
- **Prior-phase parity** (checked in Task 12): RLS isolation test; typed error class mapped to statuses; DECISIONS/FLOW/architecture/README updated.

---

## Task 1: Database — `generated_documents`

**Files:**
- Create: `packages/db/src/schema/generatedDocuments.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/package.json` (one script)
- Create: `packages/db/migrations/0019_<drizzle-generated-name>.sql` (generated)
- Create: `packages/db/migrations/0020_generated_documents_rls.sql` (custom)
- Create: `packages/db/src/generatedDocumentsTable.rls.test.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Produces: `schema.generatedDocuments`, `generatedDocumentKindEnum` (`"resume"|"pitch"`), `generatedDocumentFormatEnum` (`"pdf"|"docx"`). TS column names: `id, userId, jobId, kind, format, resumeOptimizationId, applicationPitchId, objectKey, byteSize, contentHash, rendererVersion, downloadFilename, createdAt`.

- [ ] **Step 1: Create `packages/db/src/schema/generatedDocuments.ts`**

```typescript
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, integer, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { resumeOptimizations } from "./resumeOptimizations";
import { applicationPitches } from "./applicationPitches";

export const generatedDocumentKindEnum = pgEnum("generated_document_kind", ["resume", "pitch"]);
export const generatedDocumentFormatEnum = pgEnum("generated_document_format", ["pdf", "docx"]);

/**
 * One stored, rendered file (Phase 7b design §3). The file itself lives in MinIO bucket
 * "generated-documents" under objectKey = "{userId}/{uuid}.{ext}" -- never a user-supplied name.
 * contentHash = sha256(format, RENDERER_VERSION, stable JSON of the DocumentModel); the unique index on
 * (user_id, kind, format, content_hash) de-duplicates identical exports and is the concurrency backstop.
 * The source column that does not match `kind` is always null; the matching one may later become null
 * through ON DELETE SET NULL, so it is not required non-null here (the pipeline always sets it).
 * Known gap: deleting a job cascades these rows but not their MinIO objects (Phase 9 retention sweeps them).
 */
export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: generatedDocumentKindEnum("kind").notNull(),
    format: generatedDocumentFormatEnum("format").notNull(),
    resumeOptimizationId: uuid("resume_optimization_id").references(() => resumeOptimizations.id, { onDelete: "set null" }),
    applicationPitchId: uuid("application_pitch_id").references(() => applicationPitches.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    downloadFilename: text("download_filename").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userKindFormatHashUniq: uniqueIndex("generated_documents_user_kind_format_hash_uniq").on(t.userId, t.kind, t.format, t.contentHash),
    jobIdIdx: index("generated_documents_job_id_idx").on(t.jobId),
    byteSizePositive: check("generated_documents_byte_size_positive", sql`${t.byteSize} > 0`),
    sourceMatchesKind: check(
      "generated_documents_source_matches_kind",
      sql`(${t.kind} = 'resume' AND ${t.applicationPitchId} IS NULL) OR (${t.kind} = 'pitch' AND ${t.resumeOptimizationId} IS NULL)`
    ),
  })
);
```

- [ ] **Step 2: Export it** — append `export * from "./generatedDocuments";` to `packages/db/src/schema/index.ts`.

- [ ] **Step 3: Generate the table migration**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: `packages/db/migrations/0019_<random>.sql` creating the two enums, the table, its three FKs, the unique index, the job_id index and the two CHECKs — and touching no other table. Open it and confirm; do not rename it.

- [ ] **Step 4: RLS migration**

In `packages/db/package.json` scripts, below `"db:generate:custom:application-package-rls": …,` add:

```json
    "db:generate:custom:generated-documents-rls": "dotenv -e ../../.env -- drizzle-kit generate --custom --name=generated_documents_rls",
```

Run: `pnpm --filter @ai-career/db db:generate:custom:generated-documents-rls` and replace the empty `0020_generated_documents_rls.sql` with:

```sql
-- Custom SQL migration: RLS for generated_documents. Follows 0018_application_package_rls.sql.

ALTER TABLE generated_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON generated_documents
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

(Trailing newline.)

- [ ] **Step 5: Write the RLS test**

Users `…d8` / `…d9` (grep first). `packages/db/src/generatedDocumentsTable.rls.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-0000000000d8";
const USER_B = "00000000-0000-0000-0000-0000000000d9";
const MIGRATION_LOCK = 7420001;

async function wipe() {
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`; // cascades generated_documents
}

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

async function seedJob(): Promise<string> {
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  return job.id as string;
}

function insertDoc(jobId: string, overrides: Record<string, unknown> = {}) {
  const v = { kind: "resume", format: "pdf", byteSize: 10, contentHash: "h1", ...overrides };
  return adminSql`
    INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
    VALUES (${USER_A}, ${jobId}, ${v.kind as string}, ${v.format as string}, 'k', ${v.byteSize as number}, ${v.contentHash as string}, '1', 'f.pdf')
    RETURNING id`;
}

describe("generated_documents — RLS and constraints", () => {
  it("isolates rows by user_id, including lookups by a known id", async () => {
    await wipe();
    const jobId = await seedJob();
    const [doc] = await insertDoc(jobId);
    const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM generated_documents`));
    const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM generated_documents WHERE id = ${doc.id}`));
    expect(asA).toHaveLength(1);
    expect(asB).toHaveLength(0);
  });

  it("de-duplicates on (user, kind, format, content_hash)", async () => {
    await wipe();
    const jobId = await seedJob();
    await insertDoc(jobId);
    await expect(insertDoc(jobId)).rejects.toThrow(/generated_documents_user_kind_format_hash_uniq/);
    await expect(insertDoc(jobId, { format: "docx" })).resolves.toHaveLength(1);
  });

  it("rejects a zero byte size", async () => {
    await wipe();
    const jobId = await seedJob();
    await expect(insertDoc(jobId, { byteSize: 0, contentHash: "h2" })).rejects.toThrow(/generated_documents_byte_size_positive/);
  });

  it("rejects a resume row that points at a pitch", async () => {
    await wipe();
    const jobId = await seedJob();
    const [pitch] = await adminSql`
      INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review)
      VALUES (${USER_A}, ${jobId}, 1, 'user_edited', 'failed',
              '[{"kind":"company","text":"a","supported":null,"unsupportedReason":null,"evidence":[]},{"kind":"role","text":"b","supported":null,"unsupportedReason":null,"evidence":[]},{"kind":"candidate","text":"c","supported":null,"unsupportedReason":null,"evidence":[]}]'::jsonb,
              false) RETURNING id`;
    await expect(adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, application_pitch_id, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${USER_A}, ${jobId}, 'resume', 'pdf', ${pitch.id}, 'k', 10, 'h3', '1', 'f.pdf')`).rejects.toThrow(/generated_documents_source_matches_kind/);
  });
});
```

- [ ] **Step 6: Run**

Run: `pnpm --filter @ai-career/db test -- generatedDocumentsTable && pnpm --filter @ai-career/db db:migrate && pnpm --filter @ai-career/db test && pnpm --filter @ai-career/db typecheck`
Expected: PASS (4 new tests), dev DB migrated.

- [ ] **Step 7: DECISIONS.md (expected D81)**

```markdown
### D81. Generated documents are stored rows + MinIO objects, de-duplicated by a content hash of the rendered model
**Decision:** New RLS table `generated_documents` (`kind` resume|pitch, `format` pdf|docx, the source optimization or pitch id — the non-matching one CHECK-constrained null — `object_key`, `byte_size > 0`, `content_hash`, `renderer_version`, `download_filename`). Unique `(user_id, kind, format, content_hash)` de-duplicates identical exports and backstops concurrent ones. Files live in a private MinIO bucket `generated-documents` under generated keys `{userId}/{uuid}.{ext}`.
**Why:** Phase 9 needs an exact record of the file actually sent (spec decision 2). Hashing the format-neutral model (not the PDF bytes, which embed timestamps) makes "same inputs → same stored file" deterministic.
**Alternatives considered:** Render on demand with no storage (rejected, spec decision 2); hashing output bytes (rejected: non-deterministic PDF metadata).
**Known gap:** deleting a job cascades rows but leaves MinIO objects — the Phase 9 retention job must sweep them.
**What it affects:** `packages/db/src/schema/generatedDocuments.ts`, migrations `0019_*`, `0020_generated_documents_rls.sql`.
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema packages/db/migrations packages/db/package.json packages/db/src/generatedDocumentsTable.rls.test.ts DECISIONS.md
git commit -m "feat(db): add generated_documents with RLS and de-dup index"
```

---

## Task 2: Storage — `generated-documents` bucket

**Files:**
- Create: `packages/storage/src/generatedDocumentStorage.ts`
- Create: `packages/storage/src/generatedDocumentStorage.test.ts`
- Modify: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `GENERATED_DOCUMENTS_BUCKET = "generated-documents"`; `uploadGeneratedDocument(client: Client, params: { userId: string; buffer: Buffer; extension: "pdf" | "docx" }): Promise<{ objectKey: string }>`; `getGeneratedDocument(client: Client, objectKey: string): Promise<Readable>`; `deleteGeneratedDocument(client: Client, objectKey: string): Promise<void>`.

- [ ] **Step 1: Write the failing test** — `packages/storage/src/generatedDocumentStorage.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import type { Readable } from "node:stream";
import { createStorageClient } from "./client";
import {
  uploadGeneratedDocument, getGeneratedDocument, deleteGeneratedDocument, GENERATED_DOCUMENTS_BUCKET,
} from "./generatedDocumentStorage";

const client = createStorageClient({
  MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
  MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
  MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
});
const created: string[] = [];

afterAll(async () => {
  for (const key of created) await deleteGeneratedDocument(client, key).catch(() => {});
});

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("generated document storage", () => {
  it("uploads under {userId}/{uuid}.{ext}, reads back the same bytes, then deletes", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const buffer = Buffer.from("%PDF-1.7 generated");
    const { objectKey } = await uploadGeneratedDocument(client, { userId, buffer, extension: "pdf" });
    created.push(objectKey);

    expect(objectKey).toMatch(new RegExp(`^${userId}/[0-9a-f-]{36}\\.pdf$`));
    expect((await readAll(await getGeneratedDocument(client, objectKey))).equals(buffer)).toBe(true);

    await deleteGeneratedDocument(client, objectKey);
    await expect(client.statObject(GENERATED_DOCUMENTS_BUCKET, objectKey)).rejects.toThrow();
  });

  it("uses a distinct key for every upload", async () => {
    const params = { userId: "00000000-0000-0000-0000-000000000001", buffer: Buffer.from("x"), extension: "docx" as const };
    const a = await uploadGeneratedDocument(client, params);
    const b = await uploadGeneratedDocument(client, params);
    created.push(a.objectKey, b.objectKey);
    expect(a.objectKey).not.toBe(b.objectKey);
    expect(a.objectKey.endsWith(".docx")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @ai-career/storage test -- generatedDocumentStorage` → FAIL (module not found).

- [ ] **Step 3: Implement `packages/storage/src/generatedDocumentStorage.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { Client } from "minio";

export const GENERATED_DOCUMENTS_BUCKET = "generated-documents";

async function ensureBucketExists(client: Client): Promise<void> {
  const exists = await client.bucketExists(GENERATED_DOCUMENTS_BUCKET).catch(() => false);
  if (!exists) await client.makeBucket(GENERATED_DOCUMENTS_BUCKET);
}

/** Keys are generated here and never contain user-supplied text (Phase 7b design §7). */
export async function uploadGeneratedDocument(
  client: Client,
  params: { userId: string; buffer: Buffer; extension: "pdf" | "docx" }
): Promise<{ objectKey: string }> {
  await ensureBucketExists(client);
  const objectKey = `${params.userId}/${randomUUID()}.${params.extension}`;
  await client.putObject(GENERATED_DOCUMENTS_BUCKET, objectKey, params.buffer, params.buffer.length);
  return { objectKey };
}

export async function getGeneratedDocument(client: Client, objectKey: string): Promise<Readable> {
  return client.getObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}

export async function deleteGeneratedDocument(client: Client, objectKey: string): Promise<void> {
  await client.removeObject(GENERATED_DOCUMENTS_BUCKET, objectKey);
}
```

- [ ] **Step 4: Export** — `packages/storage/src/index.ts` becomes:

```typescript
export { createStorageClient } from "./client";
export { uploadResume, deleteResume, RESUME_BUCKET } from "./resumeStorage";
export {
  uploadGeneratedDocument, getGeneratedDocument, deleteGeneratedDocument, GENERATED_DOCUMENTS_BUCKET,
} from "./generatedDocumentStorage";
```

- [ ] **Step 5: Run** — `pnpm --filter @ai-career/storage test && pnpm --filter @ai-career/storage typecheck && pnpm --filter @ai-career/storage lint` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src
git commit -m "feat(storage): generated-documents bucket upload/get/delete"
```

---

## Task 3: Package scaffold, `DocumentModel`, hashing, filename sanitizer, safety check

**Files:**
- Create: `packages/document-export/{package.json,tsconfig.json,vitest.config.ts,eslint.config.mjs}`
- Create: `packages/document-export/src/model/types.ts`
- Create: `packages/document-export/src/model/hash.ts` + `hash.test.ts`
- Create: `packages/document-export/src/model/filename.ts` + `filename.test.ts`
- Create: `packages/document-export/src/model/assertSafeModel.ts` + `assertSafeModel.test.ts`
- Create: `packages/document-export/src/errors.ts`
- Create: `packages/document-export/src/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces:
  - `types.ts`: `type DocumentBlock = { type: "heading"; text: string } | { type: "entry"; title: string; subtitle: string | null; meta: string | null } | { type: "paragraph"; text: string } | { type: "bullets"; items: string[] }`; `interface DocumentModel { title: string; contactLine: string | null; blocks: DocumentBlock[] }`; `type DocumentFormat = "pdf" | "docx"`; `type DocumentKind = "resume" | "pitch"`; `const RENDERER_VERSION = "1"`.
  - `hash.ts`: `stableStringify(value: unknown): string`; `modelContentHash(model: DocumentModel, format: DocumentFormat): string`.
  - `filename.ts`: `sanitizeFilename(base: string, extension: DocumentFormat): string`; `buildDownloadFilename(fullName: string, companyName: string, kind: DocumentKind, format: DocumentFormat): string`.
  - `assertSafeModel.ts`: `assertSafeModel(model: DocumentModel): void` (throws `DocumentExportError("invalid_content")`).
  - `errors.ts`: `type DocumentExportErrorClass = "job_not_found" | "source_mismatch" | "profile_changed" | "pitch_unsupported" | "no_profile" | "invalid_content" | "storage_unavailable"`; `class DocumentExportError extends Error { readonly errorClass }`.

- [ ] **Step 1: Scaffold**

`packages/document-export/package.json`:

```json
{
  "name": "@ai-career/document-export",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src scripts",
    "embed-fonts": "node scripts/embed-fonts.mjs"
  },
  "dependencies": {
    "@ai-career/application-package": "workspace:*",
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@ai-career/ingestion": "workspace:*",
    "@ai-career/resume-optimization": "workspace:*",
    "@ai-career/storage": "workspace:*",
    "docx": "^9.7.2",
    "drizzle-orm": "^0.36.0",
    "minio": "^8.0.2",
    "pdfkit": "^0.20.2",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@ai-career/ai": "workspace:*",
    "@expo-google-fonts/noto-sans": "0.4.2",
    "@types/node": "^22.10.0",
    "@types/pdfkit": "^0.17.6",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

(Match every shared devDependency version string to `packages/application-package/package.json` exactly. `@expo-google-fonts/noto-sans` is pinned exactly — it is the font source for Task 4.)

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pipeline tests (Task 9+) migrate the shared test database and use shared MinIO.
    fileParallelism: false,
  },
});
```

`eslint.config.mjs`:

```javascript
import baseConfig from "../../eslint.config.base.mjs";

export default [...baseConfig, { ignores: ["src/render/fonts.generated.ts"] }];
```

Run `pnpm install`. (The `./testing` export target is created in Task 9; `scripts/` in Task 4.)

- [ ] **Step 2: `src/model/types.ts`**

```typescript
/** Format-neutral document (Phase 7b design §4.1); both renderers consume only this. */
export type DocumentBlock =
  | { type: "heading"; text: string }
  | { type: "entry"; title: string; subtitle: string | null; meta: string | null }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] };

export interface DocumentModel {
  title: string;
  contactLine: string | null;
  blocks: DocumentBlock[];
}

export type DocumentFormat = "pdf" | "docx";
export type DocumentKind = "resume" | "pitch";

/** Bump whenever either renderer's output for the same model changes (it is part of the content hash). */
export const RENDERER_VERSION = "1";
```

- [ ] **Step 3: `src/errors.ts`**

```typescript
export type DocumentExportErrorClass =
  | "job_not_found"
  | "source_mismatch"
  | "profile_changed"
  | "pitch_unsupported"
  | "no_profile"
  | "invalid_content"
  | "storage_unavailable";

export class DocumentExportError extends Error {
  readonly errorClass: DocumentExportErrorClass;
  constructor(errorClass: DocumentExportErrorClass) {
    super(errorClass);
    this.name = "DocumentExportError";
    this.errorClass = errorClass;
  }
}
```

- [ ] **Step 4: Failing tests for hash, filename, safety**

`src/model/hash.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { stableStringify, modelContentHash } from "./hash";
import type { DocumentModel } from "./types";

const model: DocumentModel = { title: "Jane", contactLine: "a@b.c", blocks: [{ type: "paragraph", text: "Hi" }] };

describe("stableStringify", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: 2 } })).toBe('{"a":{"c":2,"d":[3,1]},"b":1}');
  });
});

describe("modelContentHash", () => {
  it("is stable for equal models regardless of key order", () => {
    const reordered = { blocks: model.blocks, contactLine: model.contactLine, title: model.title };
    expect(modelContentHash(reordered, "pdf")).toBe(modelContentHash(model, "pdf"));
  });

  it("differs by format and by content", () => {
    expect(modelContentHash(model, "pdf")).not.toBe(modelContentHash(model, "docx"));
    expect(modelContentHash({ ...model, title: "Janet" }, "pdf")).not.toBe(modelContentHash(model, "pdf"));
  });

  it("is a 64-char hex sha256", () => {
    expect(modelContentHash(model, "pdf")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

`src/model/filename.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { sanitizeFilename, buildDownloadFilename } from "./filename";

describe("sanitizeFilename", () => {
  it("strips diacritics and unsafe characters and appends the extension", () => {
    expect(sanitizeFilename('José Núñez / "Acme" <GmbH>', "pdf")).toBe("Jose Nunez Acme GmbH.pdf");
  });

  it("removes control characters and collapses whitespace", () => {
    expect(sanitizeFilename("a\u0000\nb\t  c", "docx")).toBe("a b c.docx");
  });

  it("caps the base at 120 characters", () => {
    expect(sanitizeFilename("x".repeat(300), "pdf")).toBe("x".repeat(120) + ".pdf");
  });

  it("falls back to 'document' when nothing safe remains", () => {
    expect(sanitizeFilename("/// ***", "pdf")).toBe("document.pdf");
  });
});

describe("buildDownloadFilename", () => {
  it("formats name - company - kind", () => {
    expect(buildDownloadFilename("Jane Doe", "GitLab", "resume", "pdf")).toBe("Jane Doe - GitLab - Resume.pdf");
    expect(buildDownloadFilename("Jane Doe", "GitLab", "pitch", "docx")).toBe("Jane Doe - GitLab - Pitch.docx");
  });
});
```

`src/model/assertSafeModel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { assertSafeModel } from "./assertSafeModel";
import { DocumentExportError } from "../errors";

describe("assertSafeModel", () => {
  it("accepts a clean model", () => {
    expect(() => assertSafeModel({ title: "Jane", contactLine: null, blocks: [{ type: "bullets", items: ["ok"] }] })).not.toThrow();
  });

  it.each([
    ["title", { title: "Ja\u0000ne", contactLine: null, blocks: [] }],
    ["contact line", { title: "Jane", contactLine: "\uD800", blocks: [] }],
    ["a bullet", { title: "Jane", contactLine: null, blocks: [{ type: "bullets", items: ["ok", "bad\u0000"] }] }],
  ])("rejects unsafe text in %s with invalid_content", (_label, model) => {
    expect(() => assertSafeModel(model as never)).toThrow(DocumentExportError);
    try {
      assertSafeModel(model as never);
    } catch (error) {
      expect((error as DocumentExportError).errorClass).toBe("invalid_content");
    }
  });
});
```

Run: `pnpm --filter @ai-career/document-export test` → FAIL (modules not found).

- [ ] **Step 5: Implement**

`src/model/hash.ts`:

```typescript
import { createHash } from "node:crypto";
import { RENDERER_VERSION, type DocumentFormat, type DocumentModel } from "./types";

/** JSON with object keys sorted recursively; arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of what the document says, not of the rendered bytes (PDF output embeds timestamps). */
export function modelContentHash(model: DocumentModel, format: DocumentFormat): string {
  return createHash("sha256").update(`${format}\n${RENDERER_VERSION}\n${stableStringify(model)}`).digest("hex");
}
```

`src/model/filename.ts`:

```typescript
import type { DocumentFormat, DocumentKind } from "./types";

const MAX_BASE = 120;

/** ASCII-only, filesystem- and header-safe download name (the real key in storage is generated). */
export function sanitizeFilename(base: string, extension: DocumentFormat): string {
  const cleaned = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .,_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BASE)
    .trim();
  const safe = cleaned.replace(/^[.\s]+/, "");
  return `${safe.length > 0 ? safe : "document"}.${extension}`;
}

export function buildDownloadFilename(fullName: string, companyName: string, kind: DocumentKind, format: DocumentFormat): string {
  return sanitizeFilename(`${fullName} - ${companyName} - ${kind === "resume" ? "Resume" : "Pitch"}`, format);
}
```

`src/model/assertSafeModel.ts`:

```typescript
import { hasUnsafeText } from "@ai-career/ingestion/text";
import { DocumentExportError } from "../errors";
import type { DocumentModel } from "./types";

/** D44 choke point for documents: one recursive check over every string in the model. */
export function assertSafeModel(model: DocumentModel): void {
  if (hasUnsafeText(model)) throw new DocumentExportError("invalid_content");
}
```

`src/index.ts`:

```typescript
export * from "./model/types";
export * from "./errors";
export { stableStringify, modelContentHash } from "./model/hash";
export { sanitizeFilename, buildDownloadFilename } from "./model/filename";
export { assertSafeModel } from "./model/assertSafeModel";
```

- [ ] **Step 6: Run** — `pnpm --filter @ai-career/document-export test && pnpm --filter @ai-career/document-export typecheck` → PASS (lint runs in Task 4 once `scripts/` exists; run `npx eslint src` now from the package dir to check `src`).

- [ ] **Step 7: Commit**

```bash
git add packages/document-export pnpm-lock.yaml
git commit -m "feat(document-export): scaffold package, document model, hashing and filenames"
```

---
## Task 4: Embedded Noto Sans fonts

**Files:**
- Create: `packages/document-export/scripts/embed-fonts.mjs`
- Create (generated, committed): `packages/document-export/src/render/fonts.generated.ts`
- Create (copied, committed): `packages/document-export/assets/OFL.txt`
- Create: `packages/document-export/src/render/fonts.test.ts`

**Interfaces:**
- Produces: `NOTO_SANS_REGULAR_BASE64: string`, `NOTO_SANS_BOLD_BASE64: string` from `src/render/fonts.generated.ts`.

- [ ] **Step 1: Write the failing test** — `src/render/fonts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { NOTO_SANS_REGULAR_BASE64, NOTO_SANS_BOLD_BASE64 } from "./fonts.generated";

// A TrueType font starts with the sfnt version 0x00010000.
const isTrueType = (base64: string) => Buffer.from(base64, "base64").subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));

describe("embedded fonts", () => {
  it("contains Noto Sans Regular and Bold as TrueType data", () => {
    expect(isTrueType(NOTO_SANS_REGULAR_BASE64)).toBe(true);
    expect(isTrueType(NOTO_SANS_BOLD_BASE64)).toBe(true);
    expect(Buffer.from(NOTO_SANS_REGULAR_BASE64, "base64").length).toBeGreaterThan(100_000);
    expect(NOTO_SANS_REGULAR_BASE64).not.toBe(NOTO_SANS_BOLD_BASE64);
  });
});
```

Run `pnpm --filter @ai-career/document-export test -- fonts` → FAIL (module not found).

- [ ] **Step 2: Create `scripts/embed-fonts.mjs`**

```javascript
// Regenerates src/render/fonts.generated.ts and assets/OFL.txt from the pinned devDependency
// @expo-google-fonts/noto-sans. Fonts are embedded as base64 so rendering never touches the
// filesystem at runtime (works under any bundler). Run: pnpm --filter @ai-career/document-export embed-fonts
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontDir = path.join(packageDir, "node_modules", "@expo-google-fonts", "noto-sans");

const regular = readFileSync(path.join(fontDir, "400Regular", "NotoSans_400Regular.ttf")).toString("base64");
const bold = readFileSync(path.join(fontDir, "700Bold", "NotoSans_700Bold.ttf")).toString("base64");

const header =
  "// GENERATED by scripts/embed-fonts.mjs -- do not edit. Noto Sans (Regular, Bold), SIL Open Font License 1.1\n" +
  "// (see assets/OFL.txt), from @expo-google-fonts/noto-sans@0.4.2.\n";
writeFileSync(
  path.join(packageDir, "src", "render", "fonts.generated.ts"),
  `${header}export const NOTO_SANS_REGULAR_BASE64 =\n  "${regular}";\nexport const NOTO_SANS_BOLD_BASE64 =\n  "${bold}";\n`
);

mkdirSync(path.join(packageDir, "assets"), { recursive: true });
copyFileSync(path.join(fontDir, "LICENSE_FONT"), path.join(packageDir, "assets", "OFL.txt"));
console.log("wrote src/render/fonts.generated.ts and assets/OFL.txt");
```

- [ ] **Step 3: Generate**

Run: `mkdir -p packages/document-export/src/render && pnpm --filter @ai-career/document-export embed-fonts`
Expected: prints the "wrote …" line; `src/render/fonts.generated.ts` is ~1.7 MB; `assets/OFL.txt` begins "Copyright 2022 The Noto Project Authors".

- [ ] **Step 4: Run** — `pnpm --filter @ai-career/document-export test -- fonts && pnpm --filter @ai-career/document-export typecheck && pnpm --filter @ai-career/document-export lint` → PASS (lint ignores the generated file).

- [ ] **Step 5: Commit**

```bash
git add packages/document-export/scripts packages/document-export/src/render packages/document-export/assets
git commit -m "feat(document-export): embed Noto Sans (OFL) for Unicode PDF output"
```

---

## Task 5: `buildResumeModel` — the merge rules

**Files:**
- Create: `packages/document-export/src/model/resumeProfile.ts`
- Create: `packages/document-export/src/model/buildResumeModel.ts`
- Create: `packages/document-export/src/model/buildResumeModel.test.ts`
- Modify: `packages/document-export/src/index.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `AppliedBullet` from `@ai-career/resume-optimization` (`{ sourceFactId, sourceType, originalText, optimizedText, changeType, justification }`); `DocumentModel` (Task 3).
- Produces:
  - `resumeProfile.ts`: `interface ResumeContact { fullName: string; email: string; phoneNumber: string | null; linkedinUrl: string | null }`; `interface ResumeProfile { contact: ResumeContact; experiences: { id: string; company: string; title: string; location: string | null; startDate: string | null; endDate: string | null; bullets: { id: string; text: string }[] }[]; achievements: { id: string; description: string }[]; projects: { id: string; name: string; description: string; url: string | null }[]; certifications: { id: string; name: string; issuer: string; issueDate: string | null; expiryDate: string | null }[]; education: { id: string; institution: string; degree: string; fieldOfStudy: string | null; startDate: string | null; endDate: string | null; gpa: string | null }[]; skills: { id: string; name: string }[] }` (every array already in `display_order`); `contactLine(contact: ResumeContact): string | null`; `dateRange(start: string | null, end: string | null): string | null`.
  - `buildResumeModel(profile: ResumeProfile, applied: AppliedBullet[]): DocumentModel`.

- [ ] **Step 1: Write the failing tests** — `src/model/buildResumeModel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { AppliedBullet } from "@ai-career/resume-optimization";
import { buildResumeModel } from "./buildResumeModel";
import { contactLine, dateRange, type ResumeProfile } from "./resumeProfile";

const profile: ResumeProfile = {
  contact: { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 1", linkedinUrl: "https://linkedin.com/in/jane" },
  experiences: [
    { id: "e1", company: "Globex", title: "Engineer", location: "Berlin", startDate: "2021", endDate: null,
      bullets: [{ id: "b1", text: "Built A" }, { id: "b2", text: "Built B" }, { id: "b3", text: "Built C" }] },
    { id: "e2", company: "Initech", title: "Intern", location: null, startDate: null, endDate: null,
      bullets: [{ id: "b4", text: "Helped D" }] },
  ],
  achievements: [{ id: "a1", description: "Award X" }, { id: "a2", description: "Award Y" }],
  projects: [
    { id: "p1", name: "Proj One", description: "First project", url: null },
    { id: "p2", name: "Proj Two", description: "Second project", url: "https://two.example" },
  ],
  certifications: [{ id: "c1", name: "AWS SA", issuer: "Amazon", issueDate: "2022", expiryDate: "2025" }],
  education: [{ id: "d1", institution: "TU Berlin", degree: "BSc", fieldOfStudy: "CS", startDate: "2016", endDate: "2020", gpa: null }],
  skills: [{ id: "s1", name: "Python" }, { id: "s2", name: "SQL" }, { id: "s3", name: "Go" }],
};

const applied = (sourceFactId: string, sourceType: AppliedBullet["sourceType"], optimizedText: string): AppliedBullet => ({
  sourceFactId, sourceType, optimizedText, originalText: "orig", changeType: "reworded", justification: "j",
});

const blocksAfter = (model: ReturnType<typeof buildResumeModel>, heading: string) => {
  const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === heading);
  return i === -1 ? null : model.blocks.slice(i + 1);
};

describe("contactLine / dateRange", () => {
  it("joins only non-empty contact parts, never an address", () => {
    expect(contactLine(profile.contact)).toBe("jane@example.com · +49 1 · https://linkedin.com/in/jane");
    expect(contactLine({ fullName: "J", email: "j@x.y", phoneNumber: null, linkedinUrl: "" })).toBe("j@x.y");
  });

  it("formats date ranges", () => {
    expect(dateRange("2021", null)).toBe("2021 – present");
    expect(dateRange("2016", "2020")).toBe("2016 – 2020");
    expect(dateRange(null, "2020")).toBe("2020");
    expect(dateRange(null, null)).toBeNull();
  });
});

describe("buildResumeModel", () => {
  it("uses the full name as title and the contact line", () => {
    const model = buildResumeModel(profile, []);
    expect(model.title).toBe("Jane Doe");
    expect(model.contactLine).toBe("jane@example.com · +49 1 · https://linkedin.com/in/jane");
  });

  it("puts a role's optimized bullets first in optimizer order, then its untouched bullets in profile order", () => {
    const model = buildResumeModel(profile, [
      applied("b3", "work_experience_bullet", "Built C faster"),
      applied("b1", "work_experience_bullet", "Built A with SQL"),
    ]);
    const exp = blocksAfter(model, "Experience")!;
    expect(exp[0]).toEqual({ type: "entry", title: "Engineer", subtitle: "Globex · Berlin", meta: "2021 – present" });
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built C faster", "Built A with SQL", "Built B"] });
    expect(exp[2]).toEqual({ type: "entry", title: "Intern", subtitle: "Initech", meta: null });
    expect(exp[3]).toEqual({ type: "bullets", items: ["Helped D"] });
  });

  it("with no optimization keeps every bullet in original wording and order", () => {
    const exp = blocksAfter(buildResumeModel(profile, []), "Experience")!;
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built A", "Built B", "Built C"] });
  });

  it("orders projects selected-first with optimized descriptions, then the rest verbatim", () => {
    const proj = blocksAfter(buildResumeModel(profile, [applied("p2", "project", "Second project, in Go")]), "Projects")!;
    expect(proj.slice(0, 4)).toEqual([
      { type: "entry", title: "Proj Two", subtitle: "https://two.example", meta: null },
      { type: "paragraph", text: "Second project, in Go" },
      { type: "entry", title: "Proj One", subtitle: null, meta: null },
      { type: "paragraph", text: "First project" },
    ]);
  });

  it("orders achievements selected-first with optimized text", () => {
    const ach = blocksAfter(buildResumeModel(profile, [applied("a2", "achievement", "Award Y (top 1%)")]), "Achievements")!;
    expect(ach[0]).toEqual({ type: "bullets", items: ["Award Y (top 1%)", "Award X"] });
  });

  it("keeps education and certifications verbatim even when the optimizer selected them", () => {
    const model = buildResumeModel(profile, [applied("d1", "education", "REWORDED"), applied("c1", "certification", "REWORDED")]);
    expect(blocksAfter(model, "Education")![0]).toEqual({ type: "entry", title: "BSc in CS", subtitle: "TU Berlin", meta: "2016 – 2020" });
    expect(blocksAfter(model, "Certifications")![0]).toEqual({ type: "entry", title: "AWS SA", subtitle: "Amazon", meta: "2022 – 2025" });
    expect(JSON.stringify(model)).not.toContain("REWORDED");
  });

  it("orders skills selected-first using profile names, never optimizedText", () => {
    const model = buildResumeModel(profile, [applied("s3", "skill", "Golang (expert)"), applied("s2", "skill", "SQL!!")]);
    expect(blocksAfter(model, "Skills")![0]).toEqual({ type: "paragraph", text: "Go, SQL, Python" });
  });

  it("adds a GPA to the education subtitle when present", () => {
    const model = buildResumeModel({ ...profile, education: [{ ...profile.education[0], gpa: "3.8" }] }, []);
    expect(blocksAfter(model, "Education")![0]).toMatchObject({ subtitle: "TU Berlin · GPA 3.8" });
  });

  it("omits empty sections and orders sections Experience, Projects, Achievements, Education, Certifications, Skills", () => {
    const model = buildResumeModel({ ...profile, achievements: [], certifications: [] }, []);
    const headings = model.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(["Experience", "Projects", "Education", "Skills"]);
  });

  it("throws when an applied bullet cites a fact that is not in the profile (a bug, not a user error)", () => {
    expect(() => buildResumeModel(profile, [applied("ghost", "work_experience_bullet", "x")])).toThrow(/ghost/);
  });
});
```

Run `pnpm --filter @ai-career/document-export test -- buildResumeModel` → FAIL (modules not found).

- [ ] **Step 2: Implement `src/model/resumeProfile.ts`**

```typescript
export interface ResumeContact {
  fullName: string;
  email: string;
  phoneNumber: string | null;
  linkedinUrl: string | null;
}

/** Everything a resume document may contain, each list already in display_order. No street address by design (D82). */
export interface ResumeProfile {
  contact: ResumeContact;
  experiences: {
    id: string;
    company: string;
    title: string;
    location: string | null;
    startDate: string | null;
    endDate: string | null;
    bullets: { id: string; text: string }[];
  }[];
  achievements: { id: string; description: string }[];
  projects: { id: string; name: string; description: string; url: string | null }[];
  certifications: { id: string; name: string; issuer: string; issueDate: string | null; expiryDate: string | null }[];
  education: {
    id: string;
    institution: string;
    degree: string;
    fieldOfStudy: string | null;
    startDate: string | null;
    endDate: string | null;
    gpa: string | null;
  }[];
  skills: { id: string; name: string }[];
}

const present = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

export function contactLine(contact: ResumeContact): string | null {
  const parts = [contact.email, contact.phoneNumber, contact.linkedinUrl].filter(present);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function dateRange(start: string | null, end: string | null): string | null {
  if (present(start) && present(end)) return `${start} – ${end}`;
  if (present(start)) return `${start} – present`;
  if (present(end)) return end;
  return null;
}
```

- [ ] **Step 3: Implement `src/model/buildResumeModel.ts`**

```typescript
import type { AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentBlock, DocumentModel } from "./types";
import { contactLine, dateRange, type ResumeProfile } from "./resumeProfile";

/** Items the optimizer selected (in its order) with its text, then the rest (in profile order) with their own text. */
function selectedFirst<T extends { id: string }>(
  items: T[],
  applied: AppliedBullet[],
  sourceType: AppliedBullet["sourceType"],
  originalText: (item: T) => string
): { item: T; text: string }[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen: { item: T; text: string }[] = [];
  const used = new Set<string>();
  for (const a of applied) {
    if (a.sourceType !== sourceType) continue;
    const item = byId.get(a.sourceFactId);
    if (!item) continue; // belongs to another group (e.g. a different role) -- the caller checks global existence
    chosen.push({ item, text: a.optimizedText });
    used.add(item.id);
  }
  for (const item of items) if (!used.has(item.id)) chosen.push({ item, text: originalText(item) });
  return chosen;
}

/**
 * The resume document (Phase 7b design §4.2, D82): the full profile, with the optimizer's guard-applied
 * rewordings replacing their originals and ordered first. Education, certifications and skill names are
 * never reworded. rejectedClaims are never an input. No street address.
 */
export function buildResumeModel(profile: ResumeProfile, applied: AppliedBullet[]): DocumentModel {
  const knownIds = new Set<string>([
    ...profile.experiences.flatMap((e) => e.bullets.map((b) => b.id)),
    ...profile.achievements.map((a) => a.id),
    ...profile.projects.map((p) => p.id),
    ...profile.certifications.map((c) => c.id),
    ...profile.education.map((e) => e.id),
    ...profile.skills.map((s) => s.id),
  ]);
  for (const a of applied) {
    if (!knownIds.has(a.sourceFactId)) throw new Error(`applied bullet cites unknown source fact ${a.sourceFactId}`);
  }

  const blocks: DocumentBlock[] = [];

  if (profile.experiences.length > 0) {
    blocks.push({ type: "heading", text: "Experience" });
    for (const exp of profile.experiences) {
      blocks.push({
        type: "entry",
        title: exp.title,
        subtitle: [exp.company, exp.location].filter((s): s is string => !!s && s.trim().length > 0).join(" · "),
        meta: dateRange(exp.startDate, exp.endDate),
      });
      const bullets = selectedFirst(exp.bullets, applied, "work_experience_bullet", (b) => b.text);
      if (bullets.length > 0) blocks.push({ type: "bullets", items: bullets.map((b) => b.text) });
    }
  }

  if (profile.projects.length > 0) {
    blocks.push({ type: "heading", text: "Projects" });
    for (const { item, text } of selectedFirst(profile.projects, applied, "project", (p) => p.description)) {
      blocks.push({ type: "entry", title: item.name, subtitle: item.url, meta: null });
      blocks.push({ type: "paragraph", text });
    }
  }

  if (profile.achievements.length > 0) {
    blocks.push({ type: "heading", text: "Achievements" });
    blocks.push({ type: "bullets", items: selectedFirst(profile.achievements, applied, "achievement", (a) => a.description).map((a) => a.text) });
  }

  if (profile.education.length > 0) {
    blocks.push({ type: "heading", text: "Education" });
    for (const e of profile.education) {
      blocks.push({
        type: "entry",
        title: e.fieldOfStudy ? `${e.degree} in ${e.fieldOfStudy}` : e.degree,
        subtitle: e.gpa ? `${e.institution} · GPA ${e.gpa}` : e.institution,
        meta: dateRange(e.startDate, e.endDate),
      });
    }
  }

  if (profile.certifications.length > 0) {
    blocks.push({ type: "heading", text: "Certifications" });
    for (const c of profile.certifications) {
      blocks.push({
        type: "entry",
        title: c.name,
        subtitle: c.issuer,
        meta: c.issueDate && c.expiryDate ? `${c.issueDate} – ${c.expiryDate}` : c.issueDate ?? (c.expiryDate ? `Expires ${c.expiryDate}` : null),
      });
    }
  }

  if (profile.skills.length > 0) {
    blocks.push({ type: "heading", text: "Skills" });
    // Profile names only: the order follows the optimizer's selection, the text never does.
    const ordered = selectedFirst(profile.skills, applied, "skill", (s) => s.name).map(({ item }) => item.name);
    blocks.push({ type: "paragraph", text: ordered.join(", ") });
  }

  return { title: profile.contact.fullName, contactLine: contactLine(profile.contact), blocks };
}
```

- [ ] **Step 4: Run** — `pnpm --filter @ai-career/document-export test -- buildResumeModel` → PASS (12 tests).

- [ ] **Step 5: Export** — append to `src/index.ts`:

```typescript
export { contactLine, dateRange, type ResumeContact, type ResumeProfile } from "./model/resumeProfile";
export { buildResumeModel } from "./model/buildResumeModel";
```

Run typecheck + lint → PASS.

- [ ] **Step 6: DECISIONS.md (expected D82)**

```markdown
### D82. The exported resume is the whole profile with guard-applied rewordings first; records are never reworded; no street address
**Decision:** `buildResumeModel` renders every profile bullet. Within each role (and for projects and achievements) the optimizer's guard-applied `selectedBullets` come first in the optimizer's order using `optimizedText`, followed by the untouched items in profile order with their original text. Education and certifications are always rendered verbatim; skills are reordered by the selection but always use the profile's names. `rejectedClaims` are never read. The header has name, email, phone and LinkedIn only — the street address is omitted. An applied bullet citing an unknown fact throws (a bug: the export pipeline has already verified the profile hash).
**Why:** Nothing the user has stated disappears silently, and nothing the guard rejected can appear (spec decision 1, D63). Records (degrees, certifications, skill names) are facts, not prose, so rewording them adds risk and no value. Minimising personal data on a document sent to third parties (CLAUDE.md §9).
**Alternatives considered:** Only the optimized selection (rejected by the user in brainstorming); applying `optimizedText` to every source type (rejected: rewording records).
**What it affects:** `packages/document-export/src/model/{resumeProfile,buildResumeModel}.ts`.
```

- [ ] **Step 7: Commit**

```bash
git add packages/document-export/src DECISIONS.md
git commit -m "feat(document-export): resume document model with the optimization merge rules"
```

---

## Task 6: `buildPitchModel`

**Files:**
- Create: `packages/document-export/src/model/buildPitchModel.ts`
- Create: `packages/document-export/src/model/buildPitchModel.test.ts`
- Modify: `packages/document-export/src/index.ts`

**Interfaces:**
- Consumes: `ResumeContact`, `contactLine` (Task 5); `StoredPitchBullet` from `@ai-career/application-package`.
- Produces: `buildPitchModel(contact: ResumeContact, job: { title: string; companyName: string }, bullets: StoredPitchBullet[]): DocumentModel`.

- [ ] **Step 1: Failing test** — `src/model/buildPitchModel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { StoredPitchBullet } from "@ai-career/application-package";
import { buildPitchModel } from "./buildPitchModel";

const bullets: StoredPitchBullet[] = [
  { kind: "company", text: "Company text.", supported: true, unsupportedReason: null, evidence: [{ id: "r:1", kind: "research", text: "e", sourceUrl: null }] },
  { kind: "role", text: "Role text.", supported: null, unsupportedReason: null, evidence: [] },
  { kind: "candidate", text: "Candidate text.", supported: true, unsupportedReason: null, evidence: [] },
];

describe("buildPitchModel", () => {
  it("builds a titled one-pager with the name, contact line and the three bullets in order, without evidence", () => {
    const model = buildPitchModel(
      { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: null, linkedinUrl: null },
      { title: "Backend Engineer", companyName: "GitLab" },
      bullets
    );
    expect(model).toEqual({
      title: "Why I'm a fit for Backend Engineer at GitLab",
      contactLine: "jane@example.com",
      blocks: [
        { type: "paragraph", text: "Jane Doe" },
        { type: "bullets", items: ["Company text.", "Role text.", "Candidate text."] },
      ],
    });
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `src/model/buildPitchModel.ts`**

```typescript
import type { StoredPitchBullet } from "@ai-career/application-package";
import type { DocumentModel } from "./types";
import { contactLine, type ResumeContact } from "./resumeProfile";

/** One-page pitch (Phase 7b design §4.3): the selected version's three bullet texts, no evidence or labels. */
export function buildPitchModel(
  contact: ResumeContact,
  job: { title: string; companyName: string },
  bullets: StoredPitchBullet[]
): DocumentModel {
  return {
    title: `Why I'm a fit for ${job.title} at ${job.companyName}`,
    contactLine: contactLine(contact),
    blocks: [
      { type: "paragraph", text: contact.fullName },
      { type: "bullets", items: bullets.map((b) => b.text) },
    ],
  };
}
```

- [ ] **Step 3: Export + run** — append `export { buildPitchModel } from "./model/buildPitchModel";` to `src/index.ts`; run the test, typecheck, lint → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/document-export/src
git commit -m "feat(document-export): pitch document model"
```

---

## Task 7: PDF renderer (`pdfkit`)

**Files:**
- Create: `packages/document-export/src/render/renderPdf.ts`
- Create: `packages/document-export/src/render/renderPdf.test.ts`
- Create: `packages/document-export/src/render/roundTrip.ts` (test helper, used by Tasks 7-8)
- Modify: `packages/document-export/src/index.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `DocumentModel` (Task 3), fonts (Task 4); `extractText(buffer, "pdf" | "docx")` from `@ai-career/ai` (devDependency, tests only).
- Produces: `renderPdf(model: DocumentModel): Promise<Buffer>`; test helpers `modelStrings(model): string[]` and `expectTextInOrder(text: string, expected: string[]): void` in `roundTrip.ts`.

- [ ] **Step 1: Create `src/render/roundTrip.ts`**

```typescript
import { expect } from "vitest";
import type { DocumentModel } from "../model/types";

/** Every visible string of a model, in reading order. */
export function modelStrings(model: DocumentModel): string[] {
  const out = [model.title];
  if (model.contactLine) out.push(model.contactLine);
  for (const block of model.blocks) {
    if (block.type === "heading" || block.type === "paragraph") out.push(block.text);
    else if (block.type === "entry") {
      out.push(block.title);
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) out.push(sub);
    } else out.push(...block.items);
  }
  return out;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Asserts each expected string occurs in the extracted text, each after the previous one (whitespace-insensitive). */
export function expectTextInOrder(text: string, expected: string[]): void {
  const haystack = normalize(text);
  let from = 0;
  for (const s of expected) {
    const at = haystack.indexOf(normalize(s), from);
    expect(at, `"${s}" not found in order`).toBeGreaterThanOrEqual(0);
    from = at + normalize(s).length;
  }
}
```

- [ ] **Step 2: Failing tests** — `src/render/renderPdf.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractText } from "@ai-career/ai";
import { renderPdf } from "./renderPdf";
import { modelStrings, expectTextInOrder } from "./roundTrip";
import type { DocumentModel } from "../model/types";

const model: DocumentModel = {
  title: "José Núñez",
  contactLine: "jose@example.com · +34 600 000 000",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Senior Engineer", subtitle: "Łódź Systems · Kraków", meta: "2021 – present" },
    { type: "bullets", items: ["Built a Rust ingestion service processing 2 TB per day", "Led migration to PostgreSQL 16"] },
    { type: "heading", text: "Skills" },
    { type: "paragraph", text: "Rust, PostgreSQL, Kubernetes" },
  ],
};

describe("renderPdf", () => {
  it("produces a PDF whose extracted text contains every model string in order, including non-ASCII names", async () => {
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expectTextInOrder(await extractText(pdf, "pdf"), modelStrings(model));
  });

  it("paginates a long resume and keeps all text extractable", async () => {
    const long: DocumentModel = {
      title: "Long Resume",
      contactLine: null,
      blocks: Array.from({ length: 12 }, (_, i) => [
        { type: "entry" as const, title: `Role ${i}`, subtitle: `Company ${i}`, meta: null },
        { type: "bullets" as const, items: Array.from({ length: 8 }, (__, j) => `Achievement ${i}-${j} with a sentence long enough to wrap onto a second line of the page`) },
      ]).flat(),
    };
    const pdf = await renderPdf(long);
    const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    expectTextInOrder(await extractText(pdf, "pdf"), modelStrings(long));
  });

  it("renders an empty model (title only)", async () => {
    const pdf = await renderPdf({ title: "Only Title", contactLine: null, blocks: [] });
    expectTextInOrder(await extractText(pdf, "pdf"), ["Only Title"]);
  });
});
```

Run → FAIL (module not found).

- [ ] **Step 3: Implement `src/render/renderPdf.ts`**

```typescript
import PDFDocument from "pdfkit";
import type { DocumentModel } from "../model/types";
import { NOTO_SANS_BOLD_BASE64, NOTO_SANS_REGULAR_BASE64 } from "./fonts.generated";

const MARGIN = 50;
const BULLET_INDENT = 12;

/**
 * Single-column, text-only A4 PDF (Phase 7b design §4.5): real text in an embedded Unicode font, no images or
 * tables, automatic page breaks -- the machine-readable shape the spec's §10.2 scorecard asks for.
 */
export function renderPdf(model: DocumentModel): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: model.title, Producer: "CareerPilot" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.registerFont("body", Buffer.from(NOTO_SANS_REGULAR_BASE64, "base64"));
  doc.registerFont("bold", Buffer.from(NOTO_SANS_BOLD_BASE64, "base64"));
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("bold").fontSize(18).text(model.title, left, doc.y, { width });
  if (model.contactLine) doc.font("body").fontSize(10).text(model.contactLine, left, doc.y, { width });

  for (const block of model.blocks) {
    if (block.type === "heading") {
      doc.moveDown(0.8);
      doc.font("bold").fontSize(12).text(block.text, left, doc.y, { width });
      const y = doc.y + 1;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    } else if (block.type === "entry") {
      doc.moveDown(0.3);
      doc.font("bold").fontSize(11).text(block.title, left, doc.y, { width });
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) doc.font("body").fontSize(10).text(sub, left, doc.y, { width });
    } else if (block.type === "paragraph") {
      doc.font("body").fontSize(10).text(block.text, left, doc.y, { width, lineGap: 1 });
    } else {
      for (const item of block.items) {
        const y = doc.y;
        doc.font("body").fontSize(10).text("•", left, y, { lineBreak: false });
        doc.text(item, left + BULLET_INDENT, y, { width: width - BULLET_INDENT, lineGap: 1 });
      }
    }
    doc.x = left;
  }

  doc.end();
  return done;
}
```

(If a long bullet starts at the very bottom of a page, pdfkit moves the wrapped text to the next page while the "•" stays behind; the round-trip test still passes. Accepted as cosmetic for `RENDERER_VERSION = "1"`.)

- [ ] **Step 4: Run** — `pnpm --filter @ai-career/document-export test -- renderPdf` → PASS (3 tests). If `extractText` returns the bullet glyph fused to the next word ("•Built"), `expectTextInOrder` still matches because it searches for the item text, not the bullet.

- [ ] **Step 5: Export** — append `export { renderPdf } from "./render/renderPdf";` to `src/index.ts`; typecheck + lint → PASS.

- [ ] **Step 6: DECISIONS.md (expected D83)**

```markdown
### D83. Documents render from one model through pdfkit and docx, with Noto Sans embedded as generated base64
**Decision:** Both formats consume the same `DocumentModel`. PDF: `pdfkit`, A4, single column, real text, no images/tables, Noto Sans Regular/Bold registered from base64 embedded in `src/render/fonts.generated.ts` (generated by `scripts/embed-fonts.mjs` from the pinned `@expo-google-fonts/noto-sans@0.4.2`, OFL 1.1 in `assets/OFL.txt`). DOCX: `docx`, Word heading styles and a real bullet numbering definition. `RENDERER_VERSION` is part of the content hash. Tests put every rendered file back through the same `extractText` (pdf-parse/mammoth) that reads uploaded resumes and assert every model string appears in order — including "José Núñez"/"Łódź" and a ≥3-page document.
**Why:** One layout source cannot drift between formats; pure JS needs no browser or office suite; pdfkit's built-in fonts only cover WinAnsi, so non-Western-European names need an embedded font; base64 avoids runtime font file paths that a bundler can break. The round-trip test is a concrete, repeatable "machine readable" check (spec §10.2).
**Alternatives considered:** HTML + headless Chrome; DOCX → PDF via LibreOffice (both rejected in brainstorming); committing the TTF binaries and reading them at runtime (rejected: bundler path fragility).
**What it affects:** `packages/document-export/src/render/*`, `scripts/embed-fonts.mjs`, `assets/OFL.txt`.
```

- [ ] **Step 7: Commit**

```bash
git add packages/document-export/src DECISIONS.md
git commit -m "feat(document-export): PDF renderer with round-trip readability tests"
```

---

## Task 8: DOCX renderer (`docx`)

**Files:**
- Create: `packages/document-export/src/render/renderDocx.ts`
- Create: `packages/document-export/src/render/renderDocx.test.ts`
- Modify: `packages/document-export/src/index.ts`

**Interfaces:**
- Produces: `renderDocx(model: DocumentModel): Promise<Buffer>`; `renderDocument(model: DocumentModel, format: DocumentFormat): Promise<Buffer>` in `src/render/renderDocument.ts`.

- [ ] **Step 1: Failing tests** — `src/render/renderDocx.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractText } from "@ai-career/ai";
import { renderDocx } from "./renderDocx";
import { renderDocument } from "./renderDocument";
import { modelStrings, expectTextInOrder } from "./roundTrip";
import type { DocumentModel } from "../model/types";

const model: DocumentModel = {
  title: "Łukasz Żółć",
  contactLine: "lukasz@example.com",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Data Engineer", subtitle: "Globex · Warszawa", meta: "2020 – 2024" },
    { type: "bullets", items: ["Built Spark pipelines", "Cut costs by 30%"] },
    { type: "heading", text: "Projects" },
    { type: "entry", title: "Open Source Tool", subtitle: null, meta: null },
    { type: "paragraph", text: "A CLI for schema diffs" },
  ],
};

describe("renderDocx", () => {
  it("produces a DOCX (zip) whose extracted text contains every model string in order", async () => {
    const docx = await renderDocx(model);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expectTextInOrder(await extractText(docx, "docx"), modelStrings(model));
  });

  it("uses Word heading styles and a bullet numbering definition", async () => {
    const xml = (await renderDocx(model)).toString("latin1");
    // document.xml is deflated inside the zip, so assert on the part names present in the package instead.
    expect(xml).toContain("word/document.xml");
    expect(xml).toContain("word/numbering.xml");
    expect(xml).toContain("word/styles.xml");
  });
});

describe("renderDocument", () => {
  it("dispatches by format", async () => {
    expect((await renderDocument(model, "pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await renderDocument(model, "docx")).subarray(0, 2).toString()).toBe("PK");
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `src/render/renderDocx.ts`**

```typescript
import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun } from "docx";
import type { DocumentModel } from "../model/types";

const BULLETS = "cp-bullets";

/** Same structure as the PDF, as a native Word document: heading styles, real bullets, no tables/text boxes. */
export function renderDocx(model: DocumentModel): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.title)] })];
  if (model.contactLine) children.push(new Paragraph({ children: [new TextRun(model.contactLine)] }));

  for (const block of model.blocks) {
    if (block.type === "heading") {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(block.text)] }));
    } else if (block.type === "entry") {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(block.title)] }));
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) children.push(new Paragraph({ children: [new TextRun({ text: sub, italics: true })] }));
    } else if (block.type === "paragraph") {
      children.push(new Paragraph({ children: [new TextRun(block.text)] }));
    } else {
      for (const item of block.items) {
        children.push(new Paragraph({ numbering: { reference: BULLETS, level: 0 }, children: [new TextRun(item)] }));
      }
    }
  }

  const doc = new Document({
    creator: "CareerPilot",
    title: model.title,
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
```

`src/render/renderDocument.ts`:

```typescript
import type { DocumentFormat, DocumentModel } from "../model/types";
import { renderDocx } from "./renderDocx";
import { renderPdf } from "./renderPdf";

export function renderDocument(model: DocumentModel, format: DocumentFormat): Promise<Buffer> {
  return format === "pdf" ? renderPdf(model) : renderDocx(model);
}
```

(If `Packer.toBuffer`'s declared return type is not `Promise<Buffer>` in docx 9.7, wrap: `return Packer.toBuffer(doc).then((b) => Buffer.from(b));` — verify against `node_modules/docx/dist/index.d.ts`.)

- [ ] **Step 3: Run** — `pnpm --filter @ai-career/document-export test -- renderDocx` → PASS (3 tests).

- [ ] **Step 4: Export** — append to `src/index.ts`:

```typescript
export { renderDocx } from "./render/renderDocx";
export { renderDocument } from "./render/renderDocument";
```

typecheck + lint → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/document-export/src
git commit -m "feat(document-export): DOCX renderer with round-trip readability tests"
```

---
## Task 9: Test harness, `loadResumeProfile`, `storeDocument`, `exportResume`

**Files:**
- Create: `packages/document-export/src/testing/{db.ts,index.ts}`
- Create: `packages/document-export/src/pipeline/loadResumeProfile.ts`
- Create: `packages/document-export/src/pipeline/storeDocument.ts`
- Create: `packages/document-export/src/pipeline/exportResume.ts`
- Create: `packages/document-export/src/pipeline/exportResume.test.ts`
- Modify: `packages/document-export/src/index.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `schema.generatedDocuments` (Task 1); storage functions (Task 2); `buildResumeModel`, `ResumeProfile` (Task 5); `renderDocument` (Task 8); `modelContentHash`, `buildDownloadFilename`, `assertSafeModel`, `DocumentExportError` (Task 3); `buildResumeSnapshot`, `AppliedBullet` from `@ai-career/resume-optimization`.
- Produces:
  - `type GeneratedDocumentRow = typeof schema.generatedDocuments.$inferSelect`
  - `type StorageClient = Client` (minio)
  - `loadResumeProfile(tx: DbClient): Promise<ResumeProfile | null>` (null when no `candidate_profiles` row; call inside `withUserContext`)
  - `storeDocument(db: DbClient, storage: Client, input: { userId: string; jobId: string; kind: DocumentKind; format: DocumentFormat; model: DocumentModel; resumeOptimizationId: string | null; applicationPitchId: string | null; downloadFilename: string }): Promise<GeneratedDocumentRow>`
  - `exportResume(db: DbClient, storage: Client, input: { userId: string; jobId: string; optimizationId: string; format: DocumentFormat }): Promise<GeneratedDocumentRow>`
  - testing: `openTestDb()`, `wipeUser(adminSql, userId)`, `testStorageClient()`, `seedResumeFixture(testDb, userId): Promise<{ jobId: string; goalId: string; bulletIds: string[] }>`, `insertOptimization(testDb, userId, jobId, goalId, selectedBullets: AppliedBullet[], sourceProfileContentHash: string): Promise<string>`

- [ ] **Step 1: Test harness** — `src/testing/db.ts`:

```typescript
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Client } from "minio";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import type { AppliedBullet } from "@ai-career/resume-optimization";

const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const MIGRATION_LOCK = 7420001;

export interface TestDb {
  adminSql: postgres.Sql;
  db: DbClient;
  close(): Promise<void>;
}

export async function openTestDb(): Promise<TestDb> {
  const adminSql = postgres(ADMIN_URL);
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  const db = createDbClient({ DATABASE_URL: APP_URL });
  return { adminSql, db, close: async () => { await closeDbClient(db); await adminSql.end(); } };
}

export function testStorageClient(): Client {
  return createStorageClient({
    MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
    MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
    MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
  });
}

/** User-scoped; application_pitches / generated_documents / resume_optimizations cascade from jobs. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM work_experience_bullets WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM work_experiences WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM achievements WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM projects WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM certifications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM education WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM skills WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}

/** A confirmed profile (contact, one role with two bullets, one skill), a goal and a job at "GitLab". */
export async function seedResumeFixture(testDb: TestDb, userId: string): Promise<{ jobId: string; goalId: string; bulletIds: string[] }> {
  const s = testDb.adminSql;
  await s`INSERT INTO candidate_profiles (user_id, full_name, email, phone_number, address_line1)
          VALUES (${userId}, 'Jane Doe', 'jane@example.com', '+49 1', '1 Secret Street')`;
  const [exp] = await s`INSERT INTO work_experiences (user_id, company, title, start_date, display_order)
                        VALUES (${userId}, 'Globex', 'Engineer', '2021', 0) RETURNING id`;
  const bullets = await s`INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
                          VALUES (${userId}, ${exp.id}, 'Built A', 0), (${userId}, ${exp.id}, 'Built B', 1) RETURNING id`;
  await s`INSERT INTO skills (user_id, name, display_order) VALUES (${userId}, 'Python', 0)`;
  const [goal] = await s`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                         VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await s`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                        VALUES (${userId}, 'GitLab', 'gitlab', 'Backend Engineer', 'backend engineer', 'dh', now(), now()) RETURNING id`;
  return { jobId: job.id as string, goalId: goal.id as string, bulletIds: bullets.map((b) => b.id as string) };
}

export async function insertOptimization(
  testDb: TestDb, userId: string, jobId: string, goalId: string, selectedBullets: AppliedBullet[], sourceProfileContentHash: string
): Promise<string> {
  const [row] = await testDb.adminSql`
    INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                      added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
    VALUES (${userId}, ${jobId}, ${goalId}, 1, ${sourceProfileContentHash}, ${JSON.stringify(selectedBullets)}::jsonb,
            '{}', '{}', false, ${JSON.stringify([{ sourceFactId: "rejected-1", reason: "REJECTED CLAIM" }])}::jsonb, 'm')
    RETURNING id`;
  return row.id as string;
}
```

(Before running, open `packages/db/src/schema/candidateProfiles.ts`, `workExperiences.ts`, `skills.ts`, `careerGoals.ts` and confirm every NOT NULL column without a default is supplied above; add any missing one to the seed and note it in your report.)

`src/testing/index.ts`:

```typescript
export { openTestDb, wipeUser, testStorageClient, seedResumeFixture, insertOptimization, type TestDb } from "./db";
```

- [ ] **Step 2: Failing tests** — user `…de` (grep first). `src/pipeline/exportResume.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { withUserContext } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, insertOptimization, type TestDb } from "../testing/db";
import { exportResume } from "./exportResume";
import { DocumentExportError } from "../errors";

const USER = "00000000-0000-0000-0000-0000000000de";
const storage = testStorageClient();
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(async () => {
  const keys = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

async function fixtureWithOptimization() {
  const { jobId, goalId, bulletIds } = await seedResumeFixture(testDb, USER);
  const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
  const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [
    { sourceFactId: bulletIds[1], sourceType: "work_experience_bullet", originalText: "Built B", optimizedText: "Built B with Go", changeType: "reworded", justification: "j" },
  ], contentHash);
  return { jobId, optimizationId };
}

const run = (jobId: string, optimizationId: string, format: "pdf" | "docx" = "pdf") =>
  exportResume(testDb.db, storage, { userId: USER, jobId, optimizationId, format });

describe("exportResume", () => {
  it("renders, stores and records a resume with the merge rules applied and no street address", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const doc = await run(jobId, optimizationId);

    expect(doc).toMatchObject({ jobId, kind: "resume", format: "pdf", resumeOptimizationId: optimizationId, applicationPitchId: null,
      rendererVersion: "1", downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(doc.objectKey).toMatch(new RegExp(`^${USER}/[0-9a-f-]{36}\\.pdf$`));
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    expect(text.indexOf("Built B with Go")).toBeLessThan(text.indexOf("Built A"));
    expect(text).not.toContain("Secret Street");
    expect(text).not.toContain("REJECTED CLAIM");
    expect(doc.byteSize).toBeGreaterThan(0);
  });

  it("returns the existing row for an identical export without uploading again", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const first = await run(jobId, optimizationId);
    const second = await run(jobId, optimizationId);
    expect(second.id).toBe(first.id);
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM generated_documents WHERE user_id = ${USER}`;
    expect(n).toBe(1);
  });

  it("stores PDF and DOCX as separate documents", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const pdf = await run(jobId, optimizationId, "pdf");
    const docx = await run(jobId, optimizationId, "docx");
    expect(docx.id).not.toBe(pdf.id);
    expect(docx.downloadFilename).toBe("Jane Doe - GitLab - Resume.docx");
    await expect(extractText(await readAll(await getGeneratedDocument(storage, docx.objectKey)), "docx")).resolves.toContain("Built B with Go");
  });

  it("two concurrent identical exports end with one row and no orphaned object", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    const [a, b] = await Promise.all([run(jobId, optimizationId), run(jobId, optimizationId)]);
    expect(a.id).toBe(b.id);
    const rows = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
    expect(rows).toHaveLength(1);
    const listed: string[] = [];
    for await (const obj of storage.listObjectsV2(GENERATED_DOCUMENTS_BUCKET, `${USER}/`, true)) listed.push((obj as { name: string }).name);
    expect(listed).toEqual([rows[0].object_key]);
  });

  it("refuses with profile_changed when the profile changed after the optimization", async () => {
    const { jobId, optimizationId } = await fixtureWithOptimization();
    await testDb.adminSql`INSERT INTO skills (user_id, name, display_order) VALUES (${USER}, 'Rust', 1)`;
    await expect(run(jobId, optimizationId)).rejects.toMatchObject({ errorClass: "profile_changed" });
  });

  it("refuses with source_mismatch for an optimization of another job", async () => {
    const { optimizationId } = await fixtureWithOptimization();
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(run(other.id, optimizationId)).rejects.toMatchObject({ errorClass: "source_mismatch" });
  });

  it("refuses with job_not_found for an unknown job", async () => {
    const { optimizationId } = await fixtureWithOptimization();
    await expect(run("33333333-3333-3333-3333-333333333333", optimizationId)).rejects.toBeInstanceOf(DocumentExportError);
    await expect(run("33333333-3333-3333-3333-333333333333", optimizationId)).rejects.toMatchObject({ errorClass: "job_not_found" });
  });
});
```

Run `pnpm --filter @ai-career/document-export test -- exportResume` → FAIL (modules not found).

- [ ] **Step 3: Implement `src/pipeline/loadResumeProfile.ts`**

```typescript
import { asc } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import type { ResumeProfile } from "../model/resumeProfile";

const { candidateProfiles, workExperiences, workExperienceBullets, achievements, projects, certifications, education, skills } = schema;

/** Call inside withUserContext. Null when the user has no confirmed profile. Street address is not read. */
export async function loadResumeProfile(tx: DbClient): Promise<ResumeProfile | null> {
  const [contact] = await tx
    .select({ fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber, linkedinUrl: candidateProfiles.linkedinUrl })
    .from(candidateProfiles)
    .limit(1);
  if (!contact) return null;

  const [exps, bullets, achs, projs, certs, edus, skls] = await Promise.all([
    tx.select().from(workExperiences).orderBy(asc(workExperiences.displayOrder), asc(workExperiences.id)),
    tx.select().from(workExperienceBullets).orderBy(asc(workExperienceBullets.displayOrder), asc(workExperienceBullets.id)),
    tx.select().from(achievements).orderBy(asc(achievements.displayOrder), asc(achievements.id)),
    tx.select().from(projects).orderBy(asc(projects.displayOrder), asc(projects.id)),
    tx.select().from(certifications).orderBy(asc(certifications.displayOrder), asc(certifications.id)),
    tx.select().from(education).orderBy(asc(education.displayOrder), asc(education.id)),
    tx.select().from(skills).orderBy(asc(skills.displayOrder), asc(skills.id)),
  ]);

  return {
    contact,
    experiences: exps.map((e) => ({
      id: e.id, company: e.company, title: e.title, location: e.location, startDate: e.startDate, endDate: e.endDate,
      bullets: bullets.filter((b) => b.workExperienceId === e.id).map((b) => ({ id: b.id, text: b.text })),
    })),
    achievements: achs.map((a) => ({ id: a.id, description: a.description })),
    projects: projs.map((p) => ({ id: p.id, name: p.name, description: p.description, url: p.url })),
    certifications: certs.map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, issueDate: c.issueDate, expiryDate: c.expiryDate })),
    education: edus.map((e) => ({
      id: e.id, institution: e.institution, degree: e.degree, fieldOfStudy: e.fieldOfStudy, startDate: e.startDate, endDate: e.endDate, gpa: e.gpa,
    })),
    skills: skls.map((s) => ({ id: s.id, name: s.name })),
  };
}
```

- [ ] **Step 4: Implement `src/pipeline/storeDocument.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { deleteGeneratedDocument, uploadGeneratedDocument } from "@ai-career/storage";
import { RENDERER_VERSION, type DocumentFormat, type DocumentKind, type DocumentModel } from "../model/types";
import { modelContentHash } from "../model/hash";
import { assertSafeModel } from "../model/assertSafeModel";
import { renderDocument } from "../render/renderDocument";
import { DocumentExportError } from "../errors";

const { generatedDocuments } = schema;

export type GeneratedDocumentRow = typeof generatedDocuments.$inferSelect;

export interface StoreDocumentInput {
  userId: string;
  jobId: string;
  kind: DocumentKind;
  format: DocumentFormat;
  model: DocumentModel;
  resumeOptimizationId: string | null;
  applicationPitchId: string | null;
  downloadFilename: string;
}

/**
 * Hash → reuse, else render → upload (outside any transaction) → insert ON CONFLICT DO NOTHING.
 * A loser of a concurrent identical export deletes its own upload and returns the winner's row (D84).
 */
export async function storeDocument(db: DbClient, storage: Client, input: StoreDocumentInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);
  assertSafeModel(input.model);
  const contentHash = modelContentHash(input.model, input.format);
  const findExisting = () =>
    inUserContext((tx) =>
      tx
        .select()
        .from(generatedDocuments)
        .where(and(eq(generatedDocuments.kind, input.kind), eq(generatedDocuments.format, input.format), eq(generatedDocuments.contentHash, contentHash)))
        .limit(1)
    );

  const [existing] = await findExisting();
  if (existing) return existing;

  const buffer = await renderDocument(input.model, input.format);
  let objectKey: string;
  try {
    ({ objectKey } = await uploadGeneratedDocument(storage, { userId: input.userId, buffer, extension: input.format }));
  } catch {
    throw new DocumentExportError("storage_unavailable");
  }

  const [inserted] = await inUserContext((tx) =>
    tx
      .insert(generatedDocuments)
      .values({
        jobId: input.jobId,
        kind: input.kind,
        format: input.format,
        resumeOptimizationId: input.resumeOptimizationId,
        applicationPitchId: input.applicationPitchId,
        objectKey,
        byteSize: buffer.length,
        contentHash,
        rendererVersion: RENDERER_VERSION,
        downloadFilename: input.downloadFilename,
      })
      .onConflictDoNothing({ target: [generatedDocuments.userId, generatedDocuments.kind, generatedDocuments.format, generatedDocuments.contentHash] })
      .returning()
  );
  if (inserted) return inserted;

  await deleteGeneratedDocument(storage, objectKey).catch(() => {});
  const [winner] = await findExisting();
  if (!winner) throw new Error("generated_documents insert conflicted but no existing row was found");
  return winner;
}
```

- [ ] **Step 5: Implement `src/pipeline/exportResume.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { buildResumeSnapshot, type AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentFormat } from "../model/types";
import { buildResumeModel } from "../model/buildResumeModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { loadResumeProfile } from "./loadResumeProfile";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, resumeOptimizations } = schema;

export interface ExportResumeInput {
  userId: string;
  jobId: string;
  optimizationId: string;
  format: DocumentFormat;
}

/** Phase 7b design §4.4. Refuses (profile_changed) when the profile no longer matches the optimization (D84). */
export async function exportResume(db: DbClient, storage: Client, input: ExportResumeInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [optimization] = await inUserContext((tx) =>
    tx
      .select()
      .from(resumeOptimizations)
      .where(and(eq(resumeOptimizations.id, input.optimizationId), eq(resumeOptimizations.jobId, input.jobId)))
      .limit(1)
  );
  if (!optimization) throw new DocumentExportError("source_mismatch");

  const { snapshot, profile } = await inUserContext(async (tx) => ({
    snapshot: await buildResumeSnapshot(tx),
    profile: await loadResumeProfile(tx),
  }));
  if (snapshot.contentHash !== optimization.sourceProfileContentHash) throw new DocumentExportError("profile_changed");
  if (!profile) throw new DocumentExportError("no_profile");

  const model = buildResumeModel(profile, optimization.selectedBullets as AppliedBullet[]);
  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "resume",
    format: input.format,
    model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "resume", input.format),
  });
}
```

- [ ] **Step 6: Run** — `pnpm --filter @ai-career/document-export test -- exportResume` → PASS (7 tests). Run the concurrency test 5 times; if it ever fails, investigate — do not weaken it.

- [ ] **Step 7: Export** — append to `src/index.ts`:

```typescript
export { loadResumeProfile } from "./pipeline/loadResumeProfile";
export { storeDocument, type GeneratedDocumentRow, type StoreDocumentInput } from "./pipeline/storeDocument";
export { exportResume, type ExportResumeInput } from "./pipeline/exportResume";
```

typecheck + lint → PASS.

- [ ] **Step 8: DECISIONS.md (expected D84)**

```markdown
### D84. Export pipeline: blocking checks first, then hash-reuse, render + upload outside the transaction, ON CONFLICT DO NOTHING
**Decision:** `exportResume` checks job (404), that the optimization belongs to the job (400 source_mismatch), that the current `buildResumeSnapshot` hash equals the optimization's `sourceProfileContentHash` (409 profile_changed), and that a profile exists (409 no_profile). `storeDocument` then runs `assertSafeModel`, reuses any row with the same `(kind, format, contentHash)`, otherwise renders, uploads to MinIO outside any DB transaction (upload failure → storage_unavailable), and inserts with `ON CONFLICT (user_id, kind, format, content_hash) DO NOTHING`; a losing concurrent insert deletes its own upload and returns the winner. De-duplication is by content, so two optimization versions that yield an identical document share one stored file (the row keeps the first version's id).
**Why:** Mixing an old optimization's rewordings into a changed profile could misstate facts; refusing is the D6 "never guess" choice (spec decision 6). Keeping the upload out of the transaction avoids holding a DB connection across network I/O; the unique index makes concurrent identical exports converge without a lock.
**Alternatives considered:** Exporting against the profile as it was (no snapshot of old profile text exists); a per-user advisory lock around export (unnecessary given the unique index).
**What it affects:** `packages/document-export/src/pipeline/*`.
```

- [ ] **Step 9: Commit**

```bash
git add packages/document-export/src DECISIONS.md
git commit -m "feat(document-export): resume export pipeline with storage, de-dup and profile-change guard"
```

---

## Task 10: `exportPitch`

**Files:**
- Create: `packages/document-export/src/pipeline/exportPitch.ts`
- Create: `packages/document-export/src/pipeline/exportPitch.test.ts`
- Modify: `packages/document-export/src/index.ts`

**Interfaces:**
- Consumes: `storeDocument` (Task 9), `buildPitchModel` (Task 6), `schema.applicationPitches`, `schema.candidateProfiles`, `StoredPitchBullet`.
- Produces: `exportPitch(db: DbClient, storage: Client, input: { userId: string; jobId: string; pitchId: string; format: DocumentFormat }): Promise<GeneratedDocumentRow>`.

- [ ] **Step 1: Failing tests** — user `…df` (grep first). `src/pipeline/exportPitch.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { extractText } from "@ai-career/ai";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, type TestDb } from "../testing/db";
import { exportPitch } from "./exportPitch";

const USER = "00000000-0000-0000-0000-0000000000df";
const storage = testStorageClient();
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(async () => {
  const keys = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(() => wipeUser(testDb.adminSql, USER));

const bullet = (kind: string, text: string, supported: boolean | null) => ({ kind, text, supported, unsupportedReason: supported === false ? "cites no job requirement" : null, evidence: [] });

async function insertPitch(jobId: string, origin: "generated" | "user_edited", roleSupported: boolean | null) {
  const bullets = [bullet("company", "Company line.", origin === "generated" ? true : null), bullet("role", "Role line.", roleSupported), bullet("candidate", "Candidate line.", origin === "generated" ? true : null)];
  const [row] = await testDb.adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review, generation_model)
    VALUES (${USER}, ${jobId}, 1, ${origin}, 'ok', ${JSON.stringify(bullets)}::jsonb, ${roleSupported === false}, ${origin === "generated" ? "m" : null})
    RETURNING id`;
  return row.id as string;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

describe("exportPitch", () => {
  it("exports a fully supported generated pitch with title, name and the three bullets", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", true);
    const doc = await exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" });
    expect(doc).toMatchObject({ kind: "pitch", applicationPitchId: pitchId, resumeOptimizationId: null, downloadFilename: "Jane Doe - GitLab - Pitch.pdf" });
    const text = (await extractText(await readAll(await getGeneratedDocument(storage, doc.objectKey)), "pdf")).replace(/\s+/g, " ");
    for (const s of ["Why I'm a fit for Backend Engineer at GitLab", "Jane Doe", "Company line.", "Role line.", "Candidate line."]) expect(text).toContain(s);
  });

  it("refuses a generated pitch with an unsupported bullet (pitch_unsupported)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", false);
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "pitch_unsupported" });
  });

  it("allows a user_edited pitch (supported = null)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "user_edited", null);
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "docx" })).resolves.toMatchObject({ format: "docx" });
  });

  it("refuses a pitch from another job (source_mismatch) and a user without a profile (no_profile)", async () => {
    const { jobId } = await seedResumeFixture(testDb, USER);
    const pitchId = await insertPitch(jobId, "generated", true);
    const [other] = await testDb.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId: other.id, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "source_mismatch" });
    await testDb.adminSql`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
    await expect(exportPitch(testDb.db, storage, { userId: USER, jobId, pitchId, format: "pdf" })).rejects.toMatchObject({ errorClass: "no_profile" });
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement `src/pipeline/exportPitch.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { StoredPitchBullet } from "@ai-career/application-package";
import type { DocumentFormat } from "../model/types";
import { buildPitchModel } from "../model/buildPitchModel";
import { buildDownloadFilename } from "../model/filename";
import { DocumentExportError } from "../errors";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobs, applicationPitches, candidateProfiles } = schema;

export interface ExportPitchInput {
  userId: string;
  jobId: string;
  pitchId: string;
  format: DocumentFormat;
}

/**
 * Phase 7b design §4.4. A generated version with any supported === false bullet is refused (D84): a claim the guard
 * could not ground must not reach an employer by accident. user_edited versions (supported = null) always export.
 */
export async function exportPitch(db: DbClient, storage: Client, input: ExportPitchInput): Promise<GeneratedDocumentRow> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, title: jobs.title, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [pitch] = await inUserContext((tx) =>
    tx
      .select()
      .from(applicationPitches)
      .where(and(eq(applicationPitches.id, input.pitchId), eq(applicationPitches.jobId, input.jobId)))
      .limit(1)
  );
  if (!pitch) throw new DocumentExportError("source_mismatch");

  const bullets = pitch.bullets as StoredPitchBullet[];
  if (pitch.origin === "generated" && bullets.some((b) => b.supported === false)) {
    throw new DocumentExportError("pitch_unsupported");
  }

  const [contact] = await inUserContext((tx) =>
    tx
      .select({ fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber, linkedinUrl: candidateProfiles.linkedinUrl })
      .from(candidateProfiles)
      .limit(1)
  );
  if (!contact) throw new DocumentExportError("no_profile");

  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "pitch",
    format: input.format,
    model: buildPitchModel(contact, job, bullets),
    resumeOptimizationId: null,
    applicationPitchId: pitch.id,
    downloadFilename: buildDownloadFilename(contact.fullName, job.companyName, "pitch", input.format),
  });
}
```

- [ ] **Step 3: Run, export, verify** — run the test (4 PASS); append `export { exportPitch, type ExportPitchInput } from "./pipeline/exportPitch";` to `src/index.ts`; run the whole package test suite, typecheck, lint → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/document-export/src
git commit -m "feat(document-export): pitch export pipeline with unsupported-bullet guard"
```

---

## Task 11: Web — `/api/documents` routes and pdfkit bundling

**Files:**
- Modify: `apps/web/package.json` (deps `@ai-career/document-export`, `pdfkit`)
- Modify: `apps/web/next.config.ts`
- Create: `apps/web/src/lib/documents/serializeDocument.ts` + `serializeDocument.test.ts`
- Create: `apps/web/src/lib/documents/listDocuments.ts`
- Create: `apps/web/src/lib/documents/exportErrors.ts`
- Create: `apps/web/src/app/api/documents/route.ts` + `route.test.ts`
- Create: `apps/web/src/app/api/documents/[id]/download/route.ts` + `route.test.ts`
- Create: `apps/web/src/test/documentsDb.ts`
- Modify: `DECISIONS.md`

**Interfaces:**
- Consumes: `exportResume`, `exportPitch`, `DocumentExportError`, `GeneratedDocumentRow` (Tasks 9-10); `createStorageClient`, `getGeneratedDocument` (Task 2).
- Produces: `DocumentView { id; kind: "resume" | "pitch"; format: "pdf" | "docx"; sourceVersion: number | null; downloadFilename; byteSize; createdAt: string; downloadUrl: string }`; `POST /api/documents` → 201 `{ document }`; `GET /api/documents?jobId=` → `{ documents }`; `GET /api/documents/[id]/download` → file stream.

- [ ] **Step 1: Dependencies and Next config**

`apps/web/package.json` dependencies: add `"@ai-career/document-export": "workspace:*"` (alphabetical, after `@ai-career/db`) and `"pdfkit": "^0.20.2"`. Run `pnpm install`.

`apps/web/next.config.ts` — add `serverExternalPackages` next to `transpilePackages`:

```typescript
  transpilePackages: ["@ai-career/config", "@ai-career/db"],
  // pdfkit reads its built-in font metric files (.afm) from its own package directory at runtime, which breaks
  // when Next bundles it; keep it external so Node loads it from node_modules (DECISIONS.md D85).
  serverExternalPackages: ["pdfkit"],
```

- [ ] **Step 2: Serializer + error mapping + list**

`apps/web/src/lib/documents/serializeDocument.ts`:

```typescript
// apps/web/src/lib/documents/serializeDocument.ts
import type { GeneratedDocumentRow } from "@ai-career/document-export";

export interface DocumentView {
  id: string;
  kind: "resume" | "pitch";
  format: "pdf" | "docx";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
}

export function toDocumentView(row: GeneratedDocumentRow, sourceVersion: number | null): DocumentView {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    sourceVersion,
    downloadFilename: row.downloadFilename,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: `/api/documents/${row.id}/download`,
  };
}

export const CONTENT_TYPES: Record<"pdf" | "docx", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** RFC 6266 / 5987: ASCII fallback plus UTF-8 filename*. The stored name is already ASCII-sanitized. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
```

`apps/web/src/lib/documents/serializeDocument.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { toDocumentView, contentDisposition } from "./serializeDocument";

describe("toDocumentView", () => {
  it("serializes and builds the download URL", () => {
    const view = toDocumentView({
      id: "d1", userId: "u", jobId: "j", kind: "resume", format: "pdf", resumeOptimizationId: "o", applicationPitchId: null,
      objectKey: "u/x.pdf", byteSize: 1234, contentHash: "h", rendererVersion: "1", downloadFilename: "Jane - Acme - Resume.pdf",
      createdAt: new Date("2026-09-24T00:00:00Z"),
    } as never, 3);
    expect(view).toEqual({
      id: "d1", kind: "resume", format: "pdf", sourceVersion: 3, downloadFilename: "Jane - Acme - Resume.pdf",
      byteSize: 1234, createdAt: "2026-09-24T00:00:00.000Z", downloadUrl: "/api/documents/d1/download",
    });
    expect(JSON.stringify(view)).not.toContain("u/x.pdf");
  });
});

describe("contentDisposition", () => {
  it("emits an ASCII filename and an encoded filename*", () => {
    expect(contentDisposition("Jane Doe - Acme - Resume.pdf")).toBe(
      `attachment; filename="Jane Doe - Acme - Resume.pdf"; filename*=UTF-8''Jane%20Doe%20-%20Acme%20-%20Resume.pdf`
    );
  });

  it("neutralizes quotes and non-ASCII in the fallback", () => {
    expect(contentDisposition('a"b\u00e9.pdf')).toMatch(/^attachment; filename="a_b_\.pdf"; filename\*=UTF-8''a%22b%C3%A9\.pdf$/);
  });
});
```

`apps/web/src/lib/documents/exportErrors.ts`:

```typescript
// apps/web/src/lib/documents/exportErrors.ts
import { NextResponse } from "next/server";
import type { DocumentExportError } from "@ai-career/document-export";

const RESPONSES: Record<DocumentExportError["errorClass"], [number, string]> = {
  job_not_found: [404, "Job not found"],
  source_mismatch: [400, "That version does not belong to this job"],
  profile_changed: [409, "Your profile changed since this optimization. Regenerate it first."],
  pitch_unsupported: [409, "This pitch has an unsupported bullet. Edit or regenerate it first."],
  no_profile: [409, "Confirm your profile first"],
  storage_unavailable: [502, "Document storage is unavailable. Try again."],
  invalid_content: [500, "The document could not be generated."],
};

export function exportErrorResponse(error: DocumentExportError): NextResponse {
  const [status, message] = RESPONSES[error.errorClass];
  return NextResponse.json({ error: message }, { status });
}
```

`apps/web/src/lib/documents/listDocuments.ts`:

```typescript
// apps/web/src/lib/documents/listDocuments.ts
import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toDocumentView, type DocumentView } from "./serializeDocument";

const { generatedDocuments, resumeOptimizations, applicationPitches } = schema;

/** Call inside withUserContext. Newest first, with the source optimization/pitch version number. */
export async function listDocuments(tx: DbClient, jobId: string): Promise<DocumentView[]> {
  const rows = await tx
    .select({ doc: generatedDocuments, optVersion: resumeOptimizations.version, pitchVersion: applicationPitches.version })
    .from(generatedDocuments)
    .leftJoin(resumeOptimizations, eq(resumeOptimizations.id, generatedDocuments.resumeOptimizationId))
    .leftJoin(applicationPitches, eq(applicationPitches.id, generatedDocuments.applicationPitchId))
    .where(eq(generatedDocuments.jobId, jobId))
    .orderBy(desc(generatedDocuments.createdAt));
  return rows.map(({ doc, optVersion, pitchVersion }) => toDocumentView(doc, optVersion ?? pitchVersion ?? null));
}
```

Run `pnpm --filter web test -- serializeDocument` → PASS (3).

- [ ] **Step 3: Test seed helpers** — `apps/web/src/test/documentsDb.ts`:

```typescript
import type postgres from "postgres";
import { createDbClient, closeDbClient, withUserContext } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { createStorageClient, GENERATED_DOCUMENTS_BUCKET } from "@ai-career/storage";

const APP_URL = process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

/** Profile + one role/bullet + goal + job + a resume_optimizations row whose hash matches the current profile. */
export async function seedResumeExport(admin: postgres.Sql, userId: string): Promise<{ jobId: string; optimizationId: string }> {
  await admin`INSERT INTO candidate_profiles (user_id, full_name, email) VALUES (${userId}, 'Jane Doe', 'jane@example.com')`;
  const [exp] = await admin`INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${userId}, 'Globex', 'Engineer', 0) RETURNING id`;
  await admin`INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order) VALUES (${userId}, ${exp.id}, 'Built A', 0)`;
  const [goal] = await admin`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                             VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                            VALUES (${userId}, 'GitLab', 'gitlab', 'Backend Engineer', 'backend engineer', 'dh', now(), now()) RETURNING id`;
  const db = createDbClient({ DATABASE_URL: APP_URL });
  try {
    const { contentHash } = await withUserContext(db, userId, (tx) => buildResumeSnapshot(tx));
    const [opt] = await admin`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${userId}, ${job.id}, ${goal.id}, 2, ${contentHash}, '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    return { jobId: job.id as string, optimizationId: opt.id as string };
  } finally {
    await closeDbClient(db);
  }
}

/** Also removes this user's stored objects so test runs do not accumulate files in MinIO. */
export async function wipeDocumentsUser(admin: postgres.Sql, userId: string): Promise<void> {
  const storage = createStorageClient({
    MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
    MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
    MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
  });
  const keys = await admin`SELECT object_key FROM generated_documents WHERE user_id = ${userId}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await admin`DELETE FROM jobs WHERE user_id = ${userId}`;
  await admin`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await admin`DELETE FROM work_experience_bullets WHERE user_id = ${userId}`;
  await admin`DELETE FROM work_experiences WHERE user_id = ${userId}`;
  await admin`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}
```

(If `apps/web` does not list `@ai-career/resume-optimization` as a dependency it already does — it is used by Phase 6 routes. Confirm with `grep resume-optimization apps/web/package.json`.)

- [ ] **Step 4: Failing route tests**

All mock `loadEnv` with `DEFAULT_USER_ID` = the file's user, `DATABASE_URL` = test app URL, and MinIO: `MINIO_ENDPOINT: "http://localhost:9000", MINIO_ACCESS_KEY: "minioadmin", MINIO_SECRET_KEY: "minioadmin"`. Users: POST/GET `…da`, download `…dc` (grep first).

`apps/web/src/app/api/documents/route.test.ts`:

```typescript
// apps/web/src/app/api/documents/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../test/documentsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000da",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000da";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeDocumentsUser(admin, USER));
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await admin.end();
});

const { POST, GET } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/documents", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const list = (jobId: string) => GET(new Request(`http://localhost/api/documents?jobId=${jobId}`));

describe("POST /api/documents", () => {
  it("exports a resume PDF (201) and lists it with its source version", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toMatchObject({ kind: "resume", format: "pdf", sourceVersion: 2, downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(document.downloadUrl).toBe(`/api/documents/${document.id}/download`);

    const listed = await (await list(jobId)).json();
    expect(listed.documents.map((d: { id: string }) => d.id)).toEqual([document.id]);
  });

  it("returns 409 profile_changed with its message", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    await admin`INSERT INTO skills (user_id, name, display_order) VALUES (${USER}, 'Rust', 0)`;
    const res = await post({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/profile changed/i);
    await admin`DELETE FROM skills WHERE user_id = ${USER}`;
  });

  it("returns 400 for a bad body, bad JSON, or a source of another job; 404 for an unknown job", async () => {
    const { optimizationId } = await seedResumeExport(admin, USER);
    expect((await post({ kind: "cover", jobId: optimizationId, sourceId: optimizationId, format: "pdf" })).status).toBe(400);
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ kind: "resume", jobId: optimizationId, sourceId: optimizationId, format: "pdf", extra: 1 })).status).toBe(400);
    const [other] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                                VALUES (${USER}, 'Acme', 'acme', 'Dev', 'dev', 'dh2', now(), now()) RETURNING id`;
    expect((await post({ kind: "resume", jobId: other.id, sourceId: optimizationId, format: "pdf" })).status).toBe(400);
    expect((await post({ kind: "resume", jobId: "33333333-3333-3333-3333-333333333333", sourceId: optimizationId, format: "pdf" })).status).toBe(404);
  });
});

describe("GET /api/documents", () => {
  it("returns 404 for a missing or non-UUID jobId and an empty list for a job without documents", async () => {
    expect((await GET(new Request("http://localhost/api/documents"))).status).toBe(404);
    expect((await list("not-a-uuid")).status).toBe(404);
    const { jobId } = await seedResumeExport(admin, USER);
    expect(await (await list(jobId)).json()).toEqual({ documents: [] });
  });
});
```

`apps/web/src/app/api/documents/[id]/download/route.test.ts`:

```typescript
// apps/web/src/app/api/documents/[id]/download/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb } from "../../../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../../../test/documentsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000dc",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000dc";
const OTHER = "00000000-0000-0000-0000-0000000000dd";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeDocumentsUser(admin, USER);
  await wipeDocumentsUser(admin, OTHER);
});
afterAll(async () => {
  await wipeDocumentsUser(admin, USER);
  await wipeDocumentsUser(admin, OTHER);
  await admin.end();
});

const { POST } = await import("../../route");
const { GET } = await import("./route");
const download = (id: string) => GET(new Request(`http://localhost/api/documents/${id}/download`), { params: Promise.resolve({ id }) });

describe("GET /api/documents/[id]/download", () => {
  it("streams the stored PDF with safe download headers", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const created = await POST(new Request("http://localhost/api/documents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "resume", jobId, sourceId: optimizationId, format: "pdf" }),
    }));
    const { document } = await created.json();

    const res = await download(document.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Jane Doe - GitLab - Resume.pdf"; filename*=UTF-8''Jane%20Doe%20-%20GitLab%20-%20Resume.pdf`
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBe(document.byteSize);
  });

  it("returns 404 for a non-UUID id, an unknown id, and another user's document", async () => {
    expect((await download("nope")).status).toBe(404);
    expect((await download("33333333-3333-3333-3333-333333333333")).status).toBe(404);
    const [job] = await admin`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                              VALUES (${OTHER}, 'Acme', 'acme', 'Dev', 'dev', 'dh', now(), now()) RETURNING id`;
    const [doc] = await admin`INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
                              VALUES (${OTHER}, ${job.id}, 'resume', 'pdf', 'x/y.pdf', 10, 'h', '1', 'f.pdf') RETURNING id`;
    expect((await download(doc.id)).status).toBe(404);
  });
});
```

Run `pnpm --filter web test -- api/documents` → FAIL.

- [ ] **Step 5: Implement the routes**

`apps/web/src/app/api/documents/route.ts`:

```typescript
// apps/web/src/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import { exportPitch, exportResume, DocumentExportError } from "@ai-career/document-export";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { listDocuments } from "../../../lib/documents/listDocuments";
import { toDocumentView } from "../../../lib/documents/serializeDocument";
import { exportErrorResponse } from "../../../lib/documents/exportErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ExportBodySchema = z
  .object({
    kind: z.enum(["resume", "pitch"]),
    jobId: z.string().uuid(),
    sourceId: z.string().uuid(),
    format: z.enum(["pdf", "docx"]),
  })
  .strict();
const { resumeOptimizations, applicationPitches } = schema;

export async function POST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ExportBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const { kind, jobId, sourceId, format } = parsed.data;

  const env = loadEnv();
  const db = createDbClient(env);
  const storage = createStorageClient(env);
  try {
    const row =
      kind === "resume"
        ? await exportResume(db, storage, { userId: env.DEFAULT_USER_ID, jobId, optimizationId: sourceId, format })
        : await exportPitch(db, storage, { userId: env.DEFAULT_USER_ID, jobId, pitchId: sourceId, format });
    const [source] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      kind === "resume"
        ? tx.select({ version: resumeOptimizations.version }).from(resumeOptimizations).where(eq(resumeOptimizations.id, sourceId)).limit(1)
        : tx.select({ version: applicationPitches.version }).from(applicationPitches).where(eq(applicationPitches.id, sourceId)).limit(1)
    );
    return NextResponse.json({ document: toDocumentView(row, source?.version ?? null) }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentExportError) return exportErrorResponse(error);
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId || !UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const documents = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listDocuments(tx, jobId));
    return NextResponse.json({ documents });
  } finally {
    await closeDbClient(db);
  }
}
```

(Note: when de-duplication returns a row created for a different source version, `sourceVersion` reports the version the caller asked for; the list view reports the row's own source. Both are accurate descriptions of identical content.)

`apps/web/src/app/api/documents/[id]/download/route.ts`:

```typescript
// apps/web/src/app/api/documents/[id]/download/route.ts
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createStorageClient, getGeneratedDocument } from "@ai-career/storage";
import { CONTENT_TYPES, contentDisposition } from "../../../../../lib/documents/serializeDocument";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { generatedDocuments } = schema;

/** The row is looked up under RLS first, so a known id of another user's document is a plain 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [doc] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(generatedDocuments).where(eq(generatedDocuments.id, id)).limit(1)
    );
    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    let stream: Readable;
    try {
      stream = await getGeneratedDocument(createStorageClient(env), doc.objectKey);
    } catch {
      return NextResponse.json({ error: "Document storage is unavailable. Try again." }, { status: 502 });
    }
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[doc.format],
        "Content-Length": String(doc.byteSize),
        "Content-Disposition": contentDisposition(doc.downloadFilename),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 6: Run** — `pnpm --filter web test -- documents` → PASS (serializer 3, POST/GET 4, download 2). Then `pnpm --filter web build && pnpm --filter web typecheck && pnpm --filter web lint` → PASS.

- [ ] **Step 7: DECISIONS.md (expected D85)**

```markdown
### D85. Document routes: one POST for both kinds, RLS-first download streaming, pdfkit kept out of the Next bundle
**Decision:** `POST /api/documents` (strict body `{ kind, jobId, sourceId, format }`) maps `DocumentExportError` classes to fixed messages (404/400/409/502/500). `GET /api/documents/[id]/download` looks the row up under RLS before touching storage and streams the object with `Content-Type`, `Content-Length`, `Content-Disposition` (ASCII `filename` + RFC 5987 `filename*`), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. `apps/web/next.config.ts` lists `pdfkit` in `serverExternalPackages` (and `apps/web` depends on it) because pdfkit reads its `.afm` metric files from disk at runtime.
**Why:** One endpoint keeps the UI simple; RLS-first lookup means an id is never enough to read someone else's file; the headers prevent sniffing/caching of personal documents.
**Alternatives considered:** Pre-signed MinIO URLs (rejected: exposes the storage host to the browser and bypasses RLS at download time).
**What it affects:** `apps/web/src/app/api/documents/**`, `apps/web/src/lib/documents/*`, `apps/web/next.config.ts`.
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/next.config.ts apps/web/src/lib/documents apps/web/src/app/api/documents apps/web/src/test/documentsDb.ts DECISIONS.md
git commit -m "feat(web): document export, list and download routes"
```

---
## Task 12: UI — download buttons and documents list

**Files:**
- Create: `apps/web/src/app/matches/[jobId]/DownloadButtons.tsx` + `DownloadButtons.test.tsx`
- Create: `apps/web/src/app/matches/[jobId]/DocumentsList.tsx` + `DocumentsList.test.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/ResumeOptimizationPanel.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/PitchPanel.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx` + `MatchDetailClient.test.tsx`

**Interfaces:**
- Consumes: `POST /api/documents`, `GET /api/documents?jobId=` (Task 11), `DocumentView` shape (redeclared locally — client components never import server packages).
- Produces: `DownloadButtons({ jobId, kind, sourceId, disabled?, navigate? })`, `DOCUMENTS_CHANGED_EVENT = "documents:changed"`, `DocumentsList({ jobId })`.

- [ ] **Step 1: Failing tests**

`DownloadButtons.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DownloadButtons, DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

beforeEach(() => vi.unstubAllGlobals());

function mockPost(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("DownloadButtons", () => {
  it("POSTs the export, announces the change, then navigates to the download URL", async () => {
    const fetchMock = mockPost(201, { document: { downloadUrl: "/api/documents/d1/download" } });
    const navigate = vi.fn();
    const changed = vi.fn();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, changed);
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/api/documents/d1/download"));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: "resume", jobId: "j1", sourceId: "o1", format: "pdf" });
    expect(changed).toHaveBeenCalled();
    window.removeEventListener(DOCUMENTS_CHANGED_EVENT, changed);
  });

  it("sends format docx for the DOCX button", async () => {
    const fetchMock = mockPost(201, { document: { downloadUrl: "/x" } });
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" navigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Download DOCX" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ kind: "pitch", format: "docx" });
  });

  it("shows the server's message on an error and does not navigate", async () => {
    mockPost(409, { error: "Your profile changed since this optimization. Regenerate it first." });
    const navigate = vi.fn();
    render(<DownloadButtons jobId="j1" kind="resume" sourceId="o1" navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your profile changed since this optimization");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("disables both buttons when disabled", () => {
    render(<DownloadButtons jobId="j1" kind="pitch" sourceId="p1" disabled navigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download DOCX" })).toBeDisabled();
  });
});
```

`DocumentsList.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { DocumentsList } from "./DocumentsList";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

const doc = { id: "d1", kind: "resume", format: "pdf", sourceVersion: 3, downloadFilename: "Jane - Acme - Resume.pdf",
  byteSize: 1000, createdAt: "2026-09-24T00:00:00Z", downloadUrl: "/api/documents/d1/download" };

beforeEach(() => vi.unstubAllGlobals());

describe("DocumentsList", () => {
  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [] }) } as Response));
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/no documents exported yet/i)).toBeInTheDocument();
  });

  it("lists documents with kind, version, format and a download link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents: [doc] }) } as Response));
    render(<DocumentsList jobId="j1" />);
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", "/api/documents/d1/download");
  });

  it("reloads when a documents-changed event fires", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ documents: [doc] }) } as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(<DocumentsList jobId="j1" />);
    await screen.findByText(/no documents exported yet/i);
    act(() => { window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT)); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Resume v3 · PDF/)).toBeInTheDocument();
  });
});
```

Run `pnpm --filter web test -- DownloadButtons DocumentsList` → FAIL.

- [ ] **Step 2: Implement `DownloadButtons.tsx`**

```tsx
"use client";

import { useState } from "react";

export const DOCUMENTS_CHANGED_EVENT = "documents:changed";

type Format = "pdf" | "docx";

export function DownloadButtons({
  jobId,
  kind,
  sourceId,
  disabled = false,
  navigate = (url: string) => window.location.assign(url),
}: {
  jobId: string;
  kind: "resume" | "pitch";
  sourceId: string;
  disabled?: boolean;
  navigate?: (url: string) => void;
}) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAs = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, jobId, sourceId, format }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not export the document.");
        return;
      }
      window.dispatchEvent(new Event(DOCUMENTS_CHANGED_EVENT));
      navigate(body.document.downloadUrl as string);
    } catch {
      setError("Could not export the document.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {(["pdf", "docx"] as const).map((format) => (
          <button
            key={format}
            type="button"
            onClick={() => exportAs(format)}
            disabled={disabled || busy !== null}
            className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {busy === format ? "Exporting..." : `Download ${format.toUpperCase()}`}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

Note: while exporting, the busy button's label becomes "Exporting…", so tests query by the idle labels before clicking.

- [ ] **Step 3: Implement `DocumentsList.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { DOCUMENTS_CHANGED_EVENT } from "./DownloadButtons";

interface DocumentView {
  id: string;
  kind: "resume" | "pitch";
  format: "pdf" | "docx";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
}

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; documents: DocumentView[] };

export function DocumentsList({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let ignore = false;
    // Promise chain (state set in callbacks), matching the other panels' react-hooks/set-state-in-effect pattern.
    const load = () =>
      fetch(`/api/documents?jobId=${encodeURIComponent(jobId)}`)
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body) => {
          if (!ignore) setState({ kind: "ready", documents: body.documents as DocumentView[] });
        })
        .catch(() => {
          if (!ignore) setState({ kind: "error" });
        });
    load();
    window.addEventListener(DOCUMENTS_CHANGED_EVENT, load);
    return () => {
      ignore = true;
      window.removeEventListener(DOCUMENTS_CHANGED_EVENT, load);
    };
  }, [jobId]);

  return (
    <section aria-labelledby="documents-heading" className="flex flex-col gap-2">
      <h2 id="documents-heading" className="font-medium">Documents</h2>
      {state.kind === "loading" && <p className="text-sm text-gray-600">Loading documents...</p>}
      {state.kind === "error" && <p role="alert" className="text-sm text-red-600">Could not load documents.</p>}
      {state.kind === "ready" && state.documents.length === 0 && (
        <p className="text-sm text-gray-600">No documents exported yet.</p>
      )}
      {state.kind === "ready" && state.documents.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {state.documents.map((d) => (
            <li key={d.id}>
              {d.kind === "resume" ? "Resume" : "Pitch"} v{d.sourceVersion ?? "?"} · {d.format.toUpperCase()} ·{" "}
              {new Date(d.createdAt).toLocaleString()} ·{" "}
              <a href={d.downloadUrl} className="underline">Download</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Wire into the panels**

`ResumeOptimizationPanel.tsx`: add `import { DownloadButtons } from "./DownloadButtons";` and, as the first child inside the `{selected && ( <> … </> )}` fragment (before the review-needed banner), insert:

```tsx
          <DownloadButtons jobId={jobId} kind="resume" sourceId={selected.id} />
```

`PitchPanel.tsx`: add the same import and, inside the `selected && draft === null` action row, directly after the Copy button and its "Copied" span, insert:

```tsx
            <DownloadButtons jobId={jobId} kind="pitch" sourceId={selected.id} disabled={busy !== null} />
```

`MatchDetailClient.tsx`: add `import { DocumentsList } from "./DocumentsList";` and directly after `{match.eligible && <PitchPanel jobId={jobId} />}` insert `{match.eligible && <DocumentsList jobId={jobId} />}`.

`MatchDetailClient.test.tsx`: inside `mockFetch`'s implementation, after the `/api/application-pitches/` branch, add:

```typescript
      if (url.includes("/api/documents")) {
        return { ok: true, status: 200, json: async () => ({ documents: [] }) } as Response;
      }
```

- [ ] **Step 5: Run** — `pnpm --filter web test && pnpm --filter web lint && pnpm --filter web build && pnpm --filter web typecheck` → PASS; existing `ResumeOptimizationPanel`, `PitchPanel`, `MatchDetailClient` tests unchanged and green (their fetch mocks are sequences consumed on mount; `DownloadButtons` does not fetch on mount).

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/matches/[jobId]"
git commit -m "feat(web): PDF/DOCX download buttons and documents list on the match page"
```

---

## Task 13: Documentation, parity check, full verification, end-to-end run

**Files:**
- Modify: `FLOW.md` (new §10), `docs/architecture.md` (status line, §8 table list, new §15), `README.md` (status)

- [ ] **Step 1: FLOW.md §10** — append:

```markdown
## 10. Phase 7b — Document Export & Storage

"Download PDF/DOCX" in `ResumeOptimizationPanel` / `PitchPanel` (`apps/web/src/app/matches/[jobId]/DownloadButtons.tsx`)
  -> `POST /api/documents` { kind, jobId, sourceId, format } (`apps/web/src/app/api/documents/route.ts`)
  -> `exportResume` / `exportPitch` (`packages/document-export/src/pipeline/`)
     1. job exists (404); the optimization/pitch belongs to the job (400 source_mismatch).
     2. resume: current `buildResumeSnapshot` hash must equal `resume_optimizations.source_profile_content_hash`
        (409 profile_changed); pitch: a `generated` version with any `supported === false` bullet → 409 pitch_unsupported.
     3. profile via `loadResumeProfile` (409 no_profile; street address never read).
     4. `buildResumeModel` / `buildPitchModel` → `DocumentModel` (pure; merge rules in D82).
     5. `storeDocument`: `assertSafeModel` → `modelContentHash` → reuse an existing (kind, format, hash) row, else
        `renderDocument` (pdfkit / docx) → `uploadGeneratedDocument` (MinIO `generated-documents`, outside any
        transaction) → INSERT … ON CONFLICT DO NOTHING (loser deletes its upload, returns the winner).
  -> 201 `{ document }`; the button dispatches `documents:changed` (DocumentsList reloads) and navigates to
     `GET /api/documents/[id]/download`, which finds the row under RLS and streams the object with attachment headers.

Changing layout: `packages/document-export/src/render/*` — bump `RENDERER_VERSION`. Changing what a resume contains:
`model/buildResumeModel.ts` only. Changing fonts: `pnpm --filter @ai-career/document-export embed-fonts`.
```

- [ ] **Step 2: architecture.md** — status line: "Phases 0–6, 7a and 7b are implemented (…, company research + Hiring Manager Pitch, document export); interview prep / cover letter (7c) onward is designed but not yet built." In §8's "Everything else … follows spec §19" sentence, add that `generated_documents` is described in §15 / D81. Append:

~~~markdown
## 15. Document Export & Storage (Phase 7b)

```
profile rows + one resume_optimizations version   |   one application_pitches version
  │ buildResumeModel (pure, D82)                   │ buildPitchModel (pure)
  ▼                                                ▼
DocumentModel ──► storeDocument: hash → reuse | renderPdf (pdfkit + embedded Noto Sans) / renderDocx (docx)
                                 → MinIO "generated-documents" → generated_documents row (RLS)
```

- **Package boundary.** `packages/document-export` (`model/`, `render/`, `pipeline/`), used by `/api/documents` routes and the match page's download buttons and documents list. No LLM calls.
- **Guarantees.** Documents contain only stored profile text and guard-applied rewordings; education/certifications/skill names never reworded; no street address (D82). Export refused when the profile changed since the optimization or a generated pitch has an unsupported bullet (D84).
- **Machine readability.** Single column, real text, no images/tables; every renderer test extracts the text back with the same parsers used for uploads (D83).
- **Storage.** Generated keys, RLS-first download, attachment + nosniff + no-store headers (D85); identical exports de-duplicated by content hash (D81).
- **Known gaps.** Deleting a job leaves its MinIO objects (Phase 9 retention); plain visual design; no templates.
- Rationale: `docs/superpowers/specs/2026-09-24-phase-7b-document-export-design.md`, DECISIONS.md D81–D85.
~~~

- [ ] **Step 3: README** — after the Phase 7a paragraph add:

```markdown
Phase 7b (Document Export) complete: on a match page, the selected optimized
resume or pitch version downloads as PDF or DOCX (single-column, ATS-readable,
Unicode font embedded). Files are stored in MinIO and listed under "Documents";
export is refused if your profile changed since the optimization or a generated
pitch still has an unsupported bullet.
```

- [ ] **Step 4: Parity check** — each must print the expected evidence:

```bash
grep -n "generated_documents" packages/db/src/generatedDocumentsTable.rls.test.ts | head -2
grep -rn "DocumentExportError" apps/web/src/lib/documents/exportErrors.ts | head -1
grep -rn "pg_advisory_lock" packages/document-export/src/testing/db.ts
grep -rn "from \"@ai-career/ingestion\"" packages/document-export apps/web/src/lib/documents    # must print nothing
grep -n "serverExternalPackages" apps/web/next.config.ts
grep -n "^## 10\." FLOW.md; grep -n "^## 15\." docs/architecture.md; grep -n "Phase 7b" README.md
```

- [ ] **Step 5: Full verification** — `pnpm install --frozen-lockfile && pnpm lint && pnpm --filter web build && pnpm typecheck && pnpm turbo run test --force --env-mode=loose` (run the test suite twice). Any failure in a file this phase did not touch: grep the new test ids (`…d8 d9 da dc dd de df`) across the repo and check for GRANT/migration races before re-running.

- [ ] **Step 6: End-to-end in the real app (this is the pdfkit-bundling check)** — against the **test** DB with a synthetic user (`00000000-0000-0000-0000-0000000000e8`, grep first), never the dev DB:
  1. Seed via psql into `career_intel_test`: profile (with an address_line1 value), one role with 3 bullets incl. a non-ASCII word ("Zürich"), skills, a confirmed goal, a job at "GitLab", an eligible `job_matches` row, a `resume_optimizations` row whose `source_profile_content_hash` equals the current snapshot hash (compute it with a tiny tsx script calling `buildResumeSnapshot` under `withUserContext`) and whose `selected_bullets` rewords one bullet, and a `user_edited` `application_pitches` row.
  2. `pnpm --filter web build`, then start with `DATABASE_URL=<test app url> DEFAULT_USER_ID=<synthetic> PORT=3100 pnpm --filter web start`.
  3. With real Chrome via playwright-core installed outside the repo: open `/matches/<jobId>`, click Download PDF and Download DOCX on the resume panel and on the pitch panel; capture each download (Playwright `page.waitForEvent("download")`), confirm the filename, and extract its text with `extractText` from `@ai-career/ai` (a tsx script) — the reworded bullet precedes the others, "Zürich" survives, the street address is absent.
  4. The Documents list shows 4 entries; clicking a link downloads the same bytes; a second identical export does not add a row.
  5. Add a skill to the profile, click Download PDF on the resume panel → the 409 message appears.
  6. Server stdout has no document content and no errors.
  7. Cleanup: stop the server, delete the synthetic user's rows and MinIO objects (`{userId}/` prefix in `generated-documents`), remove the temp Playwright dir; `git status --short` empty.

  If any step fails, report it precisely rather than working around it. If the pdfkit download fails under `next start` with an ENOENT on a `.afm` file, the `serverExternalPackages` entry is not taking effect — report it.

- [ ] **Step 7: Commit**

```bash
git add FLOW.md docs/architecture.md README.md
git commit -m "docs: trace Phase 7b in FLOW.md, architecture.md and README"
```
