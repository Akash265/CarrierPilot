import { schema } from "@ai-career/db";

export type ApplicationRow = typeof schema.applications.$inferSelect;
export type ApplicationEventRow = typeof schema.applicationEvents.$inferSelect;

/** Single source of truth: the Postgres enum's values. */
export const APPLICATION_STATUSES = schema.applicationStatusEnum.enumValues;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const TERMINAL_STATUSES = ["accepted", "declined", "rejected", "withdrawn", "no_response"] as const satisfies readonly ApplicationStatus[];

export const APPLICATION_EVENT_TYPES = schema.applicationEventTypeEnum.enumValues;
export type ApplicationEventType = (typeof APPLICATION_EVENT_TYPES)[number];
