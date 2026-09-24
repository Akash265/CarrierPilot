import { describe, it, expect } from "vitest";
import { assertSafeModel } from "./assertSafeModel";
import { DocumentExportError } from "../errors";

describe("assertSafeModel", () => {
  it("accepts a clean model", () => {
    expect(() => assertSafeModel({ title: "Jane", contactLine: null, blocks: [{ type: "bullets", items: ["ok"] }] })).not.toThrow();
  });

  it.each([
    ["title", { title: "Ja\u0000ne", contactLine: null, blocks: [] }],
    ["contact line", { title: "Jane", contactLine: "\uD800", blocks: [] }],
    ["a bullet", { title: "Jane", contactLine: null, blocks: [{ type: "bullets", items: ["ok", "bad\u0000"] }] }],
  ])("rejects unsafe text in %s with invalid_content", (_label, model) => {
    expect(() => assertSafeModel(model as never)).toThrow(DocumentExportError);
    try {
      assertSafeModel(model as never);
    } catch (error) {
      expect((error as DocumentExportError).errorClass).toBe("invalid_content");
    }
  });
});
