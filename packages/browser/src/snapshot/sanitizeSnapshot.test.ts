import { describe, it, expect } from "vitest";
import { sanitizeSnapshot } from "./sanitizeSnapshot";
import { snapshotFromHtml, readFixture } from "../testing";
import { greenhouseV1 } from "../adapters";

const VALID = snapshotFromHtml(readFixture("greenhouse-v1-form.html"), greenhouseV1.snapshotConfig);

describe("sanitizeSnapshot", () => {
  it("passes a well-formed snapshot through unchanged", () => {
    expect(sanitizeSnapshot(VALID)).toEqual(VALID);
  });

  it("rejects a non-object or missing top-level shape", () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot("a string")).toBeNull();
    expect(sanitizeSnapshot(42)).toBeNull();
    expect(sanitizeSnapshot({})).toBeNull();
    expect(sanitizeSnapshot({ url: "https://x.test", formFound: true })).toBeNull(); // fields missing
    expect(sanitizeSnapshot({ url: 1, formFound: true, fields: [] })).toBeNull(); // url not a string
    expect(sanitizeSnapshot({ url: "https://x.test", formFound: "yes", fields: [] })).toBeNull(); // formFound not boolean
    expect(sanitizeSnapshot({ url: "https://x.test", formFound: true, fields: "nope" })).toBeNull(); // fields not an array
  });

  it("drops a field with a key that doesn't match the worker's own stamped pattern", () => {
    const raw = { url: "https://x.test", formFound: true, fields: [
      { key: "not-a-key", control: "text", name: null, id: null, autocomplete: null, label: "Bad key", required: false, options: [] },
      { key: "f0", control: "text", name: null, id: null, autocomplete: null, label: "Good", required: false, options: [] },
    ] };
    const out = sanitizeSnapshot(raw);
    expect(out!.fields).toHaveLength(1);
    expect(out!.fields[0].label).toBe("Good");
  });

  it("drops a field with an unknown control", () => {
    const raw = { url: "https://x.test", formFound: true, fields: [
      { key: "f0", control: "javascript:alert(1)", name: null, id: null, autocomplete: null, label: "Evil", required: false, options: [] },
    ] };
    expect(sanitizeSnapshot(raw)!.fields).toHaveLength(0);
  });

  it("nulls a non-string nullable property instead of dropping the field", () => {
    const raw = { url: "https://x.test", formFound: true, fields: [
      { key: "f0", control: "text", name: 123, id: { nested: true }, autocomplete: null, label: ["not", "a", "string"], required: false, options: [] },
    ] };
    const out = sanitizeSnapshot(raw)!;
    expect(out.fields[0]).toMatchObject({ key: "f0", control: "text", name: null, id: null, label: null });
  });

  it("truncates an oversized label to 200 characters", () => {
    const raw = { url: "https://x.test", formFound: true, fields: [
      { key: "f0", control: "text", name: null, id: null, autocomplete: null, label: "x".repeat(500), required: false, options: [] },
    ] };
    expect(sanitizeSnapshot(raw)!.fields[0].label).toHaveLength(200);
  });

  it("caps fields at 500 and options at 200", () => {
    const manyFields = Array.from({ length: 600 }, (_, i) => ({
      key: `f${i}`, control: "text", name: null, id: null, autocomplete: null, label: null, required: false, options: [],
    }));
    expect(sanitizeSnapshot({ url: "https://x.test", formFound: true, fields: manyFields })!.fields).toHaveLength(500);

    const manyOptions = Array.from({ length: 300 }, (_, i) => ({ key: `f0`, label: `opt${i}`, value: `${i}` }));
    const withOptions = { url: "https://x.test", formFound: true, fields: [
      { key: "g0", control: "radio_group", name: "g", id: null, autocomplete: null, label: null, required: false, options: manyOptions },
    ] };
    expect(sanitizeSnapshot(withOptions)!.fields[0].options).toHaveLength(200);
  });

  it("drops an option that is missing a string key/label/value", () => {
    const raw = { url: "https://x.test", formFound: true, fields: [
      { key: "g0", control: "radio_group", name: "g", id: null, autocomplete: null, label: null, required: false, options: [
        { key: "f1", label: "Yes", value: "1" },
        { key: "f2", label: null, value: "0" },
        { key: 7, label: "Bad key", value: "2" },
      ] },
    ] };
    expect(sanitizeSnapshot(raw)!.fields[0].options).toEqual([{ key: "f1", label: "Yes", value: "1" }]);
  });
});
