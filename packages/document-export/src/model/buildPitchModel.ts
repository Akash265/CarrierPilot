import type { StoredPitchBullet } from "@ai-career/application-package";
import type { DocumentBlock, DocumentModel } from "./types";
import { contactLine, type ResumeContact } from "./resumeProfile";

/**
 * One-page pitch (Phase 7b design §4.3): the name comes first (spec §4.3), then the contact line, then the
 * selected version's three bullet texts, no evidence or labels.
 *
 * `contactLine` on the model itself is left null: both renderers print `title` then `contactLine` before
 * `blocks` (D82's resume header order), which would put the contact line above the name here. The pitch's
 * `title` is the "Why I'm a fit..." heading, not the candidate's name, so the name and (if present) the
 * contact line are pushed as the first blocks instead.
 */
export function buildPitchModel(
  contact: ResumeContact,
  job: { title: string; companyName: string },
  bullets: StoredPitchBullet[]
): DocumentModel {
  const line = contactLine(contact);
  const blocks: DocumentBlock[] = [{ type: "paragraph", text: contact.fullName }];
  if (line !== null) blocks.push({ type: "paragraph", text: line });
  blocks.push({ type: "bullets", items: bullets.map((b) => b.text) });

  return {
    title: `Why I'm a fit for ${job.title} at ${job.companyName}`,
    contactLine: null,
    blocks,
  };
}
