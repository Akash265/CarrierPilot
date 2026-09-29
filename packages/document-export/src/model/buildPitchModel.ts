import type { StoredPitchBullet } from "@ai-career/application-package";
import type { DocumentModel } from "./types";
import { contactLine, type ResumeContact } from "./resumeProfile";

/** One-page pitch (Phase 7b design §4.3): the selected version's three bullet texts, no evidence or labels. */
export function buildPitchModel(
  contact: ResumeContact,
  job: { title: string; companyName: string },
  bullets: StoredPitchBullet[]
): DocumentModel {
  return {
    title: `Why I'm a fit for ${job.title} at ${job.companyName}`,
    contactLine: contactLine(contact),
    blocks: [
      { type: "paragraph", text: contact.fullName },
      { type: "bullets", items: bullets.map((b) => b.text) },
    ],
  };
}
