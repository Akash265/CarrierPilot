import { expect } from "vitest";
import type { DocumentModel } from "../model/types";

/** Every visible string of a model, in reading order. */
export function modelStrings(model: DocumentModel): string[] {
  const out = [model.title];
  if (model.contactLine) out.push(model.contactLine);
  for (const block of model.blocks) {
    if (block.type === "heading" || block.type === "paragraph") out.push(block.text);
    else if (block.type === "entry") {
      out.push(block.title);
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) out.push(sub);
    } else out.push(...block.items);
  }
  return out;
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Asserts each expected string occurs in the extracted text, each after the previous one (whitespace-insensitive). */
export function expectTextInOrder(text: string, expected: string[]): void {
  const haystack = normalize(text);
  let from = 0;
  for (const s of expected) {
    const at = haystack.indexOf(normalize(s), from);
    expect(at, `"${s}" not found in order`).toBeGreaterThanOrEqual(0);
    from = at + normalize(s).length;
  }
}
