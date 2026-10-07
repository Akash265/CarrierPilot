/** Phase 11b design §5.4 display helpers for /status. */

/** "12 s ago", "3 min ago", "2 h ago", "3 d ago" (floored), "—" without a time; a slightly-future clock shows 0 s. */
export function lastSeen(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  if (ms < 60_000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

/** "YYYY-MM-DD HH:MM" in UTC, or "—". */
export function utcMinute(iso: string | null): string {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "—";
}

const WORKER_LABELS: Record<string, string> = {
  "job-ingestion": "Job ingestion",
  matching: "Matching",
  maintenance: "Maintenance",
  browser: "Browser autofill",
};

export const workerLabel = (worker: string): string => WORKER_LABELS[worker] ?? worker;
