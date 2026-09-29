import type { DocumentBlock, DocumentModel } from "./types";

// \u000B (vertical tab) and \u000C (form feed) are not legal in XML 1.0 at all, so `docx`'s XML writer
// emits them raw and Word then reports the whole package as unreadable; \u000B is also literally Word's
// own "soft line break" character, so it is easy to paste into a user-edited pitch bullet. Map both to a
// space (they are line-break-like) rather than deleting them, so words on either side do not run together.
const LINE_BREAK_LIKE_RE = /[\u000B\u000C]/g;

// The rest of the C0 controls (except \t \n \r, which XML 1.0 allows), DEL, and the two Unicode
// non-characters U+FFFE/U+FFFF: none of these have a legitimate reason to appear in resume/pitch text, and
// none of them is line-break-like, so they are removed outright rather than replaced with a space.
const STRIP_RE = /[\u0001-\u0008\u000E-\u001F\u007F￾￿]/g;

function normalizeString(value: string): string {
  return value.replace(LINE_BREAK_LIKE_RE, " ").replace(STRIP_RE, "");
}

function normalizeNullableString(value: string | null): string | null {
  return value === null ? null : normalizeString(value);
}

function normalizeBlock(block: DocumentBlock): DocumentBlock {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return { ...block, text: normalizeString(block.text) };
    case "entry":
      return { ...block, title: normalizeString(block.title), subtitle: normalizeNullableString(block.subtitle), meta: normalizeNullableString(block.meta) };
    case "bullets":
      return { ...block, items: block.items.map(normalizeString) };
  }
}

/**
 * Maps every string in a `DocumentModel` (D86) to remove or replace XML-illegal / Word-hostile control
 * characters -- `hasUnsafeText` (assertSafeModel) only rejects NUL and unpaired surrogates, which is not
 * enough: `\u000B`/`\u000C` are not legal XML 1.0 characters at all, so `docx`'s writer emits them
 * unescaped into word/document.xml and Word then refuses to open the file. Must run before assertSafeModel
 * and before hashing (storeDocument), so the hash and the rendered file are always for the cleaned text --
 * otherwise a broken document is exactly the one a stable content hash keeps reusing forever.
 */
export function normalizeModel(model: DocumentModel): DocumentModel {
  return { title: normalizeString(model.title), contactLine: normalizeNullableString(model.contactLine), blocks: model.blocks.map(normalizeBlock) };
}
