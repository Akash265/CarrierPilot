import type { DbClient } from "./client";
import { withUserContext } from "./rls";
import { candidateProfiles } from "./schema/candidateProfiles";

/**
 * D9 / Phase 11b design §3.4: the user's identifying profile values that log lines must never contain. Read under
 * RLS; a missing profile or null fields simply contribute nothing.
 */
export async function loadRedactionValues(db: DbClient, userId: string): Promise<string[]> {
  const rows = await withUserContext(db, userId, (tx) =>
    tx
      .select({
        fullName: candidateProfiles.fullName,
        email: candidateProfiles.email,
        phoneNumber: candidateProfiles.phoneNumber,
        addressLine1: candidateProfiles.addressLine1,
        linkedinUrl: candidateProfiles.linkedinUrl,
      })
      .from(candidateProfiles)
      .limit(1)
  );
  const row = rows[0];
  if (!row) return [];
  return [row.fullName, row.email, row.phoneNumber, row.addressLine1, row.linkedinUrl].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );
}
