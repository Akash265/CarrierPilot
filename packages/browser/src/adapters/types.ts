import type { Canonical, Portal } from "../types";

/** A field matches when any listed pattern matches its id, name or label. */
export interface FieldMatcher {
  ids?: RegExp[];
  names?: RegExp[];
  labels?: RegExp[];
}

export interface StandardFieldRule {
  canonical: Canonical;
  match: FieldMatcher;
  /** When set, a matching field is never filled; this reason goes into the audit (e.g. "autocomplete_widget"). */
  flagReason?: string;
}

/** Selectors the in-page extractor uses (see snapshot/extractSnapshotSource.ts). */
export interface SnapshotConfig {
  formSelector: string;
  /** Closest ancestor that holds one question; its `questionLabel` element is the question text. */
  questionContainer: string;
  questionLabel: string;
}

export interface FormUrlInput {
  slug: string;
  externalId: string;
}

/** D4/D127: versioned per-ATS adapters. Everything portal-specific lives here; the rest of the pipeline is shared. */
export interface PortalAdapter {
  portal: Portal;
  version: string;
  allowedHosts: readonly string[];
  buildFormUrl(input: FormUrlInput): string;
  snapshotConfig: SnapshotConfig;
  /** Health check: each must be matched by exactly one field, or nothing is filled. */
  requiredCanonicals: readonly Canonical[];
  standardFields: readonly StandardFieldRule[];
  /** urlPatterns are tested against the URL pathname; textPatterns against visible page text. */
  confirmation: { urlPatterns: readonly RegExp[]; textPatterns: readonly RegExp[] };
}

/** Board slugs and posting ids are interpolated into URLs: only plain identifier characters are accepted. */
export const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]+$/;
