import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { openTestDb, wipeUser, seedAutofillJob, insertSessionRow, type TestDb } from "@ai-career/browser/testing";
import { getSession, requestCancel, type FieldAuditEntry } from "@ai-career/browser";
import { runSession, type RunSessionDeps } from "./runSession";
import { ReleasedWindows, type BrowserHandle } from "./browser";
import { startFixtureServer } from "./testing/fixtureServer";

const USER = "00000000-0000-0000-0000-0000000008a5";
let t: TestDb;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let released: ReleasedWindows;
let handle: BrowserHandle | null;

beforeAll(async () => {
  t = await openTestDb();
  server = await startFixtureServer();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  released = new ReleasedWindows();
  handle = null;
});
afterAll(async () => {
  await released.closeAll();
  await wipeUser(t.adminSql, USER);
  await server.close();
  await t.close();
});

const deps = (over: Partial<RunSessionDeps> = {}): RunSessionDeps => ({
  db: t.db,
  fetchDocument: async () => Buffer.from("%PDF-1.4 test"),
  browser: { headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH },
  timeoutMs: 20_000,
  released,
  extraAllowedHosts: [server.host],
  pollMs: 100,
  onBrowser: (h) => {
    handle = h;
  },
  ...over,
});

async function waitForStatus(id: string, status: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getSession(t.db, USER, id);
    if (row?.status === status) return row;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}, last ${row?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const filled = (audit: unknown) => (audit as FieldAuditEntry[]).filter((a) => a.action === "filled").map((a) => a.canonical).sort();

describe("runSession against the Greenhouse fixture", () => {
  it("fills, attaches, waits, then detects the confirmation page and releases the window", async () => {
    const { jobId, resumeDocumentId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: `${server.origin}/greenhouse` });
    const result = runSession(deps(), { sessionId: id, userId: USER });

    const waiting = await waitForStatus(id, "awaiting_user");
    expect(filled(waiting.fieldAudit)).toEqual(["email", "first_name", "last_name", "linkedin", "phone", "resume"]);
    expect((waiting.fieldAudit as FieldAuditEntry[]).filter((a) => a.action === "filled").every((a) => a.verified)).toBe(true);
    expect(waiting.resumeDocumentId).toBe(resumeDocumentId);
    expect(waiting.stoppedBeforeSubmit).toBe(true);
    expect(await handle!.page.inputValue("#first_name")).toBe("Jane");
    expect(await handle!.page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files?.length)).toBe(1);

    await handle!.page.goto(`${server.origin}/greenhouse/confirmation`); // what the ATS does after the user submits
    expect(await result).toBe("submission_detected");
    const row = await getSession(t.db, USER, id);
    expect(row).toMatchObject({ status: "submission_detected", errorCode: null });
    expect(row!.submissionDetectedAt).not.toBeNull();
    expect(released.size).toBe(1);
    await released.closeAll();
    expect(handle!.isClosed()).toBe(true);
  });

  it("flags a resume that cannot be downloaded and still hands over the window", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: `${server.origin}/greenhouse` });
    const result = runSession(deps({ fetchDocument: async () => { throw new Error("minio down"); } }), { sessionId: id, userId: USER });
    const waiting = await waitForStatus(id, "awaiting_user");
    expect((waiting.fieldAudit as FieldAuditEntry[]).find((a) => a.canonical === "resume")).toMatchObject({
      action: "flagged", reason: "attachment_unavailable",
    });
    expect(waiting.resumeDocumentId).toBeNull();
    await requestCancel(t.db, USER, id);
    expect(await result).toBe("abandoned");
  });
});

describe("runSession against the Lever fixture", () => {
  it("answers the sponsorship radio from the goal and flags the location widget", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { sourceKind: "lever" });
    const id = await insertSessionRow(t.adminSql, USER, jobId, { portal: "lever", formUrl: `${server.origin}/lever/apply` });
    const result = runSession(deps(), { sessionId: id, userId: USER });
    const waiting = await waitForStatus(id, "awaiting_user");
    expect(filled(waiting.fieldAudit)).toEqual(["email", "full_name", "linkedin", "phone", "resume", "sponsorship"]);
    expect(
      await handle!.page.locator('input[name="cards[1c719ca9-5069-4afe-9e82-39ca420e0edb][field1]"][value="No"]').isChecked()
    ).toBe(true);
    expect((waiting.fieldAudit as FieldAuditEntry[]).find((a) => a.canonical === "location")).toMatchObject({ action: "flagged", reason: "autocomplete_widget" });
    await handle!.page.goto(`${server.origin}/lever/thanks`);
    expect(await result).toBe("submission_detected");
    await released.closeAll();
  });
});

describe("runSession endings", () => {
  const start = async (path: string, over: Partial<RunSessionDeps> = {}) => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { formUrl: path.startsWith("http") ? path : `${server.origin}${path}` });
    return { id, result: runSession(deps(over), { sessionId: id, userId: USER }) };
  };

  it("abandons on cancel and closes the window", async () => {
    const { id, result } = await start("/greenhouse");
    await waitForStatus(id, "awaiting_user");
    await requestCancel(t.db, USER, id);
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "cancelled" });
    expect(handle!.isClosed()).toBe(true);
  });

  it("abandons when the user closes the window", async () => {
    const { id, result } = await start("/greenhouse");
    await waitForStatus(id, "awaiting_user");
    await handle!.context.close();
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "window_closed" });
  });

  it("abandons at the session timeout", async () => {
    const { id, result } = await start("/greenhouse", { timeoutMs: 1_500 });
    expect(await result).toBe("abandoned");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "timeout" });
  });

  it("needs manual work when the form is missing, and releases the window", async () => {
    const { id, result } = await start("/no-form");
    expect(await result).toBe("needs_manual");
    const row = await getSession(t.db, USER, id);
    expect(row).toMatchObject({ errorCode: "health_check_failed" });
    expect(released.size).toBe(1);
    await released.closeAll();
  });

  it("needs manual work after a redirect to another host, without filling", async () => {
    const { id, result } = await start("/redirect-away");
    expect(await result).toBe("needs_manual");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "off_host_redirect", fieldAudit: [] });
    await released.closeAll();
  });

  it("refuses a stored form URL outside the allowed hosts before launching", async () => {
    const { id, result } = await start("https://evil.example/apply");
    expect(await result).toBe("needs_manual");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "form_url_not_allowed" });
    expect(handle).toBeNull();
  });

  it("fails cleanly when Chrome cannot start", async () => {
    const { id, result } = await start("/greenhouse", { browser: { headless: true, executablePath: "/nonexistent/chrome" } });
    expect(await result).toBe("failed");
    expect(await getSession(t.db, USER, id)).toMatchObject({ errorCode: "browser_launch_failed" });
  });

  it("skips a session that is no longer queued", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER);
    const id = await insertSessionRow(t.adminSql, USER, jobId, { status: "abandoned" });
    expect(await runSession(deps(), { sessionId: id, userId: USER })).toBe("skipped");
  });
});
