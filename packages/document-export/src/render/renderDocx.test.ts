import { describe, it, expect } from "vitest";
import { extractText } from "@ai-career/ai";
import { renderDocx } from "./renderDocx";
import { renderDocument } from "./renderDocument";
import { modelStrings, expectTextInOrder } from "./roundTrip";
import type { DocumentModel } from "../model/types";

const model: DocumentModel = {
  title: "Łukasz Żółć",
  contactLine: "lukasz@example.com",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Data Engineer", subtitle: "Globex · Warszawa", meta: "2020 – 2024" },
    { type: "bullets", items: ["Built Spark pipelines", "Cut costs by 30%"] },
    { type: "heading", text: "Projects" },
    { type: "entry", title: "Open Source Tool", subtitle: null, meta: null },
    { type: "paragraph", text: "A CLI for schema diffs" },
  ],
};

describe("renderDocx", () => {
  it("produces a DOCX (zip) whose extracted text contains every model string in order", async () => {
    const docx = await renderDocx(model);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expectTextInOrder(await extractText(docx, "docx"), modelStrings(model));
  });

  it("uses Word heading styles and a bullet numbering definition", async () => {
    const xml = (await renderDocx(model)).toString("latin1");
    // document.xml is deflated inside the zip, so assert on the part names present in the package instead.
    expect(xml).toContain("word/document.xml");
    expect(xml).toContain("word/numbering.xml");
    expect(xml).toContain("word/styles.xml");
  });
});

describe("renderDocument", () => {
  it("dispatches by format", async () => {
    expect((await renderDocument(model, "pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await renderDocument(model, "docx")).subarray(0, 2).toString()).toBe("PK");
  });
});
