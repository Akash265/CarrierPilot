import { describe, it, expect } from "vitest";
import { extractText } from "@ai-career/ai";
import { renderPdf } from "./renderPdf";
import { modelStrings, expectTextInOrder } from "./roundTrip";
import { normalizeModel } from "../model/normalizeModel";
import type { DocumentModel } from "../model/types";

const model: DocumentModel = {
  title: "José Núñez",
  contactLine: "jose@example.com · +34 600 000 000",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Senior Engineer", subtitle: "Łódź Systems · Kraków", meta: "2021 – present" },
    { type: "bullets", items: ["Built a Rust ingestion service processing 2 TB per day", "Led migration to PostgreSQL 16"] },
    { type: "heading", text: "Skills" },
    { type: "paragraph", text: "Rust, PostgreSQL, Kubernetes" },
  ],
};

describe("renderPdf", () => {
  it("produces a PDF whose extracted text contains every model string in order, including non-ASCII names", async () => {
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expectTextInOrder(await extractText(pdf, "pdf"), modelStrings(model));
  });

  it("paginates a long resume and keeps all text extractable", async () => {
    const long: DocumentModel = {
      title: "Long Resume",
      contactLine: null,
      blocks: Array.from({ length: 12 }, (_, i) => [
        { type: "entry" as const, title: `Role ${i}`, subtitle: `Company ${i}`, meta: null },
        { type: "bullets" as const, items: Array.from({ length: 8 }, (__, j) => `Achievement ${i}-${j} with a sentence long enough to wrap onto a second line of the page`) },
      ]).flat(),
    };
    const pdf = await renderPdf(long);
    const pages = (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(3);
    expectTextInOrder(await extractText(pdf, "pdf"), modelStrings(long));
  });

  it("renders an empty model (title only)", async () => {
    const pdf = await renderPdf({ title: "Only Title", contactLine: null, blocks: [] });
    expectTextInOrder(await extractText(pdf, "pdf"), ["Only Title"]);
  });

  it("round-trips a model with control characters once normalized (fix wave item A): renders and extracts without throwing", async () => {
    const dirty: DocumentModel = {
      title: "Vertical\u000BTab",
      contactLine: "Form\u000CFeed NonChar￾End",
      blocks: [{ type: "bullets", items: ["Ctrl\u0001One", "Pasted\u000Bline\u000Cbreak"] }],
    };
    const pdf = await renderPdf(normalizeModel(dirty));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = await extractText(pdf, "pdf");
    expectTextInOrder(text, modelStrings(normalizeModel(dirty)));
    expect(text).not.toMatch(/[\u000B\u000C\u0001￾]/);
  });
});
