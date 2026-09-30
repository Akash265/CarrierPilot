/**
 * Client-side view types shared by the pitch, cover letter and interview prep panels (EvidenceView lives
 * next to EvidenceList, which renders it). They mirror the JSON the API routes return.
 */

/** A research snapshot's outcome, as stored on every generated document. */
export type ResearchStatus = "ok" | "no_results" | "failed";

/** The current company research returned next to the versions (PitchPanel shows its age). */
export interface ResearchView {
  id: string;
  companyName: string;
  status: ResearchStatus;
  researchedAt: string;
  searchCount: number;
}
