import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { changeStatus, addEvent, updateApplication, deleteApplication } from "./mutateApplication";
import { ApplicationError } from "./errors";

const USER = "00000000-0000-0000-0000-0000000009a4";
const T0 = new Date("2026-09-30T10:00:00Z");
const T1 = new Date("2026-10-05T10:00:00Z");
const T2 = new Date("2026-10-06T10:00:00Z");
const MISSING = "11111111-1111-4111-8111-111111111111";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const errorClassOf = (p: Promise<unknown>) =>
  p.then(() => "resolved", (e) => (e instanceof ApplicationError ? e.errorClass : `other:${String(e)}`));
const external = () => createApplication(t.db, USER, { external: { companyName: "Globex", jobTitle: "Analyst" } }, T0);
// Events written in one transaction share created_at (now() is the transaction start), so order is not asserted within one.
const eventsOf = (id: string) =>
  t.adminSql`SELECT type, from_status, to_status, detail, occurred_at FROM application_events WHERE application_id = ${id}`;

describe("changeStatus", () => {
  it("updates the row, logs the change, and starts the terminal clock at now even when backdated", async () => {
    const app = await external();
    const row = await changeStatus(t.db, USER, app.id, { toStatus: "rejected", occurredAt: "2026-09-01T09:00:00Z", note: "Form email" }, T1);
    expect(row.status).toBe("rejected");
    expect(row.statusChangedAt).toEqual(new Date("2026-09-01T09:00:00Z"));
    expect(row.terminalAt).toEqual(T1);
    const events = await eventsOf(app.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => [e.type, e.from_status, e.to_status])).toEqual(expect.arrayContaining([
      ["status_change", null, "applied"], ["status_change", "applied", "rejected"], ["note", null, null],
    ]));
    expect(events.find((e) => e.type === "note")?.detail).toEqual({ text: "Form email" });
  });

  it("clears the clock on reopen and keeps it on terminal-to-terminal", async () => {
    const app = await external();
    await changeStatus(t.db, USER, app.id, { toStatus: "rejected" }, T1);
    expect((await changeStatus(t.db, USER, app.id, { toStatus: "withdrawn" }, T2)).terminalAt).toEqual(T1);
    expect((await changeStatus(t.db, USER, app.id, { toStatus: "interviewing" }, T2)).terminalAt).toBeNull();
  });

  it("rejects the same status and an unknown application", async () => {
    const app = await external();
    expect(await errorClassOf(changeStatus(t.db, USER, app.id, { toStatus: "applied" }, T1))).toBe("same_status");
    expect(await errorClassOf(changeStatus(t.db, USER, MISSING, { toStatus: "offer" }, T1))).toBe("not_found");
  });
});

describe("addEvent", () => {
  it("logs a note with the given occurredAt", async () => {
    const app = await external();
    const ev = await addEvent(t.db, USER, app.id, { type: "note", occurredAt: "2026-10-01T08:00:00Z", detail: { text: "Called" } }, T1);
    expect(ev).toMatchObject({ type: "note", occurredAt: new Date("2026-10-01T08:00:00Z"), detail: { text: "Called" } });
  });

  it("follow_up_done clears the follow-up date and follow_up_snoozed moves it", async () => {
    const app = await createApplication(t.db, USER, { external: { companyName: "G", jobTitle: "A" }, followUpAt: "2026-10-01" }, T0);
    await addEvent(t.db, USER, app.id, { type: "follow_up_snoozed", detail: { newFollowUpAt: "2026-10-08" } }, T1);
    let [row] = await t.adminSql`SELECT follow_up_at::text AS f FROM applications WHERE id = ${app.id}`;
    expect(row.f).toBe("2026-10-08");
    await addEvent(t.db, USER, app.id, { type: "follow_up_done", detail: {} }, T2);
    [row] = await t.adminSql`SELECT follow_up_at FROM applications WHERE id = ${app.id}`;
    expect(row.follow_up_at).toBeNull();
  });

  it("returns not_found for an unknown application", async () => {
    expect(await errorClassOf(addEvent(t.db, USER, MISSING, { type: "note", detail: { text: "x" } }, T1))).toBe("not_found");
  });
});

describe("updateApplication", () => {
  it("edits only the given fields and never the snapshot", async () => {
    const app = await external();
    const row = await updateApplication(t.db, USER, app.id, { recruiterName: "Sam", followUpAt: "2026-10-09" }, T1);
    expect(row).toMatchObject({ recruiterName: "Sam", followUpAt: "2026-10-09", companyName: "Globex", featureSnapshot: app.featureSnapshot });
  });

  it("validates document links against the application's job", async () => {
    const a = await seedJobWithDocuments(t.adminSql, USER, { title: "Data Engineer" });
    const b = await seedJobWithDocuments(t.adminSql, USER, { title: "Analytics Engineer" });
    const app = await createApplication(t.db, USER, { jobId: a.jobId }, T0);
    expect((await updateApplication(t.db, USER, app.id, { coverLetterId: a.coverLetterId }, T1)).coverLetterId).toBe(a.coverLetterId);
    expect(await errorClassOf(updateApplication(t.db, USER, app.id, { coverLetterId: b.coverLetterId }, T1))).toBe("document_mismatch");
    const ext = await external();
    expect(await errorClassOf(updateApplication(t.db, USER, ext.id, { coverLetterId: a.coverLetterId }, T1))).toBe("document_mismatch");
  });

  it("returns not_found for an unknown application", async () => {
    expect(await errorClassOf(updateApplication(t.db, USER, MISSING, { notes: "x" }, T1))).toBe("not_found");
  });
});

describe("deleteApplication", () => {
  it("deletes the application and its events, and reports whether it existed", async () => {
    const app = await external();
    expect(await deleteApplication(t.db, USER, app.id)).toBe(true);
    expect(await eventsOf(app.id)).toHaveLength(0);
    expect(await deleteApplication(t.db, USER, app.id)).toBe(false);
  });
});
