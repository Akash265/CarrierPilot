import type { StoredInterviewPrepSections } from "@ai-career/application-package";
import type { DocumentBlock, DocumentModel } from "./types";

const CATEGORY_LABELS = { technical: "Technical", behavioral: "Behavioral", role: "Role" } as const;
const mark = (text: string, supported: boolean) => (supported ? text : `${text} (unverified)`);

/**
 * Phase 7c design §6. The pack is for the candidate, not an employer, so unsupported items are exported
 * but marked "(unverified)" instead of blocking the export (unlike the pitch/cover letter, D84).
 */
export function buildInterviewPrepModel(
  job: { title: string; companyName: string },
  sections: StoredInterviewPrepSections,
  gapTerms: string[]
): DocumentModel {
  const blocks: DocumentBlock[] = [{ type: "heading", text: "Likely questions" }];
  for (const q of sections.likelyQuestions) {
    blocks.push({ type: "entry", title: mark(q.question, q.supported), subtitle: CATEGORY_LABELS[q.category], meta: null });
    blocks.push({ type: "bullets", items: q.answerOutline });
  }

  blocks.push({ type: "heading", text: "Required skills not found in your profile" });
  blocks.push({ type: "paragraph", text: gapTerms.length > 0 ? gapTerms.join(", ") : "None: every required term appears in your profile." });
  for (const q of sections.gapQuestions) {
    // An unsupported gap question's term may not be a missing term at all (the guard's first gap rule).
    blocks.push({ type: "entry", title: mark(q.question, q.supported), subtitle: q.supported ? `Missing: ${q.requirementTerm}` : null, meta: null });
    blocks.push({ type: "paragraph", text: q.framing });
  }

  blocks.push({ type: "heading", text: "Company talking points" });
  blocks.push({ type: "bullets", items: sections.talkingPoints.map((p) => mark(p.text, p.supported)) });
  blocks.push({ type: "heading", text: "Questions to ask" });
  blocks.push({ type: "bullets", items: sections.questionsToAsk.map((q) => mark(q.question, q.supported)) });

  return { title: `Interview preparation: ${job.title} at ${job.companyName}`, contactLine: null, blocks };
}
