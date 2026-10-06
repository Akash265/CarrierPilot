import type { ResponsePrediction } from "@ai-career/insights";

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** "likely response 35% (22–50%)" -- Phase 10b spec §6 wording: always "likely", always with the range. */
export function formatLikelyResponse(p: ResponsePrediction): string {
  return `likely response ${pct(p.probability)} (${Math.round(p.low * 100)}–${pct(p.high)})`;
}

/** "Raises: Skills, Role · Lowers: Freshness", omitting an empty side; "" when nothing stands out. */
export function formatFactorPushes(p: ResponsePrediction): string {
  const parts: string[] = [];
  if (p.raises.length > 0) parts.push(`Raises: ${p.raises.join(", ")}`);
  if (p.lowers.length > 0) parts.push(`Lowers: ${p.lowers.join(", ")}`);
  return parts.join(" · ");
}

/** Why the "Rank with my history" toggle is unavailable, or null when the model is active. */
export function modelUnavailableReason(model: {
  status: "insufficient_data" | "no_pattern" | "active";
  decided: number;
  responses: number;
  minDecided: number;
  minPerClass: number;
}): string | null {
  if (model.status === "active") return null;
  if (model.status === "no_pattern") return "Your history doesn't show a pattern that beats your average yet.";
  return `Needs ${model.minDecided} decided applications with at least ${model.minPerClass} responses and ${model.minPerClass} without. You have ${model.decided} (${model.responses} with a response).`;
}
