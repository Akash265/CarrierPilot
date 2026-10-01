import { ApplicationError } from "./errors";
import { TERMINAL_STATUSES, type ApplicationStatus } from "./types";

const TERMINAL = new Set<ApplicationStatus>(TERMINAL_STATUSES);

export const isTerminal = (status: ApplicationStatus): boolean => TERMINAL.has(status);

export interface StatusChangeInput {
  current: ApplicationStatus;
  currentTerminalAt: Date | null;
  to: ApplicationStatus;
  now: Date;
  /** User-supplied (may be backdated). Only affects statusChangedAt, never the retention clock. */
  occurredAt?: Date;
}

export interface StatusChangePlan {
  status: ApplicationStatus;
  statusChangedAt: Date;
  terminalAt: Date | null;
}

/**
 * Permissive lifecycle (design decision 2): any status may follow any other. The retention clock
 * (terminalAt) starts at `now`, not a backdated occurredAt, so recording an old rejection never makes
 * documents immediately purgeable; terminal -> terminal keeps the original clock.
 */
export function planStatusChange(input: StatusChangeInput): StatusChangePlan {
  if (input.to === input.current) throw new ApplicationError("same_status");
  const statusChangedAt = input.occurredAt ?? input.now;
  if (!isTerminal(input.to)) return { status: input.to, statusChangedAt, terminalAt: null };
  const keepClock = isTerminal(input.current) && input.currentTerminalAt !== null;
  return { status: input.to, statusChangedAt, terminalAt: keepClock ? input.currentTerminalAt : input.now };
}
