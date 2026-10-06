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
import { GuardViolation, performAction, verifyAction, type AttachmentPaths } from "./actions";
import { downloadAttachments, type FetchDocument } from "./attachments";
import { launchBrowser, SESSION_DIR_PREFIX, type BrowserHandle, type BrowserOptions, type ReleasedWindows } from "./browser";
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
  // Only hands the window to the released registry when the terminal transition actually landed; a cancel or a
  // concurrent sweep that beat us to it means there is nothing to release, so the handle is simply closed instead.
  const release = async (to: AutomationStatus, patch: TransitionPatch, ms: number): Promise<RunSessionResult> => {
    const result = await end(to, patch);
    if (result === to) releaseMs = ms;
    return result;
  };
  // Design §6 / review: a cancel that arrives between the decision to release and the write must still win --
  // otherwise the user is handed a window for a session the DB already considers cancelled.
  const releaseUnlessCancelled = async (to: AutomationStatus, patch: TransitionPatch, ms: number): Promise<RunSessionResult> => {
    if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled" });
    return await release(to, patch, ms);
  };

  try {
    if (!hostAllowed(claimed.formUrl, adapter, extra)) return await end("needs_manual", { errorCode: "form_url_not_allowed" });

    const ctx = await loadAutofillContext(db, userId, sessionId);
    const rootDir = await mkdtemp(path.join(tmpdir(), SESSION_DIR_PREFIX));
    let paths: AttachmentPaths;
    let failed: ("resume" | "cover_letter")[];
    try {
      ({ paths, failed } = await downloadAttachments(
        deps.fetchDocument, { resume: ctx.resumeDocument, coverLetter: ctx.coverLetterDocument }, path.join(rootDir, "files")
      ));
    } catch (error) {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      handle = await launchBrowser({ ...deps.browser, rootDir });
    } catch {
      await rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
      return await end("failed", { errorCode: "browser_launch_failed" });
    }
    // From here on the window is "active": a shutdown/crash before this session reaches a release/close ending
    // must still be able to find and close it, so its temp profile/attachments are never leaked (spec §5).
    deps.released.setActive(handle);
    deps.onBrowser?.(handle);

    if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled" });
    if (!(await transitionSession(db, userId, sessionId, ["launching"], "filling"))) return "skipped";

    const page = handle.page;
    try {
      const response = await page.goto(claimed.formUrl, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      if (response && !response.ok()) return await releaseUnlessCancelled("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    } catch {
      return await releaseUnlessCancelled("needs_manual", { errorCode: "navigation_failed" }, deps.timeoutMs);
    }
    if (!hostAllowed(page.url(), adapter, extra)) {
      return await releaseUnlessCancelled("needs_manual", { errorCode: "off_host_redirect" }, deps.timeoutMs);
    }
    await page.waitForSelector(adapter.snapshotConfig.formSelector, { state: "attached", timeout: FORM_WAIT_MS }).catch(() => undefined);
    // Re-check: a client-side redirect can leave the allowed host after the form loads but before anything
    // is read from the page.
    if (!hostAllowed(page.url(), adapter, extra)) {
      return await releaseUnlessCancelled("needs_manual", { errorCode: "off_host_redirect" }, deps.timeoutMs);
    }

    const snapshot = await takeSnapshot(page, adapter);
    if (!snapshot) {
      return await releaseUnlessCancelled("needs_manual", { errorCode: "health_check_failed", fieldAudit: [] }, deps.timeoutMs);
    }
    const values = buildAutofillValues({
      profile: ctx.profile, goal: ctx.goal, attachments: { resume: Boolean(paths.resume), coverLetter: Boolean(paths.cover_letter) },
    });
    const plan = buildFillPlan(snapshot, adapter, values);
    const audit = markUnavailable(plan.audit, failed);
    if (!plan.healthy) {
      return await releaseUnlessCancelled("needs_manual", { errorCode: "health_check_failed", fieldAudit: audit }, deps.timeoutMs);
    }

    for (const action of plan.actions) {
      if (await isCancelRequested(db, userId, sessionId)) return await end("abandoned", { errorCode: "cancelled", fieldAudit: audit });
      // Re-check before every page mutation: a redirect mid-fill means the page we're about to act on is no
      // longer the application form, so nothing further is filled and whatever was filled is not reported.
      if (!hostAllowed(page.url(), adapter, extra)) {
        return await releaseUnlessCancelled("needs_manual", { errorCode: "off_host_redirect", fieldAudit: [] }, deps.timeoutMs);
      }
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
          return await releaseUnlessCancelled("submission_detected", { submissionDetectedAt: new Date() }, deps.timeoutMs - elapsed);
        }
      }
    }
  } catch (error) {
    // Surface the failure to BullMQ (and main.ts's "failed" handler, which logs the error class) instead of
    // quietly resolving "failed" -- an unexpected error must not look like a completed job.
    await failSession(db, userId, sessionId, "unexpected_error").catch(() => undefined);
    throw error;
  } finally {
    if (handle) {
      deps.released.setActive(null);
      if (releaseMs !== null && !handle.isClosed()) deps.released.release(handle, releaseMs);
      else await handle.close();
    }
  }
}
