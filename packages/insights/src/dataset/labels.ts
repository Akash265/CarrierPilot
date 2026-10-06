import type { ApplicationStatus, InsightEvent, TierOutcome } from "../types";

const MS_PER_DAY = 86_400_000;

/** Spec §4.1. Endings (rejected, withdrawn, no_response) are not stages. */
const STAGE: Partial<Record<ApplicationStatus, number>> = {
  applied: 0, screening: 1, interviewing: 2, offer: 3, accepted: 4, declined: 4,
};
const RESPONSE_STAGE = 1;
const INTERVIEW_STAGE = 2;
const REACHED_TEXT: Partial<Record<ApplicationStatus, string>> = {
  screening: "screening", interviewing: "interviewing", offer: "an offer", accepted: "an accepted offer", declined: "a declined offer",
};
const ACTIVITY_TYPES = new Set(["status_change", "recruiter_contact", "interview"]);

export interface LabelInput {
  status: ApplicationStatus;
  /** YYYY-MM-DD. */
  appliedAt: string;
  /** This application's events. Types other than the three activity types are ignored. */
  events: readonly InsightEvent[];
}

export interface LabelOptions {
  now: Date;
  undecidedDays: number;
}

export interface LabelResult {
  response: TierOutcome;
  interview: TierOutcome;
  lastActivityAt: Date;
}

interface Evidence {
  /** null for evidence that only the current status provides (no dated event). */
  at: Date | null;
  text: string;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const stageOf = (status: ApplicationStatus | null): number => (status === null ? -1 : (STAGE[status] ?? -1));

function stageEvidence(input: LabelInput, minStage: number): Evidence[] {
  const found: Evidence[] = [];
  for (const e of input.events) {
    if (e.type === "status_change" && e.toStatus !== null && stageOf(e.toStatus) >= minStage) {
      found.push({ at: e.occurredAt, text: `reached ${REACHED_TEXT[e.toStatus]} on ${day(e.occurredAt)}` });
    }
  }
  if (stageOf(input.status) >= minStage) found.push({ at: null, text: `status is ${input.status}` });
  return found;
}

/** Dated evidence wins over undated (current-status) evidence; among dated, the earliest. */
function earliest(list: Evidence[]): Evidence | null {
  let best: Evidence | null = null;
  for (const e of list) {
    if (best === null || (e.at !== null && (best.at === null || e.at < best.at))) best = e;
  }
  return best;
}

function decide(
  words: { positive: string; negative: string },
  evidence: Evidence[],
  input: LabelInput,
  lastActivityMs: number,
  opts: LabelOptions
): TierOutcome {
  const found = earliest(evidence);
  if (found) return { label: "positive", reason: `${words.positive}: ${found.text}` };
  if (input.status === "withdrawn") return { label: "excluded", reason: "Excluded: withdrawn" };
  if (input.status === "rejected") return { label: "negative", reason: `${words.negative}: rejected` };
  if (input.status === "no_response") return { label: "negative", reason: `${words.negative}: marked no response` };
  // accepted/declined always carry stage evidence, so only open statuses reach the idle rule.
  if (opts.now.getTime() - lastActivityMs >= opts.undecidedDays * MS_PER_DAY) {
    return { label: "negative", reason: `${words.negative}: no activity for ${opts.undecidedDays} days` };
  }
  return { label: "undecided", reason: `Undecided: last activity on ${day(new Date(lastActivityMs))}` };
}

/**
 * Spec §4.1-4.2. Labels come from the furthest stage ever reached (status_change history) plus logged
 * recruiter-contact/interview events -- not just the current status -- so screening -> rejected still
 * counts as a response. Evidence always wins; withdrawn is excluded, never negative.
 */
export function labelOutcome(input: LabelInput, opts: LabelOptions): LabelResult {
  const events = input.events.filter((e) => ACTIVITY_TYPES.has(e.type));
  const scoped: LabelInput = { ...input, events };

  let lastActivityMs = Date.parse(`${input.appliedAt}T00:00:00Z`);
  for (const e of events) lastActivityMs = Math.max(lastActivityMs, e.occurredAt.getTime());

  const contacts: Evidence[] = events
    .filter((e) => e.type === "recruiter_contact")
    .map((e) => ({ at: e.occurredAt, text: `recruiter contact on ${day(e.occurredAt)}` }));
  const interviews: Evidence[] = events
    .filter((e) => e.type === "interview")
    .map((e) => ({ at: e.occurredAt, text: `interview logged for ${day(e.occurredAt)}` }));

  return {
    response: decide(
      { positive: "Response", negative: "No response" },
      [...stageEvidence(scoped, RESPONSE_STAGE), ...contacts, ...interviews], scoped, lastActivityMs, opts
    ),
    interview: decide(
      { positive: "Interview", negative: "No interview" },
      [...stageEvidence(scoped, INTERVIEW_STAGE), ...interviews], scoped, lastActivityMs, opts
    ),
    lastActivityAt: new Date(lastActivityMs),
  };
}
