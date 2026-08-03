// A structured, deterministically-extracted profile of high-confidence facts
// from the user's uploaded documents. Built WITHOUT any LLM call, persisted,
// and user-editable — so a mis-parsed value is fixed once, permanently.

export type ProfileFieldKind =
  | "email"
  | "phone"
  | "name"
  | "address"
  | "dob"
  | "id"
  | "url"
  | "language"
  | "education"
  | "job_title"
  | "employer"
  | "nationality"
  | "gender"
  | "country"
  | "city"
  | "state"
  | "postal_code"
  | "years_experience"
  | "department"
  | "year_standing"
  | "skills"
  | "passport"
  | "place_of_birth"
  | "preferred_name"
  | "graduation"
  | "degree"
  | "other";

export interface ProfileFact {
  id: string;
  field: ProfileFieldKind;
  // Human label shown in the options editor, e.g. "Email", "LinkedIn".
  label: string;
  value: string;
  // Document filename the fact came from, or "manual" when user-added/edited.
  source: string;
  confidence: "high" | "medium" | "low";
  // Which precedence rule produced this value (FIX 1.4) — surfaced in the
  // Options editor so a wrong extraction is traceable to how it was derived.
  rule?: ExtractionRule;
  // How many separate uploaded documents corroborate this value.
  corroboration?: number;
}

// Precedence, highest first. A lower-precedence guess must never override a
// higher-precedence match (FIX 1.1).
export type ExtractionRule = "labelled" | "typed" | "contextual" | "positional";

export const RULE_RANK: Record<ExtractionRule, number> = {
  labelled: 4,
  typed: 3,
  contextual: 2,
  positional: 1,
};

// Bumped whenever extraction/scoring logic changes in a way that would produce
// a different profile from the same documents. A stored profile carrying an
// older version is discarded and re-derived rather than silently reused — the
// "engineering as a name" bug survived a fix precisely because the cached
// profile outlived the code that produced it (FIX C).
export const PROFILE_PIPELINE_VERSION = 3;

export interface StructuredProfile {
  // Identifies the document set this profile was derived from, so a changed
  // upload set gets a fresh extraction while an unchanged one reuses (and
  // preserves) the user's manual edits. Includes content fingerprints, so
  // re-uploading a DIFFERENT file under the same name still re-derives.
  documentSetKey: string;
  // Extractor version that produced these facts; see PROFILE_PIPELINE_VERSION.
  pipelineVersion?: number;
  facts: ProfileFact[];
  updatedAt: number;
}

// Compact one-line-per-fact rendering passed to Gemini as context so the
// model never has to re-derive contact details from raw document text.
export function profileToPromptContext(profile: StructuredProfile | null): string {
  if (!profile || profile.facts.length === 0) {
    return "(no structured profile extracted)";
  }
  return profile.facts.map((fact) => `- ${fact.label}: ${fact.value}`).join("\n");
}
