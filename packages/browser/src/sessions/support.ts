import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { resolveAutofillTarget, type UnsupportedReason } from "../adapters/resolveAutofillTarget";
import type { Portal } from "../types";

const { jobPostings, jobSources } = schema;

export type AutofillSupport =
  | { supported: true; portal: Portal; adapterVersion: string; formUrl: string }
  | { supported: false; reason: UnsupportedReason };

/** Call inside withUserContext. */
export async function getAutofillSupport(tx: DbClient, jobId: string): Promise<AutofillSupport> {
  const rows = await tx
    .select({ kind: jobSources.kind, config: jobSources.config, externalId: jobPostings.externalId, status: jobPostings.status, lastSeenAt: jobPostings.lastSeenAt })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobSources.id, jobPostings.sourceId))
    .where(eq(jobPostings.jobId, jobId));
  const target = resolveAutofillTarget(
    rows.map((r) => ({ sourceKind: r.kind, slug: r.config.slug ?? null, externalId: r.externalId, status: r.status, lastSeenAt: r.lastSeenAt }))
  );
  return target.supported
    ? { supported: true, portal: target.adapter.portal, adapterVersion: target.adapter.version, formUrl: target.formUrl }
    : target;
}
