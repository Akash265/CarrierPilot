import type { StoredCoverLetterParagraph } from "@ai-career/application-package";
import type { DocumentBlock, DocumentModel } from "./types";
import { contactLine, type ResumeContact } from "./resumeProfile";

/**
 * Phase 7c design §6. Same header approach as buildPitchModel (name and contact line as the first
 * blocks, model.contactLine null). The salutation and sign-off are added here, never by the model.
 * Evidence is not rendered.
 */
export function buildCoverLetterModel(
  contact: ResumeContact,
  job: { title: string; companyName: string },
  paragraphs: StoredCoverLetterParagraph[]
): DocumentModel {
  const line = contactLine(contact);
  const blocks: DocumentBlock[] = [{ type: "paragraph", text: contact.fullName }];
  if (line !== null) blocks.push({ type: "paragraph", text: line });
  blocks.push({ type: "paragraph", text: "Dear Hiring Manager," });
  for (const p of paragraphs) blocks.push({ type: "paragraph", text: p.text });
  blocks.push({ type: "paragraph", text: "Sincerely," }, { type: "paragraph", text: contact.fullName });
  return { title: `Application for ${job.title} at ${job.companyName}`, contactLine: null, blocks };
}
