import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { DbClient } from "@ai-career/db";
import {
  ACTIVE_STATUSES, buildAutofillValues, buildFillPlan, detectSubmission, failSession, getAdapter, isCancelRequested,
  loadAutofillContext, transitionSession,
  type AutomationStatus, type BrowserJobData, type FieldAuditEntry, type PortalAdapter, type TransitionPatch,
} from "@ai-career/browser";
import { GuardViolation, performAction, verifyAction } from "./actions";
import { downloadAttachments, type FetchDocument } from "./attachments";
import { launchBrowser, type BrowserHandle, type BrowserOptions, type ReleasedWindows } from "./browser";
import { readPageText, takeSnapshot } from "./snapshot";

const NAVIGATION_TIMEOUT_MS = 30_000;
const FORM_WAIT_MS = 15_000;

export interface RunSessionDeps {
  db: DbClient;
  fetchDocument: FetchDocument;
  browser: BrowserOptions;
  /** BROWSER_SESSION_TIMEOUT_MIN in ms: how long the window waits for the user. */
  timeoutMs: number;
  released: ReleasedWindows;
  /** Tests only: extra "host:port" values allowed (over http too), e.g. the local fixture server. */
  extraAllowedHosts?: string[];
  pollMs?: number;
  /** Tests only: observe the live browser. */
  onBrowser?: (handle: BrowserHandle) => void;
}

export type RunSessionResult = AutomationStatus | "skipped";

function hostAllowed(url: string, adapter: PortalAdapter, extra: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (extra.includes(u.host)) return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:" && adapter.allowedHosts.includes(u.hostname);
}

/** Attachments that failed to download read better as "attachment_unavailable" than "no_resume_export"/"no_value". */
function markUnavailable(audit: FieldAuditEntry[], failed: ("resume" | "cover_letter")[]): FieldAuditEntry[] {
  return audit.map((a) =>
    a.canonical !== null && (failed as string[]).includes(a.canonical) && a.action !== "filled"
      ? { ...a, action: "flagged", reason: "attachment_unavailable" }
      : a
  );
}

/**
 * Design §5. Runs one session end to end. Status is written after every step and every transition is conditional,
 * so a cancel or a startup sweep in between simply makes the next transition a no-op. The window is closed on every
 * ending except needs_manual and submission_detected, where it is released to the user (spec §11.6).
 * Holds no domain rules: classification, values and detection all come from @ai-career/browser.
 */
export async function runSession(deps: RunSessionDeps, data: BrowserJobData): Promise<RunSessionResult> {
  const { db } = deps;
  const { sessionId, userId } = data;
  const pollMs = deps.pollMs ?? 1_000;
  const extra = deps.extraAllowedHosts ?? [];

  const claimed = await transitionSession(db, userId, sessionId, ["queued"], "launching", { startedAt: new Date() });
  if (!claimed) return "skipped";
  const adapter = getAdapter(claimed.portal);

  let handle: BrowserHandle | null = null;
  let releaseMs: number | null = null;

  const end = async (to: AutomationStatus, patch: TransitionPatch = {}): Promise<RunSessionResult> => {
    const row = await transitionSession(db, userId, sessionId, ACTIVE_STATUSES, to, patch);
    return row ? to : "skipped";
  };
  const release = (to: AutomationStatus, patch: TransitionPatch, ms: number) => {
    releaseMs = ms;
    return end(to, patch);
  };

  try {
    if (!hostAllowed(claimed.formUrl, adapter, extra)) return await end("needs_manual", { errorCode: "form_url_not_allowed" });

    const ctx = await loadAutofillContext(db, userId, sessionId);
    const rootDir = await mkdtemp(path.join(tmpdir(), "careerpilot-autofill-"));
    const { paths, failed } = await downloadAttachments(
      deps.fetchDocument, { resume: ctx.resumeDocument, coverLetter: ctx.coverLetterDocument }, path.join(rootDir, "files")
    );
    try {
      handle = await launchBrowser({ ...deps.browser, rootDir });
    } catch {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
      return await end("failed", { errorCode: "browser_launch_failed" });
    }
    deps.onBrowser?.(handle);

    if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled" });
    if (!(await transitionSession(db, userId, sessionId, ["launching"], "filling"))) return "skipped";

    const page = handle.page;
    try {
      const response = await page.goto(claimed.formUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      if (response && !response.ok()) return await release("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    } catch {
      return await release("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    }
    if (!hostAllowed(page.url(), adapter, extra)) return await release("needs_manual", { errorCode: "off_host_redirect" }, deps.timeoutMs);
    await page.waitForSelector(adapter.snapshotConfig.formSelector, { state: "attached", timeout: FORM_WAIT_MS }).catch(() => undefined);

    const snapshot = await takeSnapshot(page, adapter);
    const values = buildAutofillValues({
      profile: ctx.profile, goal: ctx.goal, attachments: { resume: Boolean(paths.resume), coverLetter: Boolean(paths.cover_letter) },
    });
    const plan = buildFillPlan(snapshot, adapter, values);
    const audit = markUnavailable(plan.audit, failed);
    if (!plan.healthy) return await release("needs_manual", { errorCode: "health_check_failed", fieldAudit: audit }, deps.timeoutMs);

    for (const action of plan.actions) {
      if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled", fieldAudit: audit });
      const entry = audit.find((a) => a.key === action.fieldKey)!;
      try {
        await performAction(page, action, paths);
        entry.verified = await verifyAction(page, action);
        if (!entry.verified) Object.assign(entry, { action: "flagged", reason: "verify_mismatch" });
      } catch (error) {
        Object.assign(entry, { action: "flagged", reason: error instanceof GuardViolation ? "guard_blocked" : "fill_error", verified: false });
      }
    }

    const awaiting = await transitionSession(db, userId, sessionId, ["filling"], "awaiting_user", {
      fieldAudit: audit,
      resumeDocumentId: paths.resume ? ctx.resumeDocument!.id : null,
      coverLetterDocumentId: paths.cover_letter ? ctx.coverLetterDocument!.id : null,
    });
    if (!awaiting) return "skipped";

    // Design §5 step 3 / spec §11.7: one polling loop for close, timeout, cancel and confirmation detection.
    const waitingSince = Date.now();
    for (let tick = 1; ; tick++) {
      await sleep(pollMs);
      if (handle.isClosed()) return await end("abandoned", { errorCode: "window_closed" });
      const elapsed = Date.now() - waitingSince;
      if (elapsed >= deps.timeoutMs) return await end("abandoned", { errorCode: "timeout" });
      if (tick % 2 === 0 && (await isCancelRequested(db, userId, sessionId))) return await end("abandoned", { errorCode: "cancelled" });
      for (const p of handle.context.pages()) {
        if (p.isClosed()) continue;
        const text = await readPageText(p).catch(() => "");
        if (detectSubmission(adapter, { url: p.url(), text, formUrl: claimed.formUrl })) {
          return await release("submission_detected", { submissionDetectedAt: new Date() }, deps.timeoutMs - elapsed);
        }
      }
    }
  } catch {
    await failSession(db, userId, sessionId, "unexpected_error").catch(() => undefined);
    return "failed";
  } finally {
    if (handle) {
      if (releaseMs !== null && !handle.isClosed()) deps.released.release(handle, releaseMs);
      else await handle.close();
    }
  }
}
