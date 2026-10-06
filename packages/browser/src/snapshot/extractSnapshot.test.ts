import { describe, it, expect } from "vitest";
import { snapshotFromHtml, readFixture } from "../testing";
import { greenhouseV1, leverV1 } from "../adapters";
import type { SnapshotField } from "../types";

const byId = (fields: SnapshotField[], id: string) => fields.find((f) => f.id === id);
const byName = (fields: SnapshotField[], name: string) => fields.find((f) => f.name === name);

describe("EXTRACT_SNAPSHOT_SOURCE on the Greenhouse fixture", () => {
  const snap = snapshotFromHtml(readFixture("greenhouse-v1-form.html"), greenhouseV1.snapshotConfig);

  it("finds the form and its 21 visible controls", () => {
    expect(snap.formFound).toBe(true);
    expect(snap.fields).toHaveLength(21);
  });

  it("reads labels from label[for], aria-labelledby and strips the required star", () => {
    expect(byId(snap.fields, "first_name")).toMatchObject({ control: "text", label: "First Name", required: true });
    expect(byId(snap.fields, "phone")).toMatchObject({ control: "tel", label: "Phone", required: false });
    expect(byId(snap.fields, "resume")).toMatchObject({ control: "file" });
    expect(byId(snap.fields, "question_36622854002")).toMatchObject({ control: "text", label: "LinkedIn Profile" });
    expect(byId(snap.fields, "question_36622859002")).toMatchObject({
      control: "combobox",
      label: "Will you now or in the future require sponsorship for a visa to remain in your current location?",
      required: true,
    });
    expect(byId(snap.fields, "gender")).toMatchObject({ control: "combobox", label: "Gender" });
  });

  it("skips react-select's aria-hidden validation inputs", () => {
    expect(snap.fields.every((f) => f.id !== null)).toBe(true);
  });

  it("gives every field a unique key", () => {
    expect(new Set(snap.fields.map((f) => f.key)).size).toBe(snap.fields.length);
  });
});

describe("EXTRACT_SNAPSHOT_SOURCE on the Lever fixture", () => {
  const snap = snapshotFromHtml(readFixture("lever-v1-form.html"), leverV1.snapshotConfig);

  it("finds the form and groups radios/checkboxes", () => {
    expect(snap.formFound).toBe(true);
    expect(snap.fields).toHaveLength(22);
  });

  it("labels standard fields from the question container", () => {
    expect(byName(snap.fields, "resume")).toMatchObject({ control: "file", label: "Resume/CV" });
    expect(byName(snap.fields, "name")).toMatchObject({ control: "text", label: "Full name", required: true });
    expect(byName(snap.fields, "email")).toMatchObject({ control: "email", required: true });
    expect(byName(snap.fields, "location")).toMatchObject({ control: "text", label: "Current location", required: true });
    expect(byName(snap.fields, "urls[LinkedIn]")).toMatchObject({ control: "text", label: "LinkedIn URL" });
  });

  it("reports a yes/no radio group as one field with option keys and labels", () => {
    const sponsorship = snap.fields.find((f) => f.label?.startsWith("Will you now or in the future require sponsorship"));
    expect(sponsorship).toMatchObject({ control: "radio_group", required: true });
    expect(sponsorship!.options.map((o) => [o.label, o.value])).toEqual([["Yes", "Yes"], ["No", "No"]]);
    expect(sponsorship!.options.every((o) => /^f\d+$/.test(o.key))).toBe(true);
  });

  it("reports selects with their options and multi-checkboxes as a checkbox group", () => {
    const heard = snap.fields.find((f) => f.label === "Please tell us how you heard about this opportunity.");
    expect(heard).toMatchObject({ control: "select", required: true });
    expect(heard!.options[0]).toMatchObject({ label: "Select...", value: "" });
    expect(snap.fields.find((f) => f.label?.startsWith("Language Skill(s)"))).toMatchObject({ control: "checkbox_group", required: true });
  });
});

describe("EXTRACT_SNAPSHOT_SOURCE edge cases", () => {
  it("reports formFound false when the form selector matches nothing", () => {
    expect(snapshotFromHtml("<html><body><p>Gone</p></body></html>", greenhouseV1.snapshotConfig)).toEqual({
      url: "https://example.test/form", formFound: false, fields: [],
    });
  });

  it("never reports buttons, submit/hidden inputs or disabled controls", () => {
    const html = `<form id="application-form">
      <input type="submit" value="Go"><input type="hidden" name="t"><input type="text" name="x" disabled>
      <button type="button">Next</button><input type="text" name="kept" aria-label="Kept *"></form>`;
    const snap = snapshotFromHtml(html, greenhouseV1.snapshotConfig);
    expect(snap.fields.map((f) => [f.name, f.label])).toEqual([["kept", "Kept"]]);
  });

  it("stamps data-cp-key on the reported elements", () => {
    const snap = snapshotFromHtml(`<form id="application-form"><input id="first_name"></form>`, greenhouseV1.snapshotConfig);
    expect(snap.fields[0].key).toBe("f0");
  });
});
