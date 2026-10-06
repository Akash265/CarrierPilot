import { scoreRole } from "@ai-career/matching/scoring";
import type { InsightGoal } from "../types";

export const OTHER_FAMILY = { key: "__other__", label: "Other" } as const;
export const ROLE_MATCH_THRESHOLD = 0.5;

/** Merges the same role written with different casing/spacing across goal versions (spec §4.3). */
export const roleKey = (role: string): string => role.trim().toLowerCase().replace(/\s+/g, " ");
/** scoreRole treats a role with no word characters as a neutral 0.5; such a role must never win. */
const hasWord = (role: string): boolean => /[a-z0-9]/i.test(role);

/** Spec §4.3 step 1: the match's goal, else the goal confirmed most recently before the application was created. */
export function pickGoal(createdAt: Date, snapshotGoalId: string | null, goals: readonly InsightGoal[]): InsightGoal | null {
  if (snapshotGoalId !== null) {
    const fromMatch = goals.find((g) => g.id === snapshotGoalId);
    if (fromMatch) return fromMatch;
  }
  let best: InsightGoal | null = null;
  for (const g of goals) {
    if (g.confirmedAt === null || g.confirmedAt > createdAt) continue;
    if (best === null || g.confirmedAt > (best.confirmedAt as Date)) best = g;
  }
  return best;
}

/** Spec §4.3 step 2: the best-scoring target role (first wins a tie) if it reaches the threshold, else Other. */
export function roleFamilyKey(jobTitle: string, goal: InsightGoal | null): string {
  if (goal === null || !hasWord(jobTitle)) return OTHER_FAMILY.key;
  let bestKey: string | null = null;
  let bestScore = -1;
  for (const role of goal.targetRoles) {
    if (!hasWord(role)) continue;
    const score = scoreRole([role], jobTitle);
    if (score > bestScore) {
      bestScore = score;
      bestKey = roleKey(role);
    }
  }
  return bestKey !== null && bestScore >= ROLE_MATCH_THRESHOLD ? bestKey : OTHER_FAMILY.key;
}

/** Role key -> display text, from the most recently confirmed goal that lists the role. */
export function roleLabels(goals: readonly InsightGoal[]): Map<string, string> {
  const oldestFirst = [...goals].sort((a, b) => (a.confirmedAt?.getTime() ?? 0) - (b.confirmedAt?.getTime() ?? 0));
  const labels = new Map<string, string>();
  for (const g of oldestFirst) {
    for (const role of g.targetRoles) if (hasWord(role)) labels.set(roleKey(role), role.trim().replace(/\s+/g, " "));
  }
  return labels;
}
