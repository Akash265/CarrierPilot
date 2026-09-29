import { describe, it, expect } from "vitest";
import { stableStringify, modelContentHash } from "./hash";
import type { DocumentModel } from "./types";

const model: DocumentModel = { title: "Jane", contactLine: "a@b.c", blocks: [{ type: "paragraph", text: "Hi" }] };

describe("stableStringify", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [3, 1], c: 2 } })).toBe('{"a":{"c":2,"d":[3,1]},"b":1}');
  });
});

describe("modelContentHash", () => {
  it("is stable for equal models regardless of key order", () => {
    const reordered = { blocks: model.blocks, contactLine: model.contactLine, title: model.title };
    expect(modelContentHash(reordered, "pdf")).toBe(modelContentHash(model, "pdf"));
  });

  it("differs by format and by content", () => {
    expect(modelContentHash(model, "pdf")).not.toBe(modelContentHash(model, "docx"));
    expect(modelContentHash({ ...model, title: "Janet" }, "pdf")).not.toBe(modelContentHash(model, "pdf"));
  });

  it("is a 64-char hex sha256", () => {
    expect(modelContentHash(model, "pdf")).toMatch(/^[0-9a-f]{64}$/);
  });
});
