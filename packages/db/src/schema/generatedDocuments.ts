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
 * (user_id, job_id, kind, format, content_hash) de-duplicates identical exports and is the concurrency
 * backstop. job_id is part of the key (not just an FK) because the resume/pitch model carries nothing
 * job-specific -- without it, exporting for job B could return job A's row (D84).
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
    userJobKindFormatHashUniq: uniqueIndex("generated_documents_user_job_kind_format_hash_uniq").on(t.userId, t.jobId, t.kind, t.format, t.contentHash),
    jobIdIdx: index("generated_documents_job_id_idx").on(t.jobId),
    byteSizePositive: check("generated_documents_byte_size_positive", sql`${t.byteSize} > 0`),
    sourceMatchesKind: check(
      "generated_documents_source_matches_kind",
      sql`(${t.kind} = 'resume' AND ${t.applicationPitchId} IS NULL) OR (${t.kind} = 'pitch' AND ${t.resumeOptimizationId} IS NULL)`
    ),
  })
);
