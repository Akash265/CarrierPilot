import type { InsightEvent, InsightGoal, InsightInputs, OutcomeRecord } from "../types";
import { labelOutcome } from "./labels";
import { parseSnapshot, type ParsedSnapshot } from "./parseSnapshot";
import { OTHER_FAMILY, pickGoal, roleFamilyKey, roleLabels } from "./roleFamily";

/** Spec §4.4: job salaries are stored annualized, and the goal's floor is annual. Currency must match (D6: never convert). */
export function salaryVsFloor(snapshot: ParsedSnapshot, goal: InsightGoal | null): "below" | "at_or_above" | null {
  if (goal === null || !goal.salaryIsParsed || goal.salaryFloorNormalized === null || goal.salaryCurrency === null) return null;
  const figure = snapshot.salaryMax ?? snapshot.salaryMin;
  if (figure === null || snapshot.salaryCurrency === null) return null;
  if (snapshot.salaryCurrency.toUpperCase() !== goal.salaryCurrency.toUpperCase()) return null;
  return figure < goal.salaryFloorNormalized ? "below" : "at_or_above";
}

const companyKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Spec §4. Pure: one record per application, most recently applied first (so the first record of a company
 * or role carries its most recent spelling). Never throws on a malformed snapshot.
 */
export function buildOutcomeDataset(inputs: InsightInputs, opts: { now: Date; undecidedDays: number }): OutcomeRecord[] {
  const eventsByApplication = new Map<string, InsightEvent[]>();
  for (const e of inputs.events) {
    const list = eventsByApplication.get(e.applicationId) ?? [];
    list.push(e);
    eventsByApplication.set(e.applicationId, list);
  }
  const labels = roleLabels(inputs.goals);
  const ordered = [...inputs.applications].sort(
    (a, b) => b.appliedAt.localeCompare(a.appliedAt) || b.createdAt.getTime() - a.createdAt.getTime()
  );

  return ordered.map((application): OutcomeRecord => {
    const snapshot = parseSnapshot(application.featureSnapshot);
    const outcome = labelOutcome(
      { status: application.status, appliedAt: application.appliedAt, events: eventsByApplication.get(application.id) ?? [] },
      opts
    );
    const goal = pickGoal(application.createdAt, snapshot.careerGoalId, inputs.goals);
    const familyKey = roleFamilyKey(application.jobTitle, goal);
    return {
      applicationId: application.id,
      external: snapshot.external,
      appliedAt: application.appliedAt,
      response: outcome.response,
      interview: outcome.interview,
      roleFamily: familyKey === OTHER_FAMILY.key ? { ...OTHER_FAMILY } : { key: familyKey, label: labels.get(familyKey) ?? familyKey },
      company: { key: companyKey(application.companyName), label: application.companyName.trim().replace(/\s+/g, " ") },
      workMode: snapshot.workMode,
      countryCode: snapshot.countryCode,
      salaryVsFloor: salaryVsFloor(snapshot, goal),
      matchScore: snapshot.matchScore,
      atsScore: snapshot.atsScore,
      requiredKeywordCoverage: snapshot.requiredKeywordCoverage,
      postingAgeDays: snapshot.postingAgeDays,
      documents: snapshot.documents,
      missedRequiredTerms: snapshot.missedRequiredTerms,
    };
  });
}
