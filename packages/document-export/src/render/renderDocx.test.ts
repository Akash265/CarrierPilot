import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { extractText } from "@ai-career/ai";
import { renderDocx } from "./renderDocx";
import { renderDocument } from "./renderDocument";
import { modelStrings, expectTextInOrder } from "./roundTrip";
import { normalizeModel } from "../model/normalizeModel";
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

/** Extracts `word/document.xml` from a rendered DOCX buffer, as a string. */
async function documentXml(docx: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const part = zip.file("word/document.xml");
  if (!part) throw new Error("word/document.xml missing from package");
  return part.async("string");
}

/** Returns the `<w:p>...</w:p>` paragraph element containing the given text run, or undefined. */
function paragraphContaining(xml: string, text: string): string | undefined {
  const paragraphs = xml.match(/<w:p\b.*?<\/w:p>/gs) ?? [];
  return paragraphs.find((p) => p.includes(`>${text}<`));
}

describe("renderDocx", () => {
  it("produces a DOCX (zip) whose extracted text contains every model string in order", async () => {
    const docx = await renderDocx(model);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    expectTextInOrder(await extractText(docx, "docx"), modelStrings(model));
  });

  it("uses real Word heading styles and a bullet numbering definition on the actual paragraphs", async () => {
    const xml = await documentXml(await renderDocx(model));

    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');

    const bulletParagraph = paragraphContaining(xml, "Built Spark pipelines");
    expect(bulletParagraph, "bullet item paragraph not found").toBeDefined();
    expect(bulletParagraph).toContain("<w:numPr>");
  });

  it("does not emit heading styles or numbering when the model has none (discriminates the styling test)", async () => {
    const plain: DocumentModel = {
      title: "Plain Title",
      contactLine: null,
      blocks: [{ type: "paragraph", text: "Just a paragraph, nothing else." }],
    };
    const xml = await documentXml(await renderDocx(plain));

    expect(xml).not.toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).not.toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).not.toContain("<w:numPr>");
  });
});

describe("renderDocx with normalizeModel (fix wave item A)", () => {
  it("produces a document.xml free of the control characters a reviewer's probe found (\\u000B \\u000C \\u0001 U+FFFE)", async () => {
    const dirty: DocumentModel = {
      title: "Vertical\u000BTab Ctrl\u0001One",
      contactLine: "Form\u000CFeed NonChar￾End",
      blocks: [{ type: "bullets", items: ["Pasted\u000Bline\u000Cbreak"] }],
    };
    const xml = await documentXml(await renderDocx(normalizeModel(dirty)));
    expect(xml).not.toMatch(/[\u000B\u000C\u0001￾]/);
    // and the surrounding text survived (space-joined, not silently dropped)
    expect(xml).toContain("Vertical Tab CtrlOne");
  });
});

describe("renderDocument", () => {
  it("dispatches by format", async () => {
    expect((await renderDocument(model, "pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await renderDocument(model, "docx")).subarray(0, 2).toString()).toBe("PK");
  });
});
