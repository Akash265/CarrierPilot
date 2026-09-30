const MS_PER_DAY = 86_400_000;

/** An upload whose DB row may not be committed yet must not be swept (design §4.5). */
export const ORPHAN_MIN_AGE_MS = MS_PER_DAY;

export interface RetentionCandidate {
  id: string;
  jobId: string | null;
  terminalAt: Date | null;
  retentionPurgedAt: Date | null;
}

export interface StoredObject {
  key: string;
  lastModified: Date;
}

/**
 * Due when: enabled, the application has a job (external ones have no generated data), it has been
 * terminal for at least `retentionDays`, and it has not been purged since that terminal_at. A
 * reopen-then-close sets a later terminal_at, so it becomes due again.
 */
export function isDueForPurge(candidate: RetentionCandidate, now: Date, retentionDays: number): boolean {
  if (retentionDays <= 0 || candidate.jobId === null || candidate.terminalAt === null) return false;
  if (candidate.terminalAt.getTime() > now.getTime() - retentionDays * MS_PER_DAY) return false;
  return candidate.retentionPurgedAt === null || candidate.retentionPurgedAt.getTime() < candidate.terminalAt.getTime();
}

export function planRetention(input: { candidates: RetentionCandidate[]; now: Date; retentionDays: number }): RetentionCandidate[] {
  return input.candidates.filter((c) => isDueForPurge(c, input.now, input.retentionDays));
}

export function planOrphanSweep(input: {
  objects: StoredObject[];
  referencedKeys: ReadonlySet<string>;
  now: Date;
  minAgeMs?: number;
}): string[] {
  const minAgeMs = input.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  return input.objects
    .filter((o) => !input.referencedKeys.has(o.key) && input.now.getTime() - o.lastModified.getTime() >= minAgeMs)
    .map((o) => o.key);
}
