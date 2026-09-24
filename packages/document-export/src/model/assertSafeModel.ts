import { hasUnsafeText } from "@ai-career/ingestion/text";
import { DocumentExportError } from "../errors";
import type { DocumentModel } from "./types";

/** D44 choke point for documents: one recursive check over every string in the model. */
export function assertSafeModel(model: DocumentModel): void {
  if (hasUnsafeText(model)) throw new DocumentExportError("invalid_content");
}
