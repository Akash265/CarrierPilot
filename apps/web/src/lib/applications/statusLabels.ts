export const STATUS_LABELS: Record<string, string> = {
  applied: "Applied",
  screening: "Screening",
  interviewing: "Interviewing",
  offer: "Offer",
  accepted: "Accepted",
  declined: "Declined",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  no_response: "No response",
};
export const STATUS_ORDER = Object.keys(STATUS_LABELS);
export const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(["accepted", "declined", "rejected", "withdrawn", "no_response"]);
