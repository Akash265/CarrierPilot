"use client";

export interface EvidenceView {
  id: string;
  kind: "research" | "requirement" | "profile";
  text: string;
  sourceUrl: string | null;
}

const EVIDENCE_LABELS: Record<EvidenceView["kind"], string> = {
  research: "Company research",
  requirement: "Job requirement",
  profile: "Your profile",
};

/** Evidence URLs come from the web: only http(s) may ever become a link (the server also enforces this). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Shared by the pitch, cover letter and interview prep panels. */
export function EvidenceList({ evidence }: { evidence: EvidenceView[] }) {
  if (evidence.length === 0) return null;
  return (
    <details className="mt-1 text-xs text-gray-600">
      <summary>Evidence ({evidence.length})</summary>
      <ul className="ml-4 list-disc">
        {evidence.map((e) => (
          <li key={e.id}>
            {EVIDENCE_LABELS[e.kind]}: {e.text}
            {e.sourceUrl && isHttpUrl(e.sourceUrl) && (
              <>
                {" "}
                <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                  source
                </a>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
