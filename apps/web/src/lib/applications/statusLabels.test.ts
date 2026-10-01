import { describe, it, expect } from "vitest";
import { APPLICATION_STATUSES, TERMINAL_STATUSES } from "@ai-career/applications";
import { STATUS_LABELS, STATUS_ORDER, TERMINAL_STATUS_SET } from "./statusLabels";

// statusLabels is imported by client components, so it cannot import the DB-backed package itself;
// this test keeps the two lists in lockstep.
describe("statusLabels", () => {
  it("labels exactly the domain statuses, in order, with the same terminal set", () => {
    expect(STATUS_ORDER).toEqual([...APPLICATION_STATUSES]);
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...APPLICATION_STATUSES].sort());
    expect([...TERMINAL_STATUS_SET].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });
});
