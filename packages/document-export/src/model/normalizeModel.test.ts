import { describe, it, expect } from "vitest";
import { normalizeModel } from "./normalizeModel";
import type { DocumentModel } from "./types";

describe("normalizeModel", () => {
  it("replaces vertical tab and form feed with a space in every string field", () => {
    const model: DocumentModel = {
      title: "Vertical\u000BTab",
      contactLine: "Form\u000CFeed",
      blocks: [
        { type: "heading", text: "Head\u000Bing" },
        { type: "entry", title: "Tit\u000Cle", subtitle: "Sub\u000B", meta: "Me\u000Cta" },
        { type: "paragraph", text: "Para\u000Bgraph" },
        { type: "bullets", items: ["Bul\u000Clet"] },
      ],
    };
    const result = normalizeModel(model);
    expect(result.title).toBe("Vertical Tab");
    expect(result.contactLine).toBe("Form Feed");
    expect(result.blocks[0]).toEqual({ type: "heading", text: "Head ing" });
    expect(result.blocks[1]).toEqual({ type: "entry", title: "Tit le", subtitle: "Sub ", meta: "Me ta" });
    expect(result.blocks[2]).toEqual({ type: "paragraph", text: "Para graph" });
    expect(result.blocks[3]).toEqual({ type: "bullets", items: ["Bul let"] });
  });

  it("removes other control characters and the U+FFFE/U+FFFF non-characters without inserting a space", () => {
    const model: DocumentModel = {
      title: "Ctrl\u0001One",
      contactLine: "Ctrl\u000ETwo",
      blocks: [{ type: "bullets", items: ["Del\u007FEnd", "NonChar￾A", "NonChar￿B"] }],
    };
    const result = normalizeModel(model);
    expect(result.title).toBe("CtrlOne");
    expect(result.contactLine).toBe("CtrlTwo");
    expect(result.blocks[0]).toEqual({ type: "bullets", items: ["DelEnd", "NonCharA", "NonCharB"] });
  });

  it("keeps tab, newline and carriage return (XML-legal) untouched", () => {
    const model: DocumentModel = { title: "A\tB\nC\rD", contactLine: null, blocks: [] };
    expect(normalizeModel(model).title).toBe("A\tB\nC\rD");
  });

  it("keeps null contactLine, subtitle and meta as null", () => {
    const model: DocumentModel = {
      title: "Clean",
      contactLine: null,
      blocks: [{ type: "entry", title: "T", subtitle: null, meta: null }],
    };
    const result = normalizeModel(model);
    expect(result.contactLine).toBeNull();
    expect(result.blocks[0]).toEqual({ type: "entry", title: "T", subtitle: null, meta: null });
  });

  it("leaves a clean model unchanged", () => {
    const model: DocumentModel = {
      title: "Jane",
      contactLine: "jane@example.com",
      blocks: [{ type: "bullets", items: ["ok", "still ok"] }],
    };
    expect(normalizeModel(model)).toEqual(model);
  });
});
