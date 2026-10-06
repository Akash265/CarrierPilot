import { describe, it, expect } from "vitest";
import { OTHER_FAMILY, pickGoal, roleFamilyKey, roleLabels } from "./roleFamily";
import type { InsightGoal } from "../types";

const goal = (over: Partial<InsightGoal>): InsightGoal => ({
  id: "g1", confirmedAt: new Date("2026-09-01T00:00:00Z"), targetRoles: [], salaryFloorNormalized: null, salaryCurrency: null,
  salaryIsParsed: false, ...over,
});

describe("roleFamilyKey", () => {
  it("picks the best-matching target role", () => {
    const g = goal({ targetRoles: ["Data Analyst", "Data Engineer"] });
    expect(roleFamilyKey("Senior Data Engineer II", g)).toBe("data engineer");
  });

  it("breaks a tie in favour of the first listed role", () => {
    const g = goal({ targetRoles: ["Data Analyst", "Data Engineer"] });
    expect(roleFamilyKey("Data Person", g)).toBe("data analyst");
  });

  it("is Other below the 0.5 threshold, with no goal, or with no usable roles", () => {
    expect(roleFamilyKey("Head of Marketing Operations", goal({ targetRoles: ["Data Engineer"] }))).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", null)).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: [] }))).toBe(OTHER_FAMILY.key);
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: ["—", "  "] }))).toBe(OTHER_FAMILY.key);
  });

  it("keys roles case- and space-insensitively", () => {
    expect(roleFamilyKey("Data Engineer", goal({ targetRoles: ["  DATA   Engineer "] }))).toBe("data engineer");
  });

  it("is Other for a title with no word characters, even though scoreRole treats it as a neutral 0.5", () => {
    expect(roleFamilyKey("データエンジニア", goal({ targetRoles: ["Data Engineer"] }))).toBe(OTHER_FAMILY.key);
  });
});

describe("pickGoal", () => {
  const older = goal({ id: "old", confirmedAt: new Date("2026-08-01T00:00:00Z") });
  const newer = goal({ id: "new", confirmedAt: new Date("2026-09-15T00:00:00Z") });

  it("uses the match's goal when it exists", () => {
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), "old", [older, newer])?.id).toBe("old");
  });

  it("otherwise uses the goal confirmed most recently before the application was created", () => {
    expect(pickGoal(new Date("2026-09-10T00:00:00Z"), null, [older, newer])?.id).toBe("old");
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), "missing", [older, newer])?.id).toBe("new");
  });

  it("is null when no goal was confirmed by then", () => {
    expect(pickGoal(new Date("2026-07-01T00:00:00Z"), null, [older, newer])).toBeNull();
    expect(pickGoal(new Date("2026-10-01T00:00:00Z"), null, [goal({ confirmedAt: null })])).toBeNull();
  });
});

describe("roleLabels", () => {
  it("labels each role key with the most recently confirmed goal's spelling", () => {
    const labels = roleLabels([
      goal({ id: "b", confirmedAt: new Date("2026-09-15T00:00:00Z"), targetRoles: ["Data Engineer"] }),
      goal({ id: "a", confirmedAt: new Date("2026-08-01T00:00:00Z"), targetRoles: ["data engineer", "Analyst"] }),
    ]);
    expect(labels.get("data engineer")).toBe("Data Engineer");
    expect(labels.get("analyst")).toBe("Analyst");
  });
});
