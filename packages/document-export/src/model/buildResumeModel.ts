import type { AppliedBullet } from "@ai-career/resume-optimization";
import type { DocumentBlock, DocumentModel } from "./types";
import { contactLine, dateRange, type ResumeProfile } from "./resumeProfile";

/** Items the optimizer selected (in its order) with its text, then the rest (in profile order) with their own text. */
function selectedFirst<T extends { id: string }>(
  items: T[],
  applied: AppliedBullet[],
  sourceType: AppliedBullet["sourceType"],
  originalText: (item: T) => string
): { item: T; text: string }[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const chosen: { item: T; text: string }[] = [];
  const used = new Set<string>();
  for (const a of applied) {
    if (a.sourceType !== sourceType) continue;
    const item = byId.get(a.sourceFactId);
    if (!item) continue; // belongs to another group (e.g. a different role) -- the caller checks global existence
    chosen.push({ item, text: a.optimizedText });
    used.add(item.id);
  }
  for (const item of items) if (!used.has(item.id)) chosen.push({ item, text: originalText(item) });
  return chosen;
}

/**
 * The resume document (Phase 7b design §4.2, D82): the full profile, with the optimizer's guard-applied
 * rewordings replacing their originals and ordered first. Education, certifications and skill names are
 * never reworded. rejectedClaims are never an input. No street address.
 */
export function buildResumeModel(profile: ResumeProfile, applied: AppliedBullet[]): DocumentModel {
  const knownIds = new Set<string>([
    ...profile.experiences.flatMap((e) => e.bullets.map((b) => b.id)),
    ...profile.achievements.map((a) => a.id),
    ...profile.projects.map((p) => p.id),
    ...profile.certifications.map((c) => c.id),
    ...profile.education.map((e) => e.id),
    ...profile.skills.map((s) => s.id),
  ]);
  for (const a of applied) {
    if (!knownIds.has(a.sourceFactId)) throw new Error(`applied bullet cites unknown source fact ${a.sourceFactId}`);
  }

  const blocks: DocumentBlock[] = [];

  if (profile.experiences.length > 0) {
    blocks.push({ type: "heading", text: "Experience" });
    for (const exp of profile.experiences) {
      blocks.push({
        type: "entry",
        title: exp.title,
        subtitle: [exp.company, exp.location].filter((s): s is string => !!s && s.trim().length > 0).join(" · "),
        meta: dateRange(exp.startDate, exp.endDate),
      });
      const bullets = selectedFirst(exp.bullets, applied, "work_experience_bullet", (b) => b.text);
      if (bullets.length > 0) blocks.push({ type: "bullets", items: bullets.map((b) => b.text) });
    }
  }

  if (profile.projects.length > 0) {
    blocks.push({ type: "heading", text: "Projects" });
    for (const { item, text } of selectedFirst(profile.projects, applied, "project", (p) => p.description)) {
      blocks.push({ type: "entry", title: item.name, subtitle: item.url, meta: null });
      blocks.push({ type: "paragraph", text });
    }
  }

  if (profile.achievements.length > 0) {
    blocks.push({ type: "heading", text: "Achievements" });
    blocks.push({ type: "bullets", items: selectedFirst(profile.achievements, applied, "achievement", (a) => a.description).map((a) => a.text) });
  }

  if (profile.education.length > 0) {
    blocks.push({ type: "heading", text: "Education" });
    for (const e of profile.education) {
      blocks.push({
        type: "entry",
        title: e.fieldOfStudy ? `${e.degree} in ${e.fieldOfStudy}` : e.degree,
        subtitle: e.gpa ? `${e.institution} · GPA ${e.gpa}` : e.institution,
        meta: dateRange(e.startDate, e.endDate),
      });
    }
  }

  if (profile.certifications.length > 0) {
    blocks.push({ type: "heading", text: "Certifications" });
    for (const c of profile.certifications) {
      blocks.push({
        type: "entry",
        title: c.name,
        subtitle: c.issuer,
        meta: c.issueDate && c.expiryDate ? `${c.issueDate} – ${c.expiryDate}` : c.issueDate ?? (c.expiryDate ? `Expires ${c.expiryDate}` : null),
      });
    }
  }

  if (profile.skills.length > 0) {
    blocks.push({ type: "heading", text: "Skills" });
    // Profile names only: the order follows the optimizer's selection, the text never does.
    const ordered = selectedFirst(profile.skills, applied, "skill", (s) => s.name).map(({ item }) => item.name);
    blocks.push({ type: "paragraph", text: ordered.join(", ") });
  }

  return { title: profile.contact.fullName, contactLine: contactLine(profile.contact), blocks };
}
