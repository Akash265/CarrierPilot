import { z } from "zod";
import { APPLICATION_STATUSES } from "./types";

/** Small clock-skew allowance for "not in the future" checks. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const notInFuture = (iso: string) => new Date(iso).getTime() <= Date.now() + FUTURE_TOLERANCE_MS;

/** Calendar dates are UTC YYYY-MM-DD strings (Drizzle `date` mode "string"). */
export const todayUtc = (now: Date): string => now.toISOString().slice(0, 10);

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date as YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && todayUtc(d) === v;
  }, "Not a real calendar date");

const HttpUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "Must be an http(s) URL");

const OccurredAtSchema = z.string().datetime({ offset: true });
const Uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const CompanyName = z.string().trim().min(1).max(200);
const JobTitle = z.string().trim().min(1).max(300);

const documentLinks = {
  resumeOptimizationId: Uuid.nullable().optional(),
  applicationPitchId: Uuid.nullable().optional(),
  coverLetterId: Uuid.nullable().optional(),
};

export const CreateApplicationBodySchema = z
  .object({
    jobId: Uuid.optional(),
    external: z.object({ companyName: CompanyName, jobTitle: JobTitle, jobUrl: HttpUrlSchema.nullable().optional() }).strict().optional(),
    ...documentLinks,
    appliedAt: DateOnlySchema.optional(),
    followUpAt: DateOnlySchema.nullable().optional(),
    notes: optionalText(5000),
  })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.jobId === undefined) === (body.external === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["jobId"], message: "Provide exactly one of jobId or external" });
    }
    if (body.external && (body.resumeOptimizationId || body.applicationPitchId || body.coverLetterId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["external"], message: "An external application cannot link generated documents" });
    }
  });
export type CreateApplicationBody = z.infer<typeof CreateApplicationBodySchema>;

export const UpdateApplicationBodySchema = z
  .object({
    companyName: CompanyName.optional(),
    jobTitle: JobTitle.optional(),
    jobUrl: HttpUrlSchema.nullable().optional(),
    appliedAt: DateOnlySchema.optional(),
    followUpAt: DateOnlySchema.nullable().optional(),
    recruiterName: optionalText(200),
    recruiterContact: optionalText(300),
    salaryNotes: optionalText(500),
    notes: optionalText(5000),
    ...documentLinks,
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "Nothing to update");
export type UpdateApplicationBody = z.infer<typeof UpdateApplicationBodySchema>;

export const ChangeStatusBodySchema = z
  .object({
    toStatus: z.enum(APPLICATION_STATUSES),
    occurredAt: OccurredAtSchema.refine(notInFuture, "Cannot be in the future").optional(),
    note: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export type ChangeStatusBody = z.infer<typeof ChangeStatusBodySchema>;

const Summary = z.string().trim().max(2000).default("");

export const UserEventBodySchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("note"), occurredAt: OccurredAtSchema.optional(), detail: z.object({ text: z.string().trim().min(1).max(5000) }).strict() }).strict(),
    z.object({
      type: z.literal("recruiter_contact"),
      occurredAt: OccurredAtSchema.optional(),
      detail: z.object({ channel: z.enum(["email", "phone", "linkedin", "other"]), summary: Summary }).strict(),
    }).strict(),
    z.object({
      type: z.literal("interview"),
      occurredAt: OccurredAtSchema.optional(),
      detail: z.object({
        round: z.number().int().min(1).max(20).optional(),
        kind: z.enum(["phone_screen", "technical", "behavioral", "onsite", "panel", "other"]),
        scheduledFor: OccurredAtSchema.optional(),
        summary: Summary,
      }).strict(),
    }).strict(),
    z.object({ type: z.literal("follow_up_done"), occurredAt: OccurredAtSchema.optional(), detail: z.object({}).strict().default({}) }).strict(),
    z.object({ type: z.literal("follow_up_snoozed"), occurredAt: OccurredAtSchema.optional(), detail: z.object({ newFollowUpAt: DateOnlySchema }).strict() }).strict(),
  ])
  .superRefine((event, ctx) => {
    // An interview may be logged ahead of time; everything else records something that already happened.
    if (event.type !== "interview" && event.occurredAt && !notInFuture(event.occurredAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["occurredAt"], message: "Cannot be in the future" });
    }
  });
export type UserEventBody = z.infer<typeof UserEventBodySchema>;
