import type { DocumentFormat, DocumentModel } from "../model/types";
import { renderDocx } from "./renderDocx";
import { renderPdf } from "./renderPdf";

export function renderDocument(model: DocumentModel, format: DocumentFormat): Promise<Buffer> {
  return format === "pdf" ? renderPdf(model) : renderDocx(model);
}
