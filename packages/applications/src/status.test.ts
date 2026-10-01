import { describe, it, expect } from "vitest";
import { isTerminal, planStatusChange } from "./status";
import { ApplicationError } from "./errors";

const NOW = new Date("2026-10-01T12:00:00Z");
const EARLIER = new Date("2026-09-20T09:00:00Z");

describe("isTerminal", () => {
  it("is true only for the five terminal statuses", () => {
    expect(["accepted", "declined", "rejected", "withdrawn", "no_response"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["applied", "screening", "interviewing", "offer"].some((s) => isTerminal(s as never))).toBe(false);
  });
});

describe("planStatusChange", () => {
  it("rejects a change to the same status", () => {
    expect(() => planStatusChange({ current: "applied", currentTerminalAt: null, to: "applied", now: NOW })).toThrow(ApplicationError);
  });

  it("allows any non-terminal move, including backwards, with no terminal clock", () => {
    expect(planStatusChange({ current: "offer", currentTerminalAt: null, to: "screening", now: NOW })).toEqual({
      status: "screening", statusChangedAt: NOW, terminalAt: null,
    });
  });

  it("starts the terminal clock at now even when the change is backdated", () => {
    expect(planStatusChange({ current: "interviewing", currentTerminalAt: null, to: "rejected", now: NOW, occurredAt: EARLIER })).toEqual({
      status: "rejected", statusChangedAt: EARLIER, terminalAt: NOW,
    });
  });

  it("keeps the original terminal clock on a terminal-to-terminal change", () => {
    expect(planStatusChange({ current: "rejected", currentTerminalAt: EARLIER, to: "withdrawn", now: NOW }).terminalAt).toEqual(EARLIER);
  });

  it("clears the terminal clock when reopening", () => {
    expect(planStatusChange({ current: "rejected", currentTerminalAt: EARLIER, to: "interviewing", now: NOW }).terminalAt).toBeNull();
  });
});
